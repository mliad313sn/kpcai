import { mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KernelError } from '@kernelpai/kernel';
import { ProviderError } from '@kernelpai/core';
import {
  hasValidToken,
  isAllowedOrigin,
  allowedOrigins,
  newToken,
  presentedToken,
  sameToken,
} from './auth.js';
import { ConfirmBroker } from './confirm-broker.js';
import { RpcError, toRpcError } from './handlers.js';
import { readServerFile, removeServerFile, writeServerFile } from './server-file.js';
import { resolveInside } from './static.js';

const req = (headers: Record<string, string>): IncomingMessage => ({ headers }) as IncomingMessage;

describe('auth', () => {
  it('reads the token from the subprotocol or the Authorization header', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      presentedToken(req({ 'sec-websocket-protocol': `kernelpai.v1, kernelpai.bearer.${t}` })),
    ).toBe(t);
    expect(hasValidToken(req({ authorization: `Bearer ${t}` }), t)).toBe(true);
    expect(hasValidToken(req({ authorization: 'Bearer nope' }), t)).toBe(false);
    expect(hasValidToken(req({}), t)).toBe(false);
    expect(sameToken('a', 'ab')).toBe(false);
  });

  it('allows the server origins, configured extras and non-browser clients only', () => {
    const allowed = allowedOrigins(5000, ['tauri://localhost']);
    expect(isAllowedOrigin('http://localhost:5000', allowed)).toBe(true);
    expect(isAllowedOrigin('tauri://localhost', allowed)).toBe(true);
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5001', allowed)).toBe(false);
  });
});

describe('confirm broker', () => {
  it('declines at once with no client, for an oversized patch, and on shutdown', async () => {
    const none = new ConfirmBroker(() => 0, 10_000);
    expect(await none.ask({ kind: 'tool', question: 'q' })).toBe(false);
    const sent: unknown[] = [];
    const one = new ConfirmBroker((_n, p) => (sent.push(p), 1), 10_000);
    expect(await one.ask({ kind: 'patch', question: 'q', patch: 'x'.repeat(2_000_001) })).toBe(
      false,
    );
    const pending = one.ask({ kind: 'tool', question: 'y'.repeat(20_000), risk: 'destructive' });
    expect(one.waiting).toBe(1);
    expect((sent[0] as { question: string }).question).toHaveLength(10_000);
    one.declineAll();
    expect(await pending).toBe(false);
    expect(one.answer('nope', true)).toBe(false);
  });
});

describe('errors, server file, static paths', () => {
  it('maps kernel and provider errors to JSON-RPC codes', () => {
    expect(toRpcError(new KernelError('budget', 'b'))).toEqual({ code: -32002, message: 'b' });
    expect(toRpcError(new ProviderError('unavailable', 'kernel', 'p')).code).toBe(-32003);
    expect(toRpcError(new RpcError(-1, 'x'))).toEqual({ code: -1, message: 'x' });
    expect(toRpcError('boom')).toEqual({ code: -32603, message: 'boom' });
  });

  it('reads only a valid server.json and removes only its own', () => {
    const home = mkdtempSync(join(tmpdir(), 'kpai-sf-'));
    expect(readServerFile(home)).toBeUndefined();
    const info = { protocol: 1, url: 'u', port: 1, pid: 1, token: 'a', startedAt: 't' };
    writeServerFile(home, info);
    removeServerFile(home, 'other');
    expect(readServerFile(home)).toEqual(info);
    writeFileSync(join(home, 'server.json'), '{"bad":1}');
    expect(readServerFile(home)).toBeUndefined();
  });

  it('keeps every path inside the UI folder', () => {
    // Platform paths: on Windows '/srv/ui' resolves on the current drive.
    expect(resolveInside('/srv/ui', '/a/b.js')).toBe(resolve('/srv/ui/a/b.js'));
    expect(resolveInside('/srv/ui', '/../../etc/passwd')).toBe(resolve('/srv/ui/etc/passwd'));
    expect(resolveInside('/srv/ui', '/a%00b')).toBeUndefined();
  });
});
