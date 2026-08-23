import type { Locator, Page } from 'playwright';

/**
 * Roles worth surfacing when the caller only wants things it can act on.
 * Matched against the role token at the start of an aria-snapshot line.
 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);

export interface ClipResult {
  text: string;
  truncated: boolean;
  totalChars: number;
}

function pagingNote(start: number, end: number, total: number): string {
  const notes: string[] = [];
  if (start > 0) notes.push(`${start} chars before`);
  if (end < total) notes.push(`${total - end} chars after`);
  if (!notes.length) return '';
  return (
    `\n…[showing chars ${start}-${end} of ${total}; ${notes.join(', ')}.` +
    (end < total ? ` Pass offset=${end} for the next section.]` : ']')
  );
}

/**
 * Truncates without promising pagination — for the outer safety cap, which also
 * covers tools that have no offset parameter to follow the advice with.
 */
export function clipHard(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const note = `\n…[truncated ${text.length - maxChars} chars]`;
  return text.slice(0, Math.max(0, maxChars - note.length)) + note;
}

/**
 * Windows `text` to `maxChars` starting at `offset`, annotating what was cut.
 * The note counts against the budget: if the result overran, an outer cap would
 * trim the note itself off the end and the stated offset would be wrong. Its
 * length is measured rather than guessed, since large offsets make it longer.
 */
export function clip(text: string, maxChars: number, offset = 0): ClipResult {
  const total = text.length;
  if (offset === 0 && total <= maxChars) {
    return { text, truncated: false, totalChars: total };
  }
  const start = Math.min(offset, total);
  // Reserve against the longest note this call could emit: every clause
  // present, every number at its widest. Probing with a guessed end
  // under-reserves whenever that guess lands on a shorter variant of the note.
  // The end offset appears twice in the note ("start-end" and "offset=end"),
  // so both occurrences need room to grow to their widest.
  const reserve = pagingNote(start, start, total).length + 2 * String(total).length;
  const room = Math.max(50, maxChars - reserve);
  const slice = text.slice(start, start + room);
  const end = start + slice.length;
  const suffix = pagingNote(start, end, total);
  // The floor above can still overshoot a budget too small to hold the note at
  // all. Nothing downstream may exceed maxChars, so enforce it here.
  const body = (slice + suffix).slice(0, maxChars);
  return { text: body, truncated: suffix.length > 0, totalChars: total };
}

export interface SnapshotOptions {
  /** Limit tree depth; keeps big dashboards from flooding the window. */
  depth?: number;
  /** Append [box=x,y,w,h] coordinates to each element. */
  boxes?: boolean;
  interactiveOnly?: boolean;
}

/**
 * Playwright's "ai" aria snapshot: a YAML accessibility tree where every
 * element carries a [ref=eN] handle that `aria-ref=eN` locators resolve.
 */
export async function ariaSnapshot(
  target: Page | Locator,
  options: SnapshotOptions = {},
): Promise<string> {
  const text = await target.ariaSnapshot({
    mode: 'ai',
    ...(options.depth !== undefined ? { depth: options.depth } : {}),
    ...(options.boxes ? { boxes: true } : {}),
  });
  return options.interactiveOnly ? filterInteractive(text) : text;
}

/**
 * Keeps only lines whose role is interactive, plus any ancestor lines needed
 * to keep the YAML indentation meaningful.
 */
export function filterInteractive(snapshot: string): string {
  const lines = snapshot.split('\n');
  const keep = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^\s*-\s+([a-z]+)/.exec(line);
    if (!match || !INTERACTIVE_ROLES.has(match[1]!)) continue;
    keep.add(i);
    // Walk outwards to retain the enclosing structure.
    let indent = leadingSpaces(line);
    for (let j = i - 1; j >= 0 && indent > 0; j--) {
      const candidate = leadingSpaces(lines[j]!);
      if (candidate < indent) {
        keep.add(j);
        indent = candidate;
      }
    }
    // Retain the element's own children (e.g. a link's text node).
    const own = leadingSpaces(line);
    for (let j = i + 1; j < lines.length && leadingSpaces(lines[j]!) > own; j++) {
      keep.add(j);
    }
  }

  const result = [...keep].sort((a, b) => a - b).map((i) => lines[i]!);
  return result.length ? result.join('\n') : '(no interactive elements found)';
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

/** Extracts the ref of the root element of a scoped snapshot. */
export function rootRef(snapshot: string): string | undefined {
  return /\[ref=([a-z0-9]+)\]/i.exec(snapshot)?.[1];
}

/** Compacts a snapshot line for query results: role, name, and state only. */
export function summarizeLine(line: string): string {
  return line.trim().replace(/^-\s*/, '');
}
