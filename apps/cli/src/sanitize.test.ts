import { describe, expect, it } from 'vitest';
import { sanitizeForTerminal } from './sanitize.js';

describe('sanitizeForTerminal', () => {
  it('removes clipboard writes, screen clears and colours but keeps text, newlines, tabs', () => {
    const evil = 'ok\u001b]52;c;cm0gLXJmIH4=\u0007\u001b[2J\u001b[31mred\u001b[0m\tend\n';
    expect(sanitizeForTerminal(evil)).toBe('okred\tend\n');
  });

  it('removes 8-bit controls, DCS strings, bells and backspaces', () => {
    expect(
      sanitizeForTerminal('a\u009b2Jb\u0090x\u001bPq#0\u001b\\c\u0007d\u0008e\u009d0;t\u009cf'),
    ).toBe('abxcdef');
  });

  it('leaves ordinary unicode alone', () => {
    expect(sanitizeForTerminal('héllo — 你好 🚀')).toBe('héllo — 你好 🚀');
  });
});
