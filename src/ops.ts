import type { Locator } from 'playwright';
import type { Config } from './config.js';
import type { NetworkEntry, Session, SessionManager, SessionOptions } from './session.js';
import { ariaSnapshot, clip, rootRef, summarizeLine } from './snapshot.js';

/** How much snapshot text an auto-attached "here's the page now" section gets. */
const MINI_SNAPSHOT_CHARS = 4_000;

export interface Target {
  ref?: string;
  css?: string;
  role?: string;
  name?: string;
  /** Nth match when the selector is ambiguous (0-based). */
  index?: number;
}

export class OpError extends Error {}

/**
 * Stale refs fail two different ways: an element removed from the current page
 * makes the locator wait and time out, while a ref from a page that has since
 * been navigated away fails immediately with an invalid-frame error. Both mean
 * the same thing to the caller — re-snapshot, don't retry.
 */
function translateError(
  error: unknown,
  target?: Target,
  session?: Session,
  startedAt?: number,
): OpError {
  const message = error instanceof Error ? error.message : String(error);

  // A modal dialog blocks the page until answered, so anything in flight times
  // out. Say so rather than sending the caller hunting for a missing element —
  // but only for a dialog this very action raised, or the timeout of some
  // unrelated action would be blamed on a dialog handled long ago.
  const answered = session?.lastAnsweredDialog;
  const duringThisAction =
    answered !== undefined && startedAt !== undefined && answered.at >= startedAt;
  const dialog = session?.pendingDialog
    ? `${session.pendingDialog.type}: ${session.pendingDialog.message}`
    : duringThisAction
      ? answered.text
      : undefined;
  if (dialog && /Timeout .* exceeded/i.test(message)) {
    return new OpError(
      `The action was blocked by a dialog (${dialog}). ` +
        (session?.pendingDialog
          ? 'Answer it with browser_handle_dialog, then retry.'
          : `It was ${answered?.how ?? 'dismissed'}. To control the answer, call ` +
            'browser_handle_dialog before the action that opens the dialog.'),
    );
  }

  const staleRefHint =
    `Ref "${target?.ref}" is no longer valid — the page has changed since the snapshot ` +
    'that produced it. Call browser_snapshot for fresh refs, then retry.';

  if (target?.ref && /Invalid frame in aria-ref|aria-ref.*not found|No element matching aria-ref/i.test(message)) {
    return new OpError(staleRefHint);
  }
  if (/Timeout .* exceeded/i.test(message)) {
    if (target?.ref) {
      return new OpError(
        `Element "${target.ref}" was not found or not actionable within the timeout. ` +
          'It may have been removed or changed since the last snapshot — ' +
          'call browser_snapshot for fresh refs and retry.',
      );
    }
    return new OpError(
      `Timed out locating the element (${describeTarget(target)}). ` +
        'Confirm it exists with browser_query or browser_snapshot.',
    );
  }
  return new OpError(message);
}

function describeTarget(target?: Target): string {
  if (!target) return 'no target';
  if (target.ref) return `ref=${target.ref}`;
  if (target.css) return `css=${target.css}`;
  if (target.role) return `role=${target.role}${target.name ? ` name="${target.name}"` : ''}`;
  return 'no target';
}

export function locate(session: Session, target: Target): Locator {
  const { page } = session;
  let locator: Locator;
  if (target.ref) {
    locator = page.locator(`aria-ref=${target.ref}`);
  } else if (target.css) {
    locator = page.locator(target.css);
  } else if (target.role) {
    locator = page.getByRole(target.role as Parameters<typeof page.getByRole>[0], {
      ...(target.name ? { name: target.name } : {}),
    });
  } else {
    throw new OpError('Specify one of: ref, css, or role (with optional name).');
  }
  return target.index !== undefined ? locator.nth(target.index) : locator.first();
}

async function act<T>(
  target: Target | undefined,
  fn: () => Promise<T>,
  session?: Session,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } catch (error) {
    throw translateError(error, target, session, startedAt);
  }
}

export interface PageState {
  url: string;
  title: string;
}

export async function pageState(session: Session): Promise<PageState> {
  const { page } = session;
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
  };
}

