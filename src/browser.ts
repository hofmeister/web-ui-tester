import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';

/**
 * Playwright pins one Chromium revision per release. When the installed browser
 * comes from a different Playwright version — common in prebuilt containers —
 * the default lookup fails even though a perfectly usable binary is on disk.
 * This finds it.
 */
function browserRoots(): string[] {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured === '0') return [];
  if (configured) return [configured];

  // Playwright's default per-user cache, which is where an install lands when
  // PLAYWRIGHT_BROWSERS_PATH is unset — the most common case of all.
  const home = homedir();
  if (process.platform === 'darwin') return [join(home, 'Library/Caches/ms-playwright')];
  if (process.platform === 'win32') {
    return [join(process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'ms-playwright')];
  }
  return [join(process.env.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright')];
}

function findInstalledChromium(headless: boolean): string | undefined {
  for (const root of browserRoots()) {
    const found = findUnder(root, headless);
    if (found) return found;
  }
  return undefined;
}

function findUnder(root: string, headless: boolean): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }

  // Layouts differ per platform, so each candidate is probed rather than
  // assumed — returning a path that does not exist would replace Playwright's
  // actionable "run npx playwright install" message with a confusing one.
  const shell = ['chrome-linux/headless_shell', 'chrome-mac/headless_shell'];
  const full = [
    'chrome-linux/chrome',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-win/chrome.exe',
  ];
  // Prefer the headless shell for headless runs; it is smaller and faster.
  const candidates = headless
    ? [
        { prefix: 'chromium_headless_shell-', bins: shell },
        { prefix: 'chromium-', bins: full },
      ]
    : [{ prefix: 'chromium-', bins: full }];

  for (const { prefix, bins } of candidates) {
    const installs = entries
      .filter((entry) => entry.startsWith(prefix) && /\d+$/.test(entry))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
    for (const install of installs) {
      for (const bin of bins) {
        const candidate = join(root, install, bin);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

export interface LaunchOptions {
  headless: boolean;
  executablePath?: string;
  /**
   * Expose the launched browser's DevTools protocol on this local port, so other
   * CDP clients (another MCP server, a script) can drive the same browser.
   * 0 picks a free port; undefined keeps it private.
   */
  cdpPort?: number;
}

export interface BrowserHandle {
  browser: Browser;
  /** HTTP endpoint of the browser's DevTools protocol, when it has one reachable. */
  cdpEndpoint?: string;
}

export async function launchBrowser(options: LaunchOptions): Promise<BrowserHandle> {
  const { headless, executablePath } = options;
  const args = ['--disable-dev-shm-usage'];
  let cdpEndpoint: string | undefined;
  if (options.cdpPort !== undefined) {
    const port = await pickPort(options.cdpPort);
    // Loopback only: anyone who can reach this port owns the browser.
    args.push(`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1');
    cdpEndpoint = `http://127.0.0.1:${port}`;
  }
  const withEndpoint = (browser: Browser): BrowserHandle => ({ browser, cdpEndpoint });

  if (executablePath) {
    return withEndpoint(await chromium.launch({ headless, executablePath, args }));
  }

  try {
    return withEndpoint(await chromium.launch({ headless, args }));
  } catch (error) {
    const fallback = findInstalledChromium(headless);
    if (fallback) {
      return withEndpoint(await chromium.launch({ headless, executablePath: fallback, args }));
    }

    // No Playwright browser at all — the usual case for the Claude Desktop
    // extension, which has no install step. Google Chrome or Microsoft Edge,
    // installed the normal way, drive just as well.
    for (const channel of SYSTEM_BROWSER_CHANNELS) {
      try {
        return withEndpoint(await chromium.launch({ headless, channel, args }));
      } catch {
        // not installed; try the next one
      }
    }
    throw new Error(
      `Could not launch Chromium: ${(error as Error).message}\n` +
        'Install Google Chrome or Microsoft Edge, run "npx playwright install chromium", ' +
        'or point WUT_EXECUTABLE_PATH at an existing Chromium binary.',
    );
  }
}

/**
 * Attaches to a Chrome/Chromium that is already running with remote debugging
 * enabled. Accepts the HTTP endpoint (http://127.0.0.1:9222) or a browser
 * WebSocket URL (ws://…/devtools/browser/…).
 */
export async function connectBrowser(endpoint: string): Promise<BrowserHandle> {
  const url = /^[a-z]+:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
  try {
    const browser = await chromium.connectOverCDP(url, { timeout: 10_000 });
    return { browser, cdpEndpoint: url };
  } catch (error) {
    throw new Error(
      `Could not connect to Chrome over CDP at ${url}: ${(error as Error).message}\n` +
        'Start Chrome with remote debugging enabled, e.g.\n' +
        '  chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug\n' +
        'Chrome 136 and newer ignore --remote-debugging-port on the default profile, ' +
        'so --user-data-dir must point somewhere else.',
    );
  }
}

/** The requested port when it is free, otherwise any free one. */
async function pickPort(preferred: number): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<number | undefined>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(undefined));
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        const bound = typeof address === 'object' && address ? address.port : undefined;
        server.close(() => resolve(bound));
      });
    });
  if (preferred > 0) {
    const bound = await tryListen(preferred);
    if (bound) return bound;
  }
  const bound = await tryListen(0);
  if (!bound) throw new Error('Could not find a free port for the DevTools protocol.');
  return bound;
}

/** Installed browsers tried, in order, when Playwright has no Chromium of its own. */
const SYSTEM_BROWSER_CHANNELS = ['chrome', 'msedge'] as const;
