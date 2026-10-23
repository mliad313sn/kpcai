/**
 * Connection settings from the URL fragment: `#token=…&ws=ws://127.0.0.1:port/…`. The
 * fragment never reaches a server or a Referer; it is removed from the address bar once
 * read, and the token is kept in sessionStorage (this tab only) so a reload reconnects.
 */
const KEY = 'kp-studio.token';
const TOKEN_RE = /^[A-Za-z0-9._~-]{8,512}$/;

/** Browsers cannot set an Authorization header on a WebSocket: the bearer token rides as a
 * second subprotocol, the first one names the protocol (agreed with packages/server). */
export function authProtocols(token: string): string[] {
  return ['kernelpai.v1', `kernelpai.bearer.${token}`];
}

export function isValidToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export interface ConnectionSettings {
  token: string | undefined;
  url: string;
}

function storage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function rememberToken(token: string): void {
  try {
    storage()?.setItem(KEY, token);
  } catch {
    /* private mode: the token lives in memory only */
  }
}

export function forgetToken(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

function defaultUrl(loc: Location): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host || '127.0.0.1'}/rpc`;
}

/** Only loopback WebSocket URLs are accepted: the console never talks to the network. */
export function isLocalWsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === 'ws:' || u.protocol === 'wss:') &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    );
  } catch {
    return false;
  }
}

export function readConnectionSettings(loc: Location, history?: History): ConnectionSettings {
  const params = new URLSearchParams(loc.hash.replace(/^#/, ''));
  const fromHash = params.get('token') ?? undefined;
  const ws = params.get('ws') ?? undefined;
  if (loc.hash && history) history.replaceState(null, '', loc.pathname + loc.search);
  let token: string | undefined;
  if (fromHash && isValidToken(fromHash)) {
    token = fromHash;
    rememberToken(token);
  } else {
    const stored = storage()?.getItem(KEY) ?? undefined;
    token = stored && isValidToken(stored) ? stored : undefined;
  }
  const url = ws && isLocalWsUrl(ws) ? ws : defaultUrl(loc);
  return { token, url };
}
