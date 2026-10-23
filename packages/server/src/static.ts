/** Serves the built KP Studio (apps/studio/dist): read-only, inside its folder, strict headers. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export const CSP = [
  "default-src 'self'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const NOT_BUILT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>KP Studio</title></head>
<body><h1>KP Studio is not built</h1><p>Run <code>pnpm --filter @kernelpai/studio build</code>, then start <code>kpai studio</code> again.</p></body></html>`;

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(body);
}

/** The file a URL path maps to inside `root`, or undefined when it would leave it. */
export function resolveInside(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const base = resolve(root);
  const full = resolve(base, `.${sep}${normalize(decoded)}`);
  return full === base || full.startsWith(base + sep) ? full : undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, root?: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
    return;
  }
  const index = root ? join(root, 'index.html') : undefined;
  if (!root || !index || !existsSync(index)) {
    send(res, 200, TYPES['.html'] as string, NOT_BUILT);
    return;
  }
  const path = resolveInside(root, req.url ?? '/');
  if (!path) {
    send(res, 400, 'text/plain; charset=utf-8', 'bad path');
    return;
  }
  // Paths without an extension belong to the single-page app.
  const file = isFile(path) ? path : extname(path) === '' ? index : undefined;
  if (!file) {
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  send(res, 200, type, req.method === 'HEAD' ? '' : readFileSync(file));
}