/** Header every action result carries, so the model always knows where it is. */
export async function stateLine(session: Session): Promise<string> {
  const { url, title } = await pageState(session);
  return `url: ${url}\ntitle: ${title || '(untitled)'}`;
}

export async function miniSnapshot(session: Session): Promise<string> {
  const text = await ariaSnapshot(session.page).catch(
    (error) => `(snapshot unavailable: ${(error as Error).message})`,
  );
  const clipped = clip(text, MINI_SNAPSHOT_CHARS);
  return clipped.truncated
    ? `${clipped.text}\n(Call browser_snapshot for the full tree.)`
    : clipped.text;
}

/** What an action caused — errors, requests, dialogs — so nothing goes unnoticed. */
function activitySince(session: Session, marks: { console: number; network: number }): string {
  const errors = session.countConsoleErrorsSince(marks.console);
  const since = session.requestsSince(marks.network);
  const failed = since.filter((entry) => entry.failure || (entry.status ?? 0) >= 400).length;
  const parts: string[] = [];
  if (errors) parts.push(`${errors} new console error(s) — see browser_console`);
  if (since.length) {
    parts.push(`${since.length} request(s)${failed ? `, ${failed} failed/4xx/5xx` : ''}`);
  }

  const lines = parts.length ? [`activity: ${parts.join('; ')}`] : [];

  // A dialog blocks the page, so it is answered quickly rather than left to
  // stall the action. Say what happened either way.
  const dialogs = session.console.filter(
    (entry) => entry.seq > marks.console && entry.level === 'dialog',
  );
  for (const dialog of dialogs) {
    if (session.pendingDialog) {
      lines.push(`dialog open (${dialog.text}) — answer it with browser_handle_dialog`);
      continue;
    }
    const how = session.lastAnsweredDialog?.how ?? 'auto-dismissed';
    lines.push(
      `dialog ${how}: ${dialog.text}` +
        (how === 'auto-dismissed'
          ? ' (call browser_handle_dialog beforehand to accept it instead)'
          : ''),
    );
  }

  return lines.length ? `\n${lines.join('\n')}` : '';
}

export interface ActionResult {
  text: string;
}

async function withActivity(
  session: Session,
  fn: () => Promise<string>,
): Promise<string> {
  const marks = session.marks();
  const urlBefore = session.page.url();
  const summary = await fn();
  // Let same-tick navigations and XHRs register before reporting.
  await session.page.waitForTimeout(120).catch(() => {});
  const urlAfter = session.page.url();
  const navigated = urlAfter !== urlBefore ? `\nnavigated to: ${urlAfter}` : '';
  const notice = session.takeNotice();
  return (
    summary + navigated + activitySince(session, marks) + (notice ? `\nnote: ${notice}` : '')
  );
}

// ---------------------------------------------------------------- session ---

export interface StartOptions extends Partial<SessionOptions> {
  url?: string;
}

export async function startSession(
  sessions: SessionManager,
  config: Config,
  options: StartOptions,
): Promise<{ session: Session; text: string }> {
  const session = await sessions.create({
    userAgent: options.userAgent ?? config.userAgent,
    viewport: options.viewport ?? { width: 1280, height: 720 },
    headless: options.headless ?? config.headless,
    baseUrl: options.baseUrl,
    model: options.model,
  });

  const lines = [
    `sessionId: ${session.id}`,
    `userAgent: ${session.options.userAgent}`,
    `viewport: ${session.options.viewport.width}x${session.options.viewport.height}`,
    `headless: ${session.options.headless}`,
  ];
  if (session.options.baseUrl) lines.push(`baseUrl: ${session.options.baseUrl}`);
  lines.push(
    `The session stays alive for further tool calls and is closed after ` +
      `${Math.round(config.idleTimeoutMs / 60_000)} minutes of inactivity.`,
  );

  if (options.url) {
    // A failed opening navigation must not discard the sessionId — the session
    // is already registered, and losing its id would strand the browser context
    // until the idle reaper runs.
    try {
      lines.push('', await navigate(session, options.url));
    } catch (error) {
      lines.push(
        '',
        `The session is open, but navigating to ${options.url} failed: ${(error as Error).message}`,
        'Retry with browser_navigate, or close the session with browser_close.',
      );
    }
  }
  return { session, text: lines.join('\n') };
}

