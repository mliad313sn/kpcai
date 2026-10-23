import { describe, expect, it } from 'vitest';
import { keyAction } from './keys';
import { locate, parseArgs, wsUrlOf } from './locate';

describe('terminal keys', () => {
  it('types printable text and maps Ctrl actions', () => {
    expect(keyAction('a', {}, false)).toEqual({ kind: 'type', text: 'a' });
    expect(keyAction('a\u0007b', {}, false)).toEqual({ kind: 'type', text: 'ab' });
    expect(keyAction('\u0007', {}, false)).toEqual({ kind: 'none' });
    expect(keyAction('', { return: true }, false)).toEqual({ kind: 'submit' });
    expect(keyAction('', { backspace: true }, false)).toEqual({ kind: 'backspace' });
    expect(keyAction('', { tab: true }, false)).toEqual({ kind: 'nextNode' });
    expect(keyAction('', { escape: true }, false)).toEqual({ kind: 'escape' });
    expect(keyAction('', { meta: true }, false)).toEqual({ kind: 'none' });
    expect(keyAction('o', { ctrl: true }, false)).toEqual({ kind: 'diff' });
    expect(keyAction('a', { ctrl: true }, false)).toEqual({ kind: 'apply' });
    expect(keyAction('n', { ctrl: true }, false)).toEqual({ kind: 'instruct' });
    expect(keyAction('t', { ctrl: true }, false)).toEqual({ kind: 'redirect' });
    expect(keyAction('r', { ctrl: true }, false)).toEqual({ kind: 'run' });
    expect(keyAction('z', { ctrl: true }, false)).toEqual({ kind: 'none' });
    expect(keyAction('q', { ctrl: true }, false)).toEqual({ kind: 'quit' });
  });

  it('answers confirmations: only y or o is a yes', () => {
    expect(keyAction('y', {}, true)).toEqual({ kind: 'confirm', ok: true });
    expect(keyAction('O', {}, true)).toEqual({ kind: 'confirm', ok: true });
    expect(keyAction('', { return: true }, true)).toEqual({ kind: 'confirm', ok: false });
    expect(keyAction('n', {}, true)).toEqual({ kind: 'confirm', ok: false });
    expect(keyAction('r', { ctrl: true }, true)).toEqual({ kind: 'confirm', ok: false });
    expect(keyAction('c', { ctrl: true }, true)).toEqual({ kind: 'quit' });
  });
});

describe('locating the server', () => {
  it('reads flags, refuses non-loopback URLs, falls back to server.json', () => {
    expect(
      parseArgs(['--url', 'ws://127.0.0.1:1/rpc', '--token', 'abcdefgh1', '--lang', 'fr', '-h']),
    ).toEqual({
      url: 'ws://127.0.0.1:1/rpc',
      token: 'abcdefgh1',
      lang: 'fr',
      help: true,
    });
    expect(locate({ help: false, url: 'ws://evil.example/rpc', token: 'abcdefgh1' }, {})).toEqual({
      ok: false,
      reason: 'badUrl',
    });
    expect(locate({ help: false, url: 'ws://127.0.0.1:9/rpc', token: 'abcdefgh1' }, {})).toEqual({
      ok: true,
      url: 'ws://127.0.0.1:9/rpc',
      token: 'abcdefgh1',
    });
    expect(locate({ help: false, url: 'ws://127.0.0.1:9/rpc' }, {})).toMatchObject({ ok: false });
    expect(locate({ help: false }, { KPAI_HOME: '/nonexistent-kpai-home' })).toEqual({
      ok: false,
      reason: 'noServer',
    });
    expect(wsUrlOf('http://127.0.0.1:4321')).toBe('ws://127.0.0.1:4321/rpc');
  });
});
