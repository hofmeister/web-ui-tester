import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';

/**
 * Playwright pins one Chromium revision per release. When the installed browser
 * comes from a different Playwright version — common in prebuilt containers —
 * the default lookup fails even though a perfectly usable binary is on disk.
 * This finds it.
 */
function findInstalledChromium(headless: boolean): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || root === '0') return undefined;

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
