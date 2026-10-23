/** Command-bar grammar (spec §4.3): natural language, `/command`, `@file`, `#node`, `!`. */

import { t, type Key } from '../i18n/core';

export const COMMANDS = [
  { name: 'plan' },
  { name: 'run' },
  { name: 'stats' },
  { name: 'sessions' },
  { name: 'tools' },
  { name: 'help' },
] as const;

const HINTS: Record<(typeof COMMANDS)[number]['name'], Key> = {
  plan: 'command.hint.plan',
  run: 'command.hint.run',
  stats: 'command.hint.stats',
  sessions: 'command.hint.sessions',
  tools: 'command.hint.tools',
  help: 'command.hint.help',
};

export function commandHint(name: (typeof COMMANDS)[number]['name']): string {
  return t(HINTS[name]);
}
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

/** The `/help` text, in the current language; one line per entry. */
export function helpText(): string {
  return [
    t('help.intro'),
    '',
    t('help.commandBar'),
    ...COMMANDS.map((c) => `  /${c.name.padEnd(9)} ${commandHint(c.name)}`),
    `  @file     ${t('help.file')}`,
    `  #node     ${t('help.node')}`,
    `  !text     ${t('help.terminal')}`,
    '',
    t('help.keyboard'),
    `  Ctrl+K    ${t('help.palette')}`,
    `  /         ${t('help.focusCommand')}`,
    `  Alt+1..5  ${t('help.focusZone')}`,
    `  Escape    ${t('help.escape')}`,
    `  ${t('help.arrowsKey')}    ${t('help.arrows')}`,
  ].join('\n');
}
