// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authProtocols,
  forgetToken,
  isLocalWsUrl,
  isValidToken,
  readConnectionSettings,
  rememberToken,
} from './token';

const loc = (hash: string, host = '127.0.0.1:4100', protocol = 'http:') =>
  ({ hash, host, protocol, pathname: '/', search: '?x=1' }) as Location;

beforeEach(() => sessionStorage.clear());

describe('connection settings', () => {
  it('reads the token and ws url from the fragment, then removes the fragment', () => {
    const history = { replaceState: vi.fn() } as unknown as History;
    const s = readConnectionSettings(
      loc('#token=abcdef123456&ws=ws://127.0.0.1:9999/rpc'),
      history,
    );
    expect(s).toEqual({ token: 'abcdef123456', url: 'ws://127.0.0.1:9999/rpc' });
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/?x=1');
    expect(sessionStorage.getItem('kp-studio.token')).toBe('abcdef123456');
  });

  it('falls back to the stored token and the same-origin url', () => {
    rememberToken('stored-token-1');
    expect(readConnectionSettings(loc(''))).toEqual({
      token: 'stored-token-1',
      url: 'ws://127.0.0.1:4100/rpc',
    });
    forgetToken();
    expect(readConnectionSettings(loc('', '', 'https:'))).toEqual({
      token: undefined,
      url: 'wss://127.0.0.1/rpc',
    });
  });

  it('rejects malformed tokens and non-loopback ws urls', () => {
    const s = readConnectionSettings(loc('#token=a b<c>&ws=ws://evil.example/rpc'));
    expect(s.token).toBeUndefined();
    expect(s.url).toBe('ws://127.0.0.1:4100/rpc');
    expect(isValidToken('short')).toBe(false);
    expect(isLocalWsUrl('ws://localhost:1/x')).toBe(true);
    expect(isLocalWsUrl('ws://[::1]:1/x')).toBe(true);
    expect(isLocalWsUrl('http://127.0.0.1/')).toBe(false);
    expect(isLocalWsUrl('not a url')).toBe(false);
  });

  it('builds the subprotocol list', () => {
    expect(authProtocols('tok')).toEqual(['kernelpai.v1', 'kernelpai.bearer.tok']);
  });

  it('survives storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const rm = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => rememberToken('abcdefgh1')).not.toThrow();
    expect(() => forgetToken()).not.toThrow();
    spy.mockRestore();
    rm.mockRestore();
  });
});
