/** Command-bar grammar (spec §4.3): natural language, `/command`, `@file`, `#node`, `!`. */

export const COMMANDS = [
  { name: 'plan', hint: 'Plan a request and show its graph and cost before anything runs' },
  { name: 'run', hint: 'Run the plan on screen (or plan the text first)' },
  { name: 'stats', hint: 'Journal metrics: cost, fallbacks, latency' },
  { name: 'sessions', hint: 'Refresh the sessions list in the explorer' },
  { name: 'tools', hint: 'Tools the models may call' },
  { name: 'help', hint: 'Keyboard shortcuts and command-bar syntax' },
] as const;
export type CommandName = (typeof COMMANDS)[number]['name'];

export type ParsedInput =
  | { kind: 'empty' }
  | { kind: 'command'; name: CommandName; arg: string }
  | { kind: 'unknown_command'; name: string }
  | { kind: 'request'; text: string; files: string[]; nodes: string[]; terminal: boolean };

const isCommand = (n: string): n is CommandName => COMMANDS.some((c) => c.name === n);

/** `@path` and `#node` tokens (letters, digits and `._/-:`), deduplicated in order. */
export function tokens(text: string, sigil: '@' | '#'): string[] {
  const re = sigil === '@' ? /(?:^|\s)@([\w./:-]+)/g : /(?:^|\s)#([\w.:-]+)/g;
  return [...new Set([...text.matchAll(re)].map((m) => m[1]!))];
}

export function parseInput(raw: string): ParsedInput {
  const text = raw.trim();
  if (!text) return { kind: 'empty' };
  if (text.startsWith('/')) {
    const [head = '', ...rest] = text.slice(1).split(/\s+/);
    const name = head.toLowerCase();
    if (!isCommand(name)) return { kind: 'unknown_command', name };
    return { kind: 'command', name, arg: rest.join(' ') };
  }
  return {
    kind: 'request',
    // Phase 3: `!` only marks the request as a terminal one; it is sent to the planner as is.
    text,
    files: tokens(text, '@'),
    nodes: tokens(text, '#'),
    terminal: text.startsWith('!'),
  };
}

/** The token being typed at the caret, for suggestions: `@pa` → { sigil: '@', prefix: 'pa' }. */
export function tokenAtCaret(
  text: string,
  caret: number,
): { sigil: '/' | '@' | '#'; prefix: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)([@#/])([\w./:-]*)$/.exec(before);
  if (!m) return undefined;
  const sigil = m[1] as '/' | '@' | '#';
  if (sigil === '/' && before.trimStart().indexOf('/') !== 0) return undefined;
  return { sigil, prefix: m[2]!, start: caret - m[2]!.length - 1 };
}

export const HELP_TEXT = [
  'Type a request in plain language and press Enter: KP Studio plans it first and shows',
  'the graph and the cost range. Nothing runs until you press Run.',
  '',
  'Command bar',
  ...COMMANDS.map((c) => `  /${c.name.padEnd(9)} ${c.hint}`),
  '  @file     reference a file or folder',
  '  #node     reference a node of the current graph',
  '  !text     terminal request (phase 3 sends it to the planner; phase 5 runs it)',
  '',
  'Keyboard',
  '  Ctrl+K    command palette          /         focus the command bar',
  '  Alt+1..5  focus a zone             Escape    close a dialog (answers No)',
  '  Arrows    resize a focused splitter, move between tabs and graph nodes',
].join('\n');
