import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, Dialog, Page, Request, Response, WebSocket } from 'playwright';
import { launchBrowser } from './browser.ts';
import type { Config } from './config.ts';

const CONSOLE_BUFFER_MAX = 500;
const NETWORK_BUFFER_MAX = 300;
/**
 * Per-socket frame ring. A chatty socket would otherwise evict every HTTP
 * request from the shared network buffer within seconds.
 */
const WS_FRAME_BUFFER_MAX = 100;
/** Frames are held in memory for the session's life, so each one is capped. */
const WS_FRAME_MAX_BYTES = 4 * 1024;
/** Bodies at or below this size are cached eagerly so they survive navigation. */
const BODY_CACHE_MAX_BYTES = 256 * 1024;

export interface ConsoleEntry {
  /** Monotonic, so cursors and marks survive ring-buffer eviction. */
  seq: number;
  ts: number;
  level: string;
  text: string;
  location?: string;
}

export interface WsFrame {
  ts: number;
  dir: 'sent' | 'received';
  /** Binary frames arrive as Buffer; only their size is recorded. */
  text?: string;
  bytes?: number;
  truncated?: boolean;
}

export interface WsRecord {
  state: 'open' | 'closed' | 'error';
  openedAt: number;
  closedAt?: number;
  frames: WsFrame[];
  sent: number;
  received: number;
  /** Frames evicted by the ring, so the log can say so rather than lie. */
  dropped: number;
}

export interface NetworkEntry {
  id: number;
  ts: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  failure?: string;
  durationMs?: number;
  sizeBytes?: number;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  /** Populated eagerly for small text responses; response.body() dies on navigation. */
  cachedBody?: string;
  bodyNote?: string;
  /** Absent for WebSockets: they are observed via the websocket event, which
   *  carries no Request object. */
  request?: Request;
  response?: Response;
  /** Present only when resourceType is "websocket". */
  ws?: WsRecord;
}

export interface DialogRecord {
  seq: number;
  text: string;
  /** "open" until answered, then how it was answered. */
  how: string;
}

export interface PendingDialog {
  type: string;
  message: string;
  defaultValue: string;
  dialog: Dialog;
  timer: NodeJS.Timeout;
  record: DialogRecord;
}

export interface SessionOptions {
  userAgent: string;
  viewport: { width: number; height: number };
  headless: boolean;
  baseUrl?: string;
  model?: string;
}

const TEXTY_CONTENT_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.*\+json)/i;

export class Session {
  readonly id: string;
  readonly options: SessionOptions;
  readonly createdAt = Date.now();
  lastUsedAt = Date.now();

  readonly console: ConsoleEntry[] = [];
  readonly network: NetworkEntry[] = [];
  /**
   * Newest entry each `sinceLastCall` read has consumed, tracked per level
   * filter: one shared cursor would let an error read swallow an older unread
   * warning, since the filters see different subsets of the same buffer.
   */
  readonly consoleReadSeq = new Map<string, number>();
  pendingDialog?: PendingDialog;
  /** Set when a popup replaces the active page, so the next tool result can say so. */
  pendingNotice?: string;
  /** How the most recent dialog was answered, so an action can explain itself. */
  lastAnsweredDialog?: { text: string; how: string; at: number };
  /** Pre-armed answer for the next dialog, set by browser_handle_dialog. */
  dialogPolicy?: { accept: boolean; promptText?: string };
  /** Per-dialog outcomes, so an action with several reports each correctly. */
  readonly dialogLog: DialogRecord[] = [];
  /** How long an unanswered dialog is held; set from the action timeout. */
  dialogHoldMs = 3_000;

  /**
   * Monotonic counters, never reset by ring-buffer eviction. Array indices
   * would silently under-report activity once a buffer wraps.
   */
  private consoleSeq = 0;
  private nextRequestId = 1;
  private readonly attached = new WeakSet<Page>();
  private readonly requestStarts = new WeakMap<Request, number>();

  readonly context: BrowserContext;
  private activePage: Page;

  constructor(id: string, options: SessionOptions, context: BrowserContext, activePage: Page) {
    this.id = id;
    this.options = options;
    this.context = context;
    this.activePage = activePage;
    this.attach(activePage);
    context.on('page', (page) => {
      this.activePage = page;
      this.attach(page);
      this.pendingNotice = `A new page/popup opened and is now the active page: ${page.url()}`;
    });
  }

