import { describe, expect, it } from 'vitest';
import { helpText, parseInput, tokenAtCaret, tokens } from './commands';
import { formatDuration, formatRange, formatScore, formatUsd } from './format';

describe('command bar grammar', () => {
  it('parses commands, unknown commands and empty input', () => {
    expect(parseInput('  ')).toEqual({ kind: 'empty' });
    expect(parseInput('/PLAN add tests')).toEqual({
      kind: 'command',
      name: 'plan',
      arg: 'add tests',
    });
    expect(parseInput('/stats')).toEqual({ kind: 'command', name: 'stats', arg: '' });
    expect(parseInput('/frobnicate')).toEqual({ kind: 'unknown_command', name: 'frobnicate' });
  });

  it('extracts @file and #node tokens, and marks ! requests', () => {
    const p = parseInput('fix @src/a.ts and @src/a.ts after #impl, see a@b.c');
    expect(p).toMatchObject({
      kind: 'request',
      files: ['src/a.ts'],
      nodes: ['impl'],
      terminal: false,
    });
    expect(parseInput('!ls -la')).toMatchObject({
      kind: 'request',
      text: '!ls -la',
      terminal: true,
    });
    expect(tokens('#a #b #a', '#')).toEqual(['a', 'b']);
  });

  it('finds the token being typed', () => {
    expect(tokenAtCaret('/pl', 3)).toEqual({ sigil: '/', prefix: 'pl', start: 0 });
    expect(tokenAtCaret('do #im', 6)).toEqual({ sigil: '#', prefix: 'im', start: 3 });
    expect(tokenAtCaret('see @', 5)).toEqual({ sigil: '@', prefix: '', start: 4 });
    expect(tokenAtCaret('a /b', 4)).toBeUndefined();
    expect(tokenAtCaret('plain', 5)).toBeUndefined();
  });

  it('documents every command', () => {
    for (const c of ['/plan', '/run', '/stats', '/sessions', '/tools', '/help', 'Ctrl+K'])
      expect(helpText()).toContain(c);
  });
});

describe('formatting', () => {
  it('formats money, ranges, durations and scores', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(Number.NaN)).toBe('$?');
    expect(formatRange(0.1, 0.1)).toBe('$0.10');
    expect(formatRange(0.1, 0.4)).toBe('$0.10–$0.40');
    expect(formatDuration(-1)).toBe('–');
    expect(formatDuration(5_400)).toBe('5s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
    expect(formatScore(undefined)).toBe('—');
    expect(formatScore(0.826)).toBe('0.83');
  });
});