export function listSessions(sessions: SessionManager): string {
  const all = sessions.list();
  if (!all.length) return 'No open sessions. Call browser_start to open one.';
  return all
    .map((session) => {
      const age = Math.round((Date.now() - session.createdAt) / 1000);
      const idle = Math.round(session.idleMs / 1000);
      // livePage(), not page: one session without a live page must not break
      // the listing for every other session.
      const url = session.livePage()?.url() || '(no open page)';
      return `${session.id}  ${url}  (age ${age}s, idle ${idle}s, ua ${session.options.userAgent})`;
    })
    .join('\n');
}

// ------------------------------------------------------------ interaction ---

export async function navigate(
  session: Session,
  url: string,
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'load',
): Promise<string> {
  const resolved = session.resolveUrl(url);
  const marks = session.marks();
  // Reopens a page if every one of them closed, so navigate is the documented
  // way back from an empty session rather than another failure.
  const page = await session.ensurePage();
  const response = await act(undefined, async () => {
    try {
      return await page.goto(resolved, { waitUntil, timeout: 30_000 });
    } catch (error) {
      // Navigating straight after a failed load races with Chrome committing
      // its error page. Let that settle, then retry once.
      if (!/interrupted by another navigation/i.test((error as Error).message)) throw error;
      await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
      if (page.url() === resolved) return null;
      return await page.goto(resolved, { waitUntil, timeout: 30_000 });
    }
  });
  const status = response ? `${response.status()} ${response.statusText()}` : 'no response';
  return [
    `navigated: ${resolved} (${status})`,
    await stateLine(session),
    activitySince(session, marks).trim(),
    '',
    'snapshot:',
    await miniSnapshot(session),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function click(
  session: Session,
  target: Target,
  options: { doubleClick?: boolean; button?: 'left' | 'right' | 'middle'; modifiers?: string[] } = {},
): Promise<string> {
  return withActivity(session, async () => {
    const locator = locate(session, target);
    const clickOptions = {
      button: options.button ?? 'left',
      ...(options.modifiers?.length
        ? { modifiers: options.modifiers as ('Alt' | 'Control' | 'Meta' | 'Shift')[] }
        : {}),
    } as const;
    await act(
      target,
      () => (options.doubleClick ? locator.dblclick(clickOptions) : locator.click(clickOptions)),
      session,
    );
    return `clicked ${describeTarget(target)}`;
  });
}

export async function type(
  session: Session,
  target: Target,
  text: string,
  options: { submit?: boolean; clear?: boolean } = {},
): Promise<string> {
  return withActivity(session, async () => {
    const locator = locate(session, target);
    await act(target, async () => {
      if (options.clear === false) {
        // Click alone leaves the caret where it landed, which inserts mid-value.
        // Control+End reaches the end of the whole value; plain End stops at
        // the end of the current line, which is wrong for a textarea.
        await locator.click();
        await locator.press('Control+End');
        await locator.pressSequentially(text);
      } else {
        await locator.fill(text);
      }
      if (options.submit) await locator.press('Enter');
    }, session);
    return `typed ${JSON.stringify(text)} into ${describeTarget(target)}${
      options.submit ? ' and pressed Enter' : ''
    }`;
  });
}

export async function pressKey(
  session: Session,
  key: string,
  target?: Target,
): Promise<string> {
  return withActivity(session, async () => {
    if (target && (target.ref || target.css || target.role)) {
      await act(target, () => locate(session, target).press(key), session);
      return `pressed ${key} on ${describeTarget(target)}`;
    }
    await act(undefined, () => session.page.keyboard.press(key));
    return `pressed ${key}`;
  });
}

export async function hover(session: Session, target: Target): Promise<string> {
  return withActivity(session, async () => {
    await act(target, () => locate(session, target).hover(), session);
    return `hovered ${describeTarget(target)}`;
  });
}

export async function selectOption(
  session: Session,
  target: Target,
  values: string[],
): Promise<string> {
  return withActivity(session, async () => {
    const selected = await act(
      target,
      () => locate(session, target).selectOption(values),
      session,
    );
    return `selected ${JSON.stringify(selected)} in ${describeTarget(target)}`;
  });
}

export async function scroll(
  session: Session,
  options: { target?: Target; dy?: number; dx?: number },
): Promise<string> {
  return withActivity(session, async () => {
    if (options.target && (options.target.ref || options.target.css || options.target.role)) {
      await act(options.target, () =>
        locate(session, options.target!).scrollIntoViewIfNeeded(),
      );
      return `scrolled ${describeTarget(options.target)} into view`;
    }
    const dy = options.dy ?? 0;
    const dx = options.dx ?? 0;
    await act(undefined, () => session.page.mouse.wheel(dx, dy));
    return `scrolled by (${dx}, ${dy})`;
  });
}

export async function waitFor(
  session: Session,
  options: { text?: string; textGone?: string; selector?: string; timeoutMs?: number },
): Promise<string> {
  // Clamped below as well as above: Playwright reads 0 as "no timeout", which
  // would hang the call (and an agent loop) indefinitely.
  const timeout = Math.min(Math.max(options.timeoutMs ?? 5_000, 100), 15_000);
  const { page } = session;
  try {
    if (options.text) {
      await page.getByText(options.text).first().waitFor({ state: 'visible', timeout });
      return `text appeared: ${JSON.stringify(options.text)}\n${await stateLine(session)}`;
    }
    if (options.textGone) {
      await page.getByText(options.textGone).first().waitFor({ state: 'hidden', timeout });
      return `text gone: ${JSON.stringify(options.textGone)}\n${await stateLine(session)}`;
    }
    if (options.selector) {
      await page.locator(options.selector).first().waitFor({ state: 'visible', timeout });
      return `selector visible: ${options.selector}\n${await stateLine(session)}`;
    }
    await page.waitForTimeout(timeout);
    return `waited ${timeout}ms\n${await stateLine(session)}`;
  } catch (error) {
    if (error instanceof Error && /Timeout/i.test(error.message)) {
      throw new OpError(
        `Condition not met within ${timeout}ms. Current state:\n${await stateLine(session)}`,
      );
    }
    throw translateError(error);
  }
}

export async function goBack(session: Session): Promise<string> {
  await act(undefined, () => session.page.goBack({ timeout: 15_000 }));
  return [
    'went back',
    await stateLine(session),
    '',
    'snapshot:',
    await miniSnapshot(session),
  ].join('\n');
}

export async function handleDialog(
  session: Session,
  accept: boolean,
  promptText?: string,
): Promise<string> {
  const pending = session.pendingDialog;
  if (!pending) {
    // A dialog blocks the page until answered, so the action that opens one
    // cannot also answer it. Arming a policy is how confirm() and prompt()
    // flows get an answer other than "dismiss".
    session.dialogPolicy = { accept, promptText };
    return (
      `No dialog is open right now, so the next one will be ${accept ? 'accepted' : 'dismissed'}` +
      `${accept && promptText !== undefined ? ` with text ${JSON.stringify(promptText)}` : ''}. ` +
      'This applies to one dialog; arm it again for the next.'
    );
  }
  clearTimeout(pending.timer);
  session.pendingDialog = undefined;
  if (accept) {
    await pending.dialog.accept(promptText);
    return `accepted ${pending.type}: ${pending.message}`;
  }
  await pending.dialog.dismiss();
  return `dismissed ${pending.type}: ${pending.message}`;
}

// ------------------------------------------------------------- inspection ---

export async function snapshot(
  session: Session,
  options: {
    target?: Target;
    depth?: number;
    boxes?: boolean;
    interactiveOnly?: boolean;
    maxChars: number;
    offset?: number;
  },
): Promise<string> {
  const isScoped = Boolean(
    options.target && (options.target.ref || options.target.css || options.target.role),
  );
  const scoped = isScoped ? locate(session, options.target!) : session.page;
  const text = await act(options.target, () =>
    ariaSnapshot(scoped, {
      depth: options.depth,
      boxes: options.boxes,
      interactiveOnly: options.interactiveOnly,
    }),
  );
  if (isScoped) await restoreRefRegistry(session);
  return withHeader(session, text, options.maxChars, options.offset);
}

/**
 * Playwright resolves `aria-ref=` against the most recent snapshot, so a scoped
 * snapshot narrows the registry to that subtree and refs outside it stop
 * resolving. Refs are keyed to DOM nodes and stay stable, so re-taking the
 * page-wide snapshot restores resolution without changing any ref the caller
 * has already been given.
 */
async function restoreRefRegistry(session: Session): Promise<void> {
  await session.page.ariaSnapshot({ mode: 'ai' }).catch(() => {});
}

/**
 * Prefixes the page state and clips the body to fit the caller's budget
 * *including* that prefix. Budgeting the body alone would push the result over
 * the tool-level cap, which then truncates the pagination note off the end and
 * leaves a gap between pages.
 */
async function withHeader(
  session: Session,
  body: string,
  maxChars: number,
  offset?: number,
): Promise<string> {
  const header = `${await stateLine(session)}\n\n`;
  const budget = Math.max(200, maxChars - header.length);
  return header + clip(body, budget, offset ?? 0).text;
}

export async function query(
  session: Session,
  target: Target & { text?: string },
  limit = 10,
): Promise<string> {
  const { page } = session;
  let locator: Locator;
  if (target.text) {
    locator = page.getByText(target.text);
  } else if (target.css) {
    locator = page.locator(target.css);
  } else if (target.role) {
    locator = page.getByRole(target.role as Parameters<typeof page.getByRole>[0], {
      ...(target.name ? { name: target.name } : {}),
    });
  } else {
    throw new OpError('Specify one of: role (with optional name), text, or css.');
  }

  const count = await act(undefined, () => locator.count());
  if (count === 0) return `No matches for ${describeQuery(target)}.`;

  const shown = Math.min(count, limit);
  const lines: string[] = [];
  for (let i = 0; i < shown; i++) {
    const match = locator.nth(i);
    // A scoped ai-snapshot reports the element's page-global ref on its root
    // line. Each one narrows the ref registry, so it is restored below —
    // otherwise only the last match's ref would still resolve.
    const snap = await match.ariaSnapshot({ mode: 'ai', depth: 1 }).catch(() => '');
    const ref = rootRef(snap);
    const first = snap.split('\n')[0] ?? '';
    const visible = await match.isVisible().catch(() => false);
    const enabled = await match.isEnabled().catch(() => true);
    const state = [visible ? 'visible' : 'hidden', enabled ? 'enabled' : 'disabled'].join(',');
    lines.push(
      `[${i}] ${ref ? `ref=${ref} ` : ''}${summarizeLine(first) || '(no aria line)'} (${state})`,
    );
  }
  await restoreRefRegistry(session);
  const more = count > shown ? `\n…${count - shown} more match(es); raise limit to see them.` : '';
  return `${count} match(es) for ${describeQuery(target)}:\n${lines.join('\n')}${more}`;
}

function describeQuery(target: Target & { text?: string }): string {
  if (target.text) return `text=${JSON.stringify(target.text)}`;
  if (target.css) return `css=${target.css}`;
  return `role=${target.role}${target.name ? ` name="${target.name}"` : ''}`;
}

export async function readText(
  session: Session,
  options: { target?: Target; maxChars: number; offset?: number },
): Promise<string> {
  const scoped =
    options.target && (options.target.ref || options.target.css || options.target.role)
      ? locate(session, options.target)
      : session.page.locator('body');
  const text = await act(options.target, () => scoped.innerText());
  return withHeader(session, text, options.maxChars, options.offset);
}

export async function screenshot(
  session: Session,
  options: { target?: Target; fullPage?: boolean },
): Promise<{ base64: string; mimeType: string }> {
  const shot =
    options.target && (options.target.ref || options.target.css || options.target.role)
      ? await act(options.target, () =>
          locate(session, options.target!).screenshot({ type: 'jpeg', quality: 60 }),
        )
      : await act(undefined, () =>
          session.page.screenshot({
            type: 'jpeg',
            quality: 60,
            fullPage: options.fullPage ?? false,
          }),
        );
  return { base64: shot.toString('base64'), mimeType: 'image/jpeg' };
}

// ------------------------------------------------------------ diagnostics ---

export function consoleLog(
  session: Session,
  options: {
    level?: 'error' | 'warning' | 'info' | 'all';
    limit?: number;
    sinceLastCall?: boolean;
    clear?: boolean;
  },
): string {
  const level = options.level ?? 'all';
  const cursor = session.consoleReadSeq.get(level) ?? 0;
  const limit = options.limit ?? 50;
  let entries = session.console.filter((entry) => matchesLevel(entry.level, level));
  if (options.sinceLastCall) {
    entries = entries.filter((entry) => entry.seq > cursor);
  }

  const suffix = level === 'all' ? '' : ` at level "${level}"`;
  if (!entries.length) {
    if (options.clear) session.console.length = 0;
    return options.sinceLastCall
      ? `No new console entries${suffix}.`
      : `Console buffer is empty${suffix}.`;
  }

  // A `sinceLastCall` read drains oldest-first and consumes only what it
  // returned, so a burst larger than `limit` is delivered across calls instead
  // of having its oldest entries skipped. A full read shows the newest instead,
  // and leaves the cursor alone.
  const shown = options.sinceLastCall ? entries.slice(0, limit) : entries.slice(-limit);
  const remaining = entries.length - shown.length;
  const newest = shown[shown.length - 1];
  if (options.sinceLastCall && newest) {
    session.consoleReadSeq.set(level, newest.seq);
  }

  if (options.clear) {
    // Clearing a filtered read must not discard unread entries of other levels.
    const kept = session.console.filter((entry) => !matchesLevel(entry.level, level));
    session.console.length = 0;
    session.console.push(...kept);
    session.consoleReadSeq.delete(level);
  }

  const lines = shown.map(
    (entry) => `[${entry.level}] ${entry.text}${entry.location ? `  (${entry.location})` : ''}`,
  );
  const note = remaining
    ? options.sinceLastCall
      ? `\n…${remaining} more unread; call again for the next batch.`
      : `\n…${remaining} older entries omitted; raise limit to see them.`
    : '';
  return lines.join('\n') + note;
}

/**
 * Maps a filter onto the console types Playwright actually emits. console.log
 * arrives as "log", so an "info" filter that only matched "info" reported an
 * empty buffer while log lines sat in it.
 */
function matchesLevel(entryLevel: string, filter: 'error' | 'warning' | 'info' | 'all'): boolean {
  if (filter === 'all') return true;
  // Uncaught page errors belong with console errors — they are the same signal.
  if (filter === 'error') return entryLevel === 'error' || entryLevel === 'pageerror';
  if (filter === 'warning') return entryLevel === 'warning' || entryLevel === 'warn';
  return ['info', 'log', 'debug', 'trace', 'dir', 'table', 'count', 'timeEnd'].includes(
    entryLevel,
  );
}

export function networkLog(
  session: Session,
  options: { filter?: string; status?: 'failed' | '4xx' | '5xx' | 'all'; limit?: number },
): string {
  let entries = session.network;
  if (options.filter) {
    const needle = options.filter.toLowerCase();
    entries = entries.filter((entry) => entry.url.toLowerCase().includes(needle));
  }
  const status = options.status ?? 'all';
  if (status === 'failed') {
    entries = entries.filter((entry) => entry.failure || (entry.status ?? 0) >= 400);
  } else if (status === '4xx') {
    entries = entries.filter((entry) => (entry.status ?? 0) >= 400 && (entry.status ?? 0) < 500);
  } else if (status === '5xx') {
    entries = entries.filter((entry) => (entry.status ?? 0) >= 500);
  }

  if (!entries.length) return 'No matching requests.';

  const limit = options.limit ?? 30;
  const shown = entries.slice(-limit);
  const omitted = entries.length - shown.length;
  const lines = shown.map((entry) => formatNetworkLine(entry));
  return (
    (omitted ? `…${omitted} older requests omitted\n` : '') +
    lines.join('\n') +
    '\nUse browser_request_detail with #id for headers, timing, and bodies.'
  );
}

function formatNetworkLine(entry: NetworkEntry): string {
  const status = entry.failure ? `FAILED(${entry.failure})` : (entry.status ?? 'pending');
  const size = entry.sizeBytes !== undefined ? `, ${entry.sizeBytes}B` : '';
  const duration = entry.durationMs !== undefined ? `, ${entry.durationMs}ms` : '';
  return `#${entry.id} ${entry.method} ${status} ${entry.url} (${entry.resourceType}${size}${duration})`;
}

export async function requestDetail(
  session: Session,
  id: number,
  part: 'summary' | 'headers' | 'requestBody' | 'responseBody',
  maxChars: number,
  offset = 0,
): Promise<string> {
  const entry = session.findRequest(id);
  if (!entry) {
    throw new OpError(
      `No request #${id} in this session's buffer. Call browser_network to list current ids.`,
    );
  }

  if (part === 'headers') {
    return [
      formatNetworkLine(entry),
      '',
      'request headers:',
      formatHeaders(entry.requestHeaders),
      '',
      'response headers:',
      entry.responseHeaders ? formatHeaders(entry.responseHeaders) : '(none)',
    ].join('\n');
  }

  if (part === 'requestBody') {
    if (!entry.postData) return `${formatNetworkLine(entry)}\n\n(no request body)`;
    return `${formatNetworkLine(entry)}\n\n${clip(entry.postData, maxChars, offset).text}`;
  }

  if (part === 'responseBody') {
    const body = await resolveBody(entry);
    return `${formatNetworkLine(entry)}\n\n${clip(body, maxChars, offset).text}`;
  }

  const timing = entry.request.timing();
  const timingLines = timing
    ? [
        `  dns:      ${fmtPhase(timing.domainLookupStart, timing.domainLookupEnd)}`,
        `  connect:  ${fmtPhase(timing.connectStart, timing.connectEnd)}`,
        `  tls:      ${fmtPhase(timing.secureConnectionStart, timing.connectEnd)}`,
        `  request:  ${fmtPhase(timing.requestStart, timing.responseStart)}`,
        `  response: ${fmtPhase(timing.responseStart, timing.responseEnd)}`,
      ].join('\n')
    : '  (unavailable)';

  return [
    formatNetworkLine(entry),
    `resourceType: ${entry.resourceType}`,
    entry.failure ? `failure: ${entry.failure}` : '',
    `content-type: ${entry.responseHeaders?.['content-type'] ?? '(unknown)'}`,
    'timing:',
    timingLines,
    entry.postData ? `\nrequest body: ${clip(entry.postData, 500).text}` : '',
    entry.cachedBody
      ? `\nresponse body (cached): ${clip(entry.cachedBody, 500).text}`
      : entry.bodyNote
        ? `\nresponse body: ${entry.bodyNote}`
        : '\nresponse body: use part="responseBody" to fetch it',
  ]
    .filter(Boolean)
    .join('\n');
}

function fmtPhase(start: number, end: number): string {
  if (start < 0 || end < 0 || end < start) return 'n/a';
  return `${Math.round(end - start)}ms`;
}

function formatHeaders(headers: Record<string, string>): string {
  const entries = Object.entries(headers);
  if (!entries.length) return '(none)';
  return entries.map(([key, value]) => `  ${key}: ${value}`).join('\n');
}

async function resolveBody(entry: NetworkEntry): Promise<string> {
  if (entry.cachedBody !== undefined) return entry.cachedBody;
  if (!entry.response) {
    throw new OpError(`Request #${entry.id} has no response yet${entry.failure ? ` (${entry.failure})` : ''}.`);
  }
  try {
    const buffer = await entry.response.body();
    return buffer.toString('utf8');
  } catch (error) {
    throw new OpError(
      `Body for #${entry.id} is no longer available (${(error as Error).message}). ` +
        'Bodies are only retrievable while the page that made the request is still loaded; ' +
        'small text responses are cached automatically.',
    );
  }
}

export async function evaluate(
  session: Session,
  expression: string,
  target?: Target,
  maxChars = 10_000,
): Promise<string> {
  const scoped = Boolean(target && (target.ref || target.css || target.role));
  const fn = compile(expression, scoped);
  try {
    const result = scoped
      ? await locate(session, target!).evaluate(fn, undefined, { timeout: 10_000 })
      : await session.page.evaluate(fn);
    return clip(serialize(result), maxChars).text;
  } catch (error) {
    if (error instanceof Error && /Timeout/i.test(error.message)) {
      throw translateError(error, target);
    }
    throw new OpError(`Evaluation failed: ${(error as Error).message}`);
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>;

/**
 * Playwright evaluates a *string* argument as an expression — it never calls a
 * function-shaped string — so "el => el.value" would silently return undefined.
 * Compiling a real function here handles both forms, supports `await`, and
 * surfaces syntax errors before they reach the browser.
 */
function compile(
  expression: string,
  scoped: boolean,
): (...args: unknown[]) => Promise<unknown> {
  const trimmed = expression.trim();
  const build = (body: string) =>
    scoped ? new AsyncFunction('el', body) : new AsyncFunction(body);

  // Deciding "expression or function?" by pattern is unreliable — an IIFE like
  // "(() => x)()" reads as a function literal but is already a call. Evaluate
  // it, then call the result only if it actually turned out to be a function.
  try {
    return build(
      `const __result = (${trimmed});` +
        `return typeof __result === 'function' ? await __result(${scoped ? 'el' : ''}) : __result;`,
    );
  } catch {
    // Not a single expression — treat it as a statement body, so callers can
    // write "const x = f(); return x" or several statements in a row.
    try {
      return build(trimmed);
    } catch (error) {
      throw new OpError(`Could not parse the expression: ${(error as Error).message}`);
    }
  }
}

function serialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

const DEFAULT_STYLE_PROPS = [
  'display',
  'visibility',
  'opacity',
  'position',
  'z-index',
  'overflow',
  'width',
  'height',
  'color',
  'background-color',
  'font-size',
  'font-family',
];

export async function inspectElement(
  session: Session,
  target: Target,
  extraProps: string[] = [],
): Promise<string> {
  const locator = locate(session, target);
  const props = [...new Set([...DEFAULT_STYLE_PROPS, ...extraProps])];

  const info = await act(target, () =>
    locator.evaluate((el: Element, wanted: string[]) => {
      const style = getComputedStyle(el);
      const styles: Record<string, string> = {};
      for (const prop of wanted) styles[prop] = style.getPropertyValue(prop);
      const input = el as HTMLInputElement;
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        className: typeof el.className === 'string' ? el.className || undefined : undefined,
        attributes: Object.fromEntries(
          Array.from({ length: el.attributes.length }, (_, i) => el.attributes[i]!)
            .filter((a) => !['style', 'class', 'id'].includes(a.name))
            .slice(0, 20)
            .map((a) => [a.name, a.value]),
        ),
        styles,
        value: input.value ?? undefined,
        disabled: input.disabled ?? undefined,
        checked: input.checked ?? undefined,
      };
    }, props),
  );

  const box = await locator.boundingBox().catch(() => null);
  const lines = [
    `<${info.tag}${info.id ? ` id="${info.id}"` : ''}${info.className ? ` class="${info.className}"` : ''}>`,
    box
      ? `box: x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`
      : 'box: not rendered (element is hidden or detached)',
  ];
  if (info.value !== undefined) lines.push(`value: ${JSON.stringify(info.value)}`);
  if (info.disabled !== undefined) lines.push(`disabled: ${info.disabled}`);
  if (info.checked !== undefined) lines.push(`checked: ${info.checked}`);
  if (Object.keys(info.attributes).length) {
    lines.push(
      'attributes:',
      ...Object.entries(info.attributes).map(([k, v]) => `  ${k}="${v}"`),
    );
  }
  lines.push(
    'computed styles:',
    ...props.map((prop) => `  ${prop}: ${info.styles[prop] ?? '(unset)'}`),
  );
  return lines.join('\n');
}
