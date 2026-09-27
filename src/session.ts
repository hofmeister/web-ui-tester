import { randomBytes } from 'node:crypto';
import type { BrowserContext, Dialog, Page, Request, Response, WebSocket } from 'playwright';
import { connectBrowser, launchBrowser, type BrowserHandle } from './browser.ts';
import { DevtoolsBridge } from './devtools.ts';
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
  /** Undefined keeps the browser's own, which a shared profile must. */
  userAgent?: string;
  /** Undefined keeps the tab's own size, which a shared profile should. */
  viewport?: { width: number; height: number };
  headless: boolean;
  baseUrl?: string;
  model?: string;
  /** Attach to an already-running Chrome at this CDP endpoint instead of launching one. */
  cdpUrl?: string;
  /**
   * With cdpUrl: drive the browser's own profile (its cookies, logins and tabs)
   * rather than a fresh isolated context inside it.
   */
  useBrowserProfile?: boolean;
  /** With useBrowserProfile: take over the existing tab whose URL contains this. */
  tab?: string;
  /**
   * Launch into a browser with a private DevTools port, so chrome-devtools-mcp's
   * tools can reach it through browser_call_tool.
   */
  devtools?: boolean;
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
  /**
   * True when the context is a real browser profile shared with its user (and
   * possibly other sessions): the session then only ever touches pages it
   * opened or was pointed at, and never closes the context.
   */
  readonly shared: boolean;
  /** DevTools protocol endpoint of the browser this session runs in, if reachable. */
  readonly cdpEndpoint?: string;
  /** Pages this session opened itself, and so may close when it ends. */
  private readonly ownedPages = new Set<Page>();
  private readonly onContextPage: (page: Page) => void;
  private activePage: Page;

  constructor(
    id: string,
    options: SessionOptions,
    context: BrowserContext,
    activePage: Page,
    extra: { shared?: boolean; ownsPage?: boolean; cdpEndpoint?: string } = {},
  ) {
    this.id = id;
    this.options = options;
    this.context = context;
    this.shared = extra.shared ?? false;
    this.cdpEndpoint = extra.cdpEndpoint;
    this.activePage = activePage;
    if (extra.ownsPage ?? true) this.ownedPages.add(activePage);
    this.attach(activePage);
    this.onContextPage = (page) => {
      if (!this.shared) {
        this.adopt(page);
        return;
      }
      // In a shared profile every tab the user opens lands here too; only a
      // popup one of this session's own pages opened belongs to the session.
      void page
        .opener()
        .then((opener) => {
          if (opener && this.attached.has(opener)) this.adopt(page);
        })
        .catch(() => {});
    };
    context.on('page', this.onContextPage);
  }

  private adopt(page: Page): void {
    this.activePage = page;
    this.ownedPages.add(page);
    this.attach(page);
    this.pendingNotice = `A new page/popup opened and is now the active page: ${page.url()}`;
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
    const alive = this.context
      .pages()
      .find((page) => !page.isClosed() && (!this.shared || this.attached.has(page)));
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
    if (this.shared && this.options.viewport) await page.setViewportSize(this.options.viewport);
    this.activePage = page;
    this.ownedPages.add(page);
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
    this.context.off('page', this.onContextPage);
    if (!this.shared) {
      await this.context.close().catch(() => {});
      return;
    }
    // The profile belongs to the user: close only the tabs this session opened,
    // and leave a tab it was pointed at open.
    await Promise.all([...this.ownedPages].map((page) => page.close().catch(() => {})));
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /**
   * One launched browser per headless mode, plus one connection per CDP
   * endpoint; contexts give sessions their isolation.
   */
  private readonly browsers = new Map<string, Promise<BrowserHandle>>();
  /** One chrome-devtools-mcp child per browser endpoint, started on first use. */
  private readonly bridges = new Map<string, DevtoolsBridge>();
  private reaper?: NodeJS.Timeout;

  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private browser(options: SessionOptions): Promise<BrowserHandle> {
    // A browser launched with a DevTools port is kept apart from one without,
    // so asking for devtools never opens a port on everyone else's browser.
    const exposed = this.config.cdpPort !== undefined || Boolean(options.devtools);
    const key = options.cdpUrl
      ? `cdp ${options.cdpUrl}`
      : `launch ${options.headless}${exposed ? ' exposed' : ''}`;
    const existing = this.browsers.get(key);
    if (existing) return existing;

    let pending: Promise<BrowserHandle>;
    if (options.cdpUrl) {
      pending = connectBrowser(options.cdpUrl);
    } else {
      // Headed and headless browsers cannot share one port; the second launched
      // gets a free one, and browser_start reports whichever it got.
      const taken = [...this.browsers.keys()].some((other) => other.endsWith(' exposed'));
      pending = launchBrowser({
        headless: options.headless,
        executablePath: this.config.executablePath,
        cdpPort: !exposed
          ? undefined
          : this.config.cdpPort === undefined || taken
            ? 0
            : this.config.cdpPort,
      });
    }
    this.browsers.set(key, pending);
    // Neither a failed launch nor a later crash may poison the slot: without
    // this, one Chromium crash breaks every subsequent browser_start.
    const forget = () => {
      if (this.browsers.get(key) === pending) this.browsers.delete(key);
    };
    pending.then(
      ({ browser }) => browser.on('disconnected', forget),
      forget,
    );
    return pending;
  }

  async create(options: SessionOptions): Promise<Session> {
    const { browser, cdpEndpoint } = await this.browser(options);
    const id = `s${randomBytes(4).toString('hex')}`;
    let session: Session;

    if (options.cdpUrl && options.useBrowserProfile) {
      // A browser attached over CDP exposes its real profile as the first context.
      const context = browser.contexts()[0];
      if (!context) throw new Error(`The browser at ${options.cdpUrl} has no default profile to use.`);
      context.setDefaultTimeout(this.config.actionTimeoutMs);
      let page: Page;
      let ownsPage = false;
      if (options.tab) {
        const needle = options.tab;
        const match = context.pages().find((candidate) => candidate.url().includes(needle));
        if (!match) {
          const open = context.pages().map((candidate) => `  ${candidate.url()}`);
          throw new Error(
            `No open tab's URL contains "${needle}".` +
              (open.length ? ` Open tabs:\n${open.join('\n')}` : ' The browser has no open tabs.'),
          );
        }
        page = match;
      } else {
        page = await context.newPage();
        ownsPage = true;
      }
      if (options.viewport) await page.setViewportSize(options.viewport);
      session = new Session(id, options, context, page, { shared: true, ownsPage, cdpEndpoint });
    } else {
      const context = await browser.newContext({
        userAgent: options.userAgent,
        viewport: options.viewport,
        baseURL: options.baseUrl,
      });
      context.setDefaultTimeout(this.config.actionTimeoutMs);
      const page = await context.newPage();
      session = new Session(id, options, context, page, { cdpEndpoint });
    }
    // Must expire before an action times out; the action that opened the dialog
    // stays blocked until the dialog is answered.
    // Strictly below the action timeout: the action that opened the dialog is
    // blocked until it is answered, and must not be the thing that fails.
    session.dialogHoldMs = Math.max(200, Math.round(this.config.actionTimeoutMs * 0.5));
    this.sessions.set(id, session);
    this.startReaper();
    return session;
  }

  /** The chrome-devtools-mcp bridge for a session's browser, if it has an endpoint. */
  bridge(session: Session): DevtoolsBridge | undefined {
    const endpoint = session.cdpEndpoint;
    if (!endpoint) return undefined;
    let bridge = this.bridges.get(endpoint);
    if (!bridge) {
      bridge = new DevtoolsBridge(endpoint, this.config.devtoolsCommand);
      this.bridges.set(endpoint, bridge);
    }
    return bridge;
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
    await Promise.all([...this.bridges.values()].map((bridge) => bridge.close()));
    this.bridges.clear();
    this.sessions.clear();
    for (const pending of this.browsers.values()) {
      // For a browser attached over CDP this only disconnects (and drops the
      // contexts this server created); the user's Chrome keeps running.
      await pending.then(({ browser }) => browser.close()).catch(() => {});
    }
    this.browsers.clear();
  }
}
