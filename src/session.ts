import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, Dialog, Page, Request, Response } from 'playwright';
import { launchBrowser } from './browser.js';
import type { Config } from './config.js';

const CONSOLE_BUFFER_MAX = 500;
const NETWORK_BUFFER_MAX = 300;
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
  request: Request;
  response?: Response;
}

export interface PendingDialog {
  type: string;
  message: string;
  defaultValue: string;
  dialog: Dialog;
  timer: NodeJS.Timeout;
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
  /** Last dialog auto-dismissed on timeout, so an action can explain itself. */
  lastDismissedDialog?: string;
  /** How long an unanswered dialog is held; set from the action timeout. */
  dialogHoldMs = 3_000;

  /**
   * Monotonic counters, never reset by ring-buffer eviction. Array indices
   * would silently under-report activity once a buffer wraps.
   */
  private consoleSeq = 0;
  private nextRequestId = 1;
  private readonly requestStarts = new WeakMap<Request, number>();

  constructor(
    id: string,
    options: SessionOptions,
    readonly context: BrowserContext,
    private activePage: Page,
  ) {
    this.id = id;
    this.options = options;
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

  private pushConsole(entry: Omit<ConsoleEntry, 'seq'>): void {
    this.console.push({ ...entry, seq: ++this.consoleSeq });
    if (this.console.length > CONSOLE_BUFFER_MAX) {
      this.console.splice(0, this.console.length - CONSOLE_BUFFER_MAX);
    }
  }

  private attach(page: Page): void {
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
      this.network.push(entry);
      if (this.network.length > NETWORK_BUFFER_MAX) {
        this.network.splice(0, this.network.length - NETWORK_BUFFER_MAX);
      }
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

    page.on('dialog', (dialog) => {
      this.pushConsole({
        ts: Date.now(),
        level: 'dialog',
        text: `${dialog.type()}: ${dialog.message()}`,
      });
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
          this.lastDismissedDialog = `${dialog.type()}: ${dialog.message()}`;
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

  constructor(private readonly config: Config) {}

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
    session.dialogHoldMs = Math.max(1_000, Math.round(this.config.actionTimeoutMs * 0.5));
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
