import { existsSync, readdirSync } from 'node:fs';
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

export async function launchBrowser(
  headless: boolean,
  executablePath?: string,
): Promise<Browser> {
  const args = ['--disable-dev-shm-usage'];
  if (executablePath) {
    return chromium.launch({ headless, executablePath, args });
  }

  try {
    return await chromium.launch({ headless, args });
  } catch (error) {
    const fallback = findInstalledChromium(headless);
    if (!fallback) {
      throw new Error(
        `Could not launch Chromium: ${(error as Error).message}\n` +
          'Install it with "npx playwright install chromium", or point ' +
          'WUT_EXECUTABLE_PATH at an existing Chromium binary.',
      );
    }
    return chromium.launch({ headless, executablePath: fallback, args });
  }
}