  get page(): Page {
    const alive = this.livePage();
    if (alive) return alive;
    throw new Error(
      `Session ${this.id} has no open page left. Call browser_navigate to open a new one, ` +
        'or browser_close to discard the session.',
    );
  }

  /** The active page, or another live one if it closed. Never throws. */
  livePage(): Page | undefined {
    const current = this.activePage;
    if (current && !current.isClosed()) return current;
    // A popup dismissed itself, or script closed the page.
    const alive = this.context.pages().find((page) => !page.isClosed());
    if (alive && alive !== current) {
      this.activePage = alive;
      this.pendingNotice = `The previous page closed; now active: ${alive.url()}`;
    }
    return alive;
  }

  /** Reopens a page after all of them closed, so the session can recover. */
  async ensurePage(): Promise<Page> {
    const alive = this.livePage();
    if (alive) return alive;
    const page = await this.context.newPage();
    this.activePage = page;
    this.attach(page);
    this.pendingNotice = undefined;
    return page;
  }

  touch(): void {
    this.lastUsedAt = Date.now();
  }

  get idleMs(): number {
    return Date.now() - this.lastUsedAt;
  }

  /** Returns and clears the one-shot notice (popup adoption, etc.). */
  takeNotice(): string | undefined {
    const notice = this.pendingNotice;
    this.pendingNotice = undefined;
    return notice;
  }

  /** Marks for measuring what an action caused; survives buffer eviction. */
  marks(): { console: number; network: number } {
    return { console: this.consoleSeq, network: this.nextRequestId };
  }

  countConsoleErrorsSince(seq: number): number {
    return this.console.filter(
      (entry) =>
        entry.seq > seq && (entry.level === 'error' || entry.level === 'pageerror'),
    ).length;
  }

  requestsSince(seq: number): NetworkEntry[] {
    return this.network.filter((entry) => entry.id >= seq);
  }

  findRequest(id: number): NetworkEntry | undefined {
    return this.network.find((entry) => entry.id === id);
  }

  resolveUrl(url: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    if (this.options.baseUrl) return new URL(url, this.options.baseUrl).toString();
    if (url.startsWith('/')) {
      const current = this.activePage.url();
      if (current && current !== 'about:blank') return new URL(url, current).toString();
    }
    return url;
  }

  private attachWebSocket(socket: WebSocket): void {
    const record: WsRecord = {
      state: 'open',
      openedAt: Date.now(),
      frames: [],
      sent: 0,
      received: 0,
      dropped: 0,
    };
    const entry: NetworkEntry = {
      id: this.nextRequestId++,
      ts: record.openedAt,
      method: 'GET',
      // The handshake response is not exposed by Playwright, but a socket that
      // reaches this event has completed it; 101 is the only status it can be.
      status: 101,
      statusText: 'Switching Protocols',
      url: socket.url(),
      resourceType: 'websocket',
      requestHeaders: {},
      ws: record,
    };
    this.pushNetwork(entry);

    const pushFrame = (dir: 'sent' | 'received', payload: string | Buffer) => {
      if (dir === 'sent') record.sent++;
      else record.received++;
      const frame: WsFrame = { ts: Date.now(), dir };
      if (typeof payload === 'string') {
        frame.bytes = Buffer.byteLength(payload);
        frame.text = payload.slice(0, WS_FRAME_MAX_BYTES);
        if (frame.text.length < payload.length) frame.truncated = true;
      } else {
        frame.bytes = payload.length;
      }
      record.frames.push(frame);
      if (record.frames.length > WS_FRAME_BUFFER_MAX) {
        record.dropped += record.frames.length - WS_FRAME_BUFFER_MAX;
        record.frames.splice(0, record.frames.length - WS_FRAME_BUFFER_MAX);
      }
    };

    socket.on('framesent', (frame) => pushFrame('sent', frame.payload));
    socket.on('framereceived', (frame) => pushFrame('received', frame.payload));
    socket.on('socketerror', (error) => {
      record.state = 'error';
      record.closedAt = Date.now();
      entry.failure = error;
      // A socket that errored never completed its handshake, so the optimistic
      // 101 above would be a lie.
      entry.status = undefined;
      entry.statusText = undefined;
      entry.durationMs = record.closedAt - record.openedAt;
    });
    socket.on('close', () => {
      if (record.state === 'error') return;
      record.state = 'closed';
      record.closedAt = Date.now();
      entry.durationMs = record.closedAt - record.openedAt;
    });
  }

