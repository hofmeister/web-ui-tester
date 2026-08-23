import { readdirSync } from 'node:fs';
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

  // Prefer the headless shell for headless runs; it is smaller and faster.
  const candidates = headless
    ? [
        { prefix: 'chromium_headless_shell-', bin: 'chrome-linux/headless_shell' },
        { prefix: 'chromium-', bin: 'chrome-linux/chrome' },
      ]
    : [{ prefix: 'chromium-', bin: 'chrome-linux/chrome' }];

  for (const { prefix, bin } of candidates) {
    const matches = entries
      .filter((entry) => entry.startsWith(prefix) && /\d+$/.test(entry))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
    const newest = matches[0];
    if (newest) return join(root, newest, bin);
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
