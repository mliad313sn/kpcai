/**
 * What a dispute option looks like in the terminal (R-405, P4-F11). An option is chosen
 * only once every line of it has been on screen: options are quoted a few lines each, the
 * picked one is shown in a window the user scrolls with ] and [ (or the arrow and page
 * keys), and y settles it only after its last line was shown. An option the kernel marks
 * `truncated` was cut before it reached the console: it can never be chosen.
 */

/** Lines of an unpicked option shown in the list. */
export const MAX_QUOTE = 6;
/** Lines of the picked option shown at once. */
export const WINDOW = 12;
/** A very long line is cut into pieces of this many characters, so a window stays bounded. */
const MAX_WIDTH = 200;

/** The display lines of a quoted text: one per line, long lines in pieces. */
export function quoteLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= MAX_WIDTH) out.push(line);
    else for (let i = 0; i < line.length; i += MAX_WIDTH) out.push(line.slice(i, i + MAX_WIDTH));
  }
  return out;
}

/** The first line shown after scrolling by `pages` windows (clamped to the text). */
export function scrolled(top: number, pages: number, total: number): number {
  const last = Math.max(0, total - WINDOW);
  return Math.min(last, Math.max(0, top + pages * WINDOW));
}

/** How many lines from the top have been shown once the window starts at `top`. */
export function shownTo(top: number, total: number): number {
  return Math.min(total, top + WINDOW);
}

/** Why the picked option cannot be chosen yet, or undefined when it can. */
export function notReady(
  option: { text: string; truncated?: boolean },
  seen: number,
): 'truncated' | 'unread' | undefined {
  if (option.truncated === true) return 'truncated';
  return seen < quoteLines(option.text).length ? 'unread' : undefined;
}