  /** Appends to the network ring, evicting oldest entries past the cap. */
  private pushNetwork(entry: NetworkEntry): void {
    this.network.push(entry);
    if (this.network.length > NETWORK_BUFFER_MAX) {
      this.network.splice(0, this.network.length - NETWORK_BUFFER_MAX);
    }
  }

  private pushConsole(entry: Omit<ConsoleEntry, 'seq'>): number {
    const seq = ++this.consoleSeq;
    this.console.push({ ...entry, seq });
    if (this.console.length > CONSOLE_BUFFER_MAX) {
      this.console.splice(0, this.console.length - CONSOLE_BUFFER_MAX);
    }
    return seq;
  }

  private attach(page: Page): void {
    // The context's 'page' event already attaches new pages; guard so a second
    // path (ensurePage) cannot double-register every listener, which would
    // duplicate buffer entries and make two handlers race for one dialog.
    if (this.attached.has(page)) return;
    this.attached.add(page);

    page.on('console', (message) => {
      const location = message.location();
      this.pushConsole({
        ts: Date.now(),
        level: message.type(),
        text: message.text(),
        location: location.url
          ? `${location.url}:${location.lineNumber}:${location.columnNumber}`
          : undefined,
      });
    });

    page.on('pageerror', (error) => {
      this.pushConsole({
        ts: Date.now(),
        level: 'pageerror',
        text: error.stack || `${error.name}: ${error.message}`,
      });
    });

    page.on('request', (request) => {
      this.requestStarts.set(request, Date.now());
      const entry: NetworkEntry = {
        id: this.nextRequestId++,
        ts: Date.now(),
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        requestHeaders: {},
        postData: request.postData() ?? undefined,
        request,
      };
      request
        .allHeaders()
        .then((headers) => {
          entry.requestHeaders = headers;
        })
        .catch(() => {});
      this.pushNetwork(entry);
    });

    page.on('response', (response) => {
      const entry = this.network.find((candidate) => candidate.request === response.request());
      if (!entry) return;
      entry.status = response.status();
      entry.statusText = response.statusText();
      entry.response = response;
      const started = this.requestStarts.get(response.request());
      if (started !== undefined) entry.durationMs = Date.now() - started;
      response
        .allHeaders()
        .then((headers) => {
          entry.responseHeaders = headers;
          void this.cacheBody(entry, headers);
        })
        .catch(() => {});
    });

    page.on('requestfailed', (request) => {
      const entry = this.network.find((candidate) => candidate.request === request);
      if (!entry) return;
      entry.failure = request.failure()?.errorText ?? 'failed';
      const started = this.requestStarts.get(request);
      if (started !== undefined) entry.durationMs = Date.now() - started;
    });

    // WebSockets never surface as request/response/requestfailed events, so
    // without this the entire data flow of a socket-driven app is invisible
    // to browser_network — which reads as "WebSockets do not work".
    page.on('websocket', (socket) => {
      this.attachWebSocket(socket);
    });

    page.on('dialog', (dialog) => {
      const label = `${dialog.type()}: ${dialog.message()}`;
      const seq = this.pushConsole({ ts: Date.now(), level: 'dialog', text: label });
      const record = { seq, text: label, how: 'open' };
      this.dialogLog.push(record);
      if (this.dialogLog.length > 50) this.dialogLog.splice(0, this.dialogLog.length - 50);

      // A beforeunload prompt only appears because a navigation was requested,
      // and dismissing it means "stay here" — which would cancel that
      // navigation and make any page with an unsaved-changes guard unreachable.
      if (dialog.type() === 'beforeunload') {
        record.how = 'accepted (beforeunload)';
        this.lastAnsweredDialog = { text: label, how: record.how, at: Date.now() };
        dialog.accept().catch(() => {});
        return;
      }

      // A dialog blocks the page until answered, so the action that opened it
      // cannot also answer it. A policy armed beforehand is the only way to
      // accept one, or to supply prompt() text.
      const policy = this.dialogPolicy;
      if (policy) {
        this.dialogPolicy = undefined;
        record.how = policy.accept ? 'accepted' : 'dismissed';
        this.lastAnsweredDialog = { text: label, how: record.how, at: Date.now() };
        const answer = policy.accept ? dialog.accept(policy.promptText) : dialog.dismiss();
        answer.catch(() => {});
        return;
      }
      // A dialog blocks the page's JS until it is answered, so a previous one
      // must be dismissed rather than dropped — otherwise the page hangs and
      // the dialog is no longer reachable through browser_handle_dialog.
      const superseded = this.pendingDialog;
      if (superseded) {
        clearTimeout(superseded.timer);
        superseded.dialog.dismiss().catch(() => {});
      }
      // Held briefly so browser_handle_dialog can answer it, but always for
      // less than an action timeout: the click that opened the dialog is
      // blocked until it is answered, and must not be the thing that fails.
      const timer = setTimeout(() => {
        if (this.pendingDialog?.dialog === dialog) {
          this.pendingDialog = undefined;
          record.how = 'auto-dismissed';
          this.lastAnsweredDialog = { text: label, how: record.how, at: Date.now() };
          dialog.dismiss().catch(() => {});
        }
      }, this.dialogHoldMs);
      timer.unref?.();
      this.pendingDialog = {
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
        dialog,
        timer,
        record,
      };
    });
  }

