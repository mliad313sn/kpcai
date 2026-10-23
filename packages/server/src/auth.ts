/**
 * Who may talk to the kernel server: a bearer token (WebSocket subprotocol for browsers,
 * Authorization header for other clients), a loopback Host header (DNS-rebinding defence)
 * and an Origin allow-list (cross-site WebSocket hijacking defence). ADR-0019.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { BEARER_PREFIX } from '@kernelpai/kernel/protocol';

/** 32 random bytes, base64url: valid in a subprotocol token and in a URL fragment. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison (hashes first so lengths never leak). */
export function sameToken(a: string, b: string): boolean {
  const h = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(h(a), h(b));
}

/** The bearer token a client presented, from its subprotocols or Authorization header. */
export function presentedToken(req: IncomingMessage): string | undefined {
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((s) => s.trim());
  const sub = protocols.find((p) => p.startsWith(BEARER_PREFIX));
  if (sub) return sub.slice(BEARER_PREFIX.length);
  const auth = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
  return auth?.[1];
}

export function hasValidToken(req: IncomingMessage, token: string): boolean {
  const given = presentedToken(req);
  return given !== undefined && sameToken(given, token);
}

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

/** Host header names this server, on loopback (a rebound domain name is refused). */
export function isLoopbackHost(host: string | undefined, port: number): boolean {
  return host !== undefined && LOOPBACK_NAMES.some((n) => host === `${n}:${port}`);
}

/** The server's own origins plus extra ones (a dev server, the desktop shell). */
export function allowedOrigins(port: number, extra: readonly string[] = []): Set<string> {
  return new Set([...LOOPBACK_NAMES.map((n) => `http://${n}:${port}`), ...extra]);
}

/**
 * Browsers always send Origin on a WebSocket handshake; it must be allowed. Clients that
 * are not browsers send none, and are held to the token alone.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  return origin === undefined || allowed.has(origin);
}
