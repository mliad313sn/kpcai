/**
 * Keyboard of KP Studio in the terminal. The input line always takes printable keys;
 * actions use Ctrl so typing never triggers them. Ctrl+N and Ctrl+T turn the line into an
 * instruction or a redirect for the selected node; Esc goes back to the request line. A
 * confirmation takes over the keyboard and only y/o (yes) is a yes: anything else — n,
 * Esc, Enter — is the default No. A dispute (R-405) first takes a number to pick an
 * option; ] and [ (or the arrow and page keys) scroll the picked option, y then settles it
 * with that option once it was read to the end, anything else rejects (fail closed). A
 * memory proposal (ADR-0027) also takes r to reject it; No leaves it pending. Ctrl+E shows
 * the Enterprise summary (R-5E14), where Ctrl+X stops everything and Ctrl+U allows work
 * again.
 */
export type Action =
  | { kind: 'type'; text: string }
  | { kind: 'backspace' }
  | { kind: 'submit' }
  | { kind: 'run' }
  | { kind: 'discard' }
  | { kind: 'pauseResume' }
  | { kind: 'cancel' }
  | { kind: 'nextNode' }
  | { kind: 'diff' }
  | { kind: 'apply' }
  | { kind: 'instruct' }
  | { kind: 'redirect' }
  | { kind: 'escape' }
  | { kind: 'quit' }
  | { kind: 'confirm'; ok: boolean; reject?: true }
  | { kind: 'choose'; index: number }
  | { kind: 'scroll'; pages: 1 | -1 }
  | { kind: 'grade'; grade: 'good' | 'bad' }
  | { kind: 'enterprise' }
  | { kind: 'unkill' }
  | { kind: 'none' };

export interface KeyInfo {
  ctrl?: boolean;
  meta?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

const CTRL: Record<string, Action['kind']> = {
  r: 'run',
  d: 'discard',
  p: 'pauseResume',
  x: 'cancel',
  o: 'diff',
  a: 'apply',
  n: 'instruct',
  t: 'redirect',
  q: 'quit',
  c: 'quit',
  e: 'enterprise',
  u: 'unkill',
};

/** What a confirmation is about: plain yes/no, a dispute (options), a memory proposal. */
export type Confirming = boolean | 'dispute' | 'memory';

export function confirmAction(input: string, kind: Confirming = true, ctrl = false): Action {
  if (!ctrl && kind === 'dispute' && /^[1-9]$/.test(input))
    return { kind: 'choose', index: Number(input) - 1 };
  if (!ctrl && kind === 'memory' && /^r$/i.test(input))
    return { kind: 'confirm', ok: false, reject: true };
  return { kind: 'confirm', ok: !ctrl && /^[yo]$/i.test(input) };
}

const GRADES: Record<string, 'good' | 'bad'> = { g: 'good', b: 'bad' };

/** ] or ↓ or PgDn scrolls a picked dispute option down a window; [ or ↑ or PgUp up. */
function scrollAction(input: string, key: KeyInfo): Action | undefined {
  if (key.ctrl) return undefined;
  if (input === ']' || key.downArrow || key.pageDown) return { kind: 'scroll', pages: 1 };
  if (input === '[' || key.upArrow || key.pageUp) return { kind: 'scroll', pages: -1 };
  return undefined;
}

export function keyAction(input: string, key: KeyInfo, confirming: Confirming): Action {
  const scroll = confirming === 'dispute' ? scrollAction(input, key) : undefined;
  if (scroll) return scroll;
  if (confirming)
    return key.ctrl && input === 'c'
      ? { kind: 'quit' }
      : confirmAction(input, confirming, key.ctrl === true);
  if (key.ctrl) {
    const grade = GRADES[input.toLowerCase()];
    if (grade) return { kind: 'grade', grade };
    const kind = CTRL[input.toLowerCase()];
    return kind ? ({ kind } as Action) : { kind: 'none' };
  }
  if (key.return) return { kind: 'submit' };
  if (key.tab) return { kind: 'nextNode' };
  if (key.backspace || key.delete) return { kind: 'backspace' };
  if (key.escape) return { kind: 'escape' };
  if (key.meta || !input) return { kind: 'none' };
  // Drop control characters a paste may carry; keep the rest as typed.
  // eslint-disable-next-line no-control-regex
  const text = input.replace(/[\u0000-\u001f\u007f]/g, '');
  return text ? { kind: 'type', text } : { kind: 'none' };
}
