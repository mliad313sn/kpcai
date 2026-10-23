/**
 * Keyboard of KP Studio in the terminal. The input line always takes printable keys;
 * actions use Ctrl so typing never triggers them. Ctrl+N and Ctrl+T turn the line into an
 * instruction or a redirect for the selected node; Esc goes back to the request line. A
 * confirmation takes over the keyboard and only y/o (yes) is a yes: anything else — n,
 * Esc, Enter — is the default No.
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
  | { kind: 'confirm'; ok: boolean }
  | { kind: 'none' };

export interface KeyInfo {
  ctrl?: boolean;
  meta?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
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
};

export function confirmAction(input: string): Action {
  return { kind: 'confirm', ok: /^[yo]$/i.test(input) };
}

export function keyAction(input: string, key: KeyInfo, confirming: boolean): Action {
  if (confirming) return key.ctrl && input === 'c' ? { kind: 'quit' } : confirmAction(input);
  if (key.ctrl) {
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
