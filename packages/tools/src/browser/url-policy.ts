/**
 * Which URLs the driven browser may load (spec phase 5, ADR-0032): loopback http(s) and
 * `file:` URLs inside the workspace (outside forbidden zones) by default; another origin
 * only when it is on the allow-list AND a person confirmed it for this browser session.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalSync, isInside, toPosixRel } from '../paths.js';
import { ToolError } from '../types.js';
import { zoneHit, type ZoneSet } from '../zones.js';

export type UrlKind = 'loopback' | 'file' | 'listed';

export interface ClassifiedUrl {
  kind: UrlKind;
  url: URL;
  /** `scheme://host:port` (http) or `file://` */
  origin: string;
}

/** `localhost`, `*.localhost`, 127.0.0.0/8 and `[::1]`, by name only (never resolved). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
}

/** Origins as written in the allow-list (`https://docs.example.com`), normalised. */
export function normaliseOrigins(list: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of list) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.add(u.origin);
    } catch {
      // An entry that is not a URL allows nothing.
    }
  }
  return out;
}

export function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new ToolError(`not a URL: ${raw.slice(0, 200)}`);
  }
}

/** Classifies a URL a model asked to open; refuses what is neither local nor listed. */
export function classifyUrl(raw: string, listed: ReadonlySet<string>): ClassifiedUrl {
  const url = parseUrl(raw);
  if (url.protocol === 'file:') return { kind: 'file', url, origin: 'file://' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError(`browser: only http(s) and file URLs can be opened, not ${url.protocol}`);
  }
  if (url.username || url.password)
    throw new ToolError('browser: URLs with credentials are refused');
  if (isLoopbackHost(url.hostname)) return { kind: 'loopback', url, origin: url.origin };
  if (listed.has(url.origin)) return { kind: 'listed', url, origin: url.origin };
  throw new ToolError(
    `browser: ${url.origin} is not a local address and not on the browser allow-list; only loopback and workspace files open by default`,
  );
}

/**
 * Why a `file:` URL may not be loaded, or undefined when it is a file inside the workspace
 * and outside every forbidden zone (symlinks resolved).
 */
export function fileProblem(
  url: URL,
  root: string,
  zones: ZoneSet | undefined,
): string | undefined {
  let p: string;
  try {
    p = fileURLToPath(url);
  } catch {
    return 'not a local file URL';
  }
  const realRoot = canonicalSync(root);
  const real = canonicalSync(p);
  if (!isInside(realRoot, real)) return `file is outside the workspace: ${p}`;
  const rel = toPosixRel(path.relative(realRoot, real));
  const z = zones ? zoneHit(rel, zones) : undefined;
  return z ? `file is in a forbidden zone: ${rel}` : undefined;
}