  private async cacheBody(entry: NetworkEntry, headers: Record<string, string>): Promise<void> {
    const contentType = headers['content-type'] ?? '';
    if (!TEXTY_CONTENT_TYPE.test(contentType)) return;

    const declaredLength = Number(headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > BODY_CACHE_MAX_BYTES) {
      entry.bodyNote = `body not cached (${declaredLength} bytes exceeds cache limit)`;
      return;
    }

    try {
      const buffer = await entry.response!.body();
      entry.sizeBytes = buffer.byteLength;
      if (buffer.byteLength <= BODY_CACHE_MAX_BYTES) {
        entry.cachedBody = buffer.toString('utf8');
      } else {
        entry.bodyNote = `body not cached (${buffer.byteLength} bytes exceeds cache limit)`;
      }
    } catch (error) {
      entry.bodyNote = `body unavailable: ${(error as Error).message}`;
    }
  }

  async close(): Promise<void> {
    if (this.pendingDialog) {
      clearTimeout(this.pendingDialog.timer);
      await this.pendingDialog.dialog.dismiss().catch(() => {});
      this.pendingDialog = undefined;
    }
    await this.context.close().catch(() => {});
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /** One browser per headless mode; contexts give sessions their isolation. */
  private readonly browsers = new Map<boolean, Promise<Browser>>();
  private reaper?: NodeJS.Timeout;

  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private browser(headless: boolean): Promise<Browser> {
    const existing = this.browsers.get(headless);
    if (existing) return existing;

    const pending = launchBrowser(headless, this.config.executablePath);
    this.browsers.set(headless, pending);
    // Neither a failed launch nor a later crash may poison the slot: without
    // this, one Chromium crash breaks every subsequent browser_start.
    const forget = () => {
      if (this.browsers.get(headless) === pending) this.browsers.delete(headless);
    };
    pending.then(
      (browser) => browser.on('disconnected', forget),
      forget,
    );
    return pending;
  }

  async create(options: SessionOptions): Promise<Session> {
    const browser = await this.browser(options.headless);
    const context = await browser.newContext({
      userAgent: options.userAgent,
      viewport: options.viewport,
      baseURL: options.baseUrl,
    });
    context.setDefaultTimeout(this.config.actionTimeoutMs);
    const page = await context.newPage();
    const id = `s${randomBytes(4).toString('hex')}`;
    const session = new Session(id, options, context, page);
    // Must expire before an action times out; the action that opened the dialog
    // stays blocked until the dialog is answered.
    // Strictly below the action timeout: the action that opened the dialog is
    // blocked until it is answered, and must not be the thing that fails.
    session.dialogHoldMs = Math.max(200, Math.round(this.config.actionTimeoutMs * 0.5));
    this.sessions.set(id, session);
    this.startReaper();
    return session;
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      const known = [...this.sessions.keys()];
      throw new Error(
        `No session "${id}". ${
          known.length
            ? `Open sessions: ${known.join(', ')}.`
            : 'No sessions are open — call browser_start first.'
        }`,
      );
    }
    session.touch();
    return session;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`No session "${id}".`);
    this.sessions.delete(id);
    await session.close();
  }

  private startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      for (const session of this.list()) {
        if (session.idleMs > this.config.idleTimeoutMs) {
          this.sessions.delete(session.id);
          void session.close();
        }
      }
    }, 30_000);
    this.reaper.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    await Promise.all(this.list().map((session) => session.close()));
    this.sessions.clear();
    for (const pending of this.browsers.values()) {
      await pending.then((browser) => browser.close()).catch(() => {});
    }
    this.browsers.clear();
  }
}
