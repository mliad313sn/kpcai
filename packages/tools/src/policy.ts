import path from 'node:path';
import {
  refToString,
  type PermissionDecision,
  type PermissionPolicy,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
  type ToolRisk,
} from '@kernelpai/core';
import { canonicalSync, matchesForbidden, toPosixRel } from './paths.js';

export interface GradedPolicyOptions {
  /**
   * Per-model deny list (spec §3.3): key `provider/model`, `provider/*` or `*`;
   * value: tool-name globs (`shell.*`, `mcp.github.*`, `*`).
   */
  denyByModel?: Readonly<Record<string, readonly string[]>>;
  /** Forbidden path globs (spec §6, deepened in phase 6): any matching path is refused. */
  forbiddenPaths?: readonly string[];
  /** Prepend {@link DEFAULT_FORBIDDEN_PATHS} (default true; principle 5). */
  defaultForbiddenPaths?: boolean;
  /** Case-insensitive path matching (default: on Windows only). */
  caseInsensitive?: boolean;
}

/**
 * Credential files that never reach a model through a tool (review P2-F10).
 * A glob without `/` matches a path segment at any depth; `x/**` also matches `x`.
 */
export const DEFAULT_FORBIDDEN_PATHS: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_ed25519*',
  '**/.aws/**',
  '**/.ssh/**',
  '**/.gnupg/**',
  '.npmrc',
  '.netrc',
  '**/credentials*',
  '**/*secret*',
];

/** The policy in force, for `kpai tools` / the console to show. */
export interface ActivePolicy {
  forbiddenPaths: string[];
  denyByModel: Record<string, string[]>;
  /** Write confirmations are remembered per session + node + model + root. */
  batchScope: string;
}

/** Optional hook the bus calls after a human said yes, so a batch is confirmed once. */
export interface ConfirmAwarePolicy extends PermissionPolicy {
  confirmed(def: ToolDefinition, call: ToolCall, ctx: ToolContext): void;
  /** Why the last `deny` was decided for this call (journaled). */
  reason?(def: ToolDefinition, call: ToolCall, ctx: ToolContext): string | undefined;
}

export function isConfirmAware(p: PermissionPolicy): p is ConfirmAwarePolicy {
  return typeof (p as Partial<ConfirmAwarePolicy>).confirmed === 'function';
}

const PATH_KEYS = new Set(['path', 'paths', 'from', 'to', 'file', 'files', 'target', 'cwd', 'dir']);
const DIFF_KEYS = new Set(['diff', 'patch']);

/** File paths named in a unified diff's headers (`--- a/x`, `+++ b/x`, `diff --git a/x b/y`). */
export function diffPaths(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    const m = /^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/.exec(line);
    if (m && m[1] !== '/dev/null') out.push(m[1] as string);
    const g = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (g) out.push(g[1] as string, g[2] as string);
    const r = /^rename (?:from|to) (\S+)/.exec(line);
    if (r) out.push(r[1] as string);
  }
  return out;
}

/**
 * A shell argument that could name one file: no whitespace, quotes or shell
 * punctuation, not a bare flag. `--opt=value` yields its value. Free text such as
 * a `node -e` script is not a path (matching it against globs denied innocent
 * scripts on Windows, where matching is case-insensitive: `*secret*` vs
 * `AWS_SECRET_ACCESS_KEY`); unsandboxed shell calls are confirmed by a human anyway.
 */
export function shellPathArg(arg: string): string | undefined {
  const value = /^--?[A-Za-z0-9][\w-]*=(.*)$/s.exec(arg)?.[1] ?? arg;
  if (value === '' || (value === arg && arg.startsWith('-'))) return undefined;
  return /^[^\s'"`$;|&<>(){}[\]*?!^%=,]+$/.test(value) ? value : undefined;
}

/** Paths a call names: path-like fields, diff headers, and path-like shell arguments. */
export function pathsInCall(call: ToolCall): string[] {
  const input = call.input as Record<string, unknown> | null;
  if (!input || typeof input !== 'object') return [];
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(add);
  };
  for (const [k, v] of Object.entries(input)) {
    if (PATH_KEYS.has(k)) add(v);
    if (DIFF_KEYS.has(k) && typeof v === 'string') out.push(...diffPaths(v));
  }
  if (call.name === 'shell.run' && Array.isArray(input.args)) {
    for (const a of input.args) {
      const p = typeof a === 'string' ? shellPathArg(a) : undefined;
      if (p !== undefined) out.push(p);
    }
  }
  return out;
}

/**
 * Root-relative forms of a path to test against forbidden globs: the lexical one
 * and the canonical one, so an in-root symlink to `.env` is caught too.
 */
function relForms(root: string, p: string): string[] {
  const base = path.resolve(root);
  const abs = path.resolve(base, p.replace(/\\/g, '/'));
  // Canonical form even for paths that do not exist yet: realpath of the deepest
  // existing ancestor, so root aliases (/var vs /private/var, 8.3 names) agree.
  const real = toPosixRel(path.relative(canonicalSync(base), canonicalSync(abs)));
  return [toPosixRel(path.relative(base, abs)), real];
}

/** Tool-name glob: `*` matches any run of characters, dots included (`mcp.github.*`). */
function toolGlob(glob: string): RegExp {
  const body = glob.split('*').map((s) => s.replace(/[|{}()[\]^$+?.\\]/g, '\\$&'));
  return new RegExp(`^${body.join('.*')}$`);
}

/** Canonical root, so trust given for `/var/ws` also covers `/private/var/ws`. */
function rootKey(root: string): string {
  return canonicalSync(root);
}

function scopeKey(...parts: string[]): string {
  return parts.join('\u0000');
}

/**
 * Spec §3.3 graded permissions: read → allow; write → confirm once per batch
 * (session + node + model), unless trusted for this session on this root; destructive →
 * confirm every call. Per-model deny and forbidden paths refuse outright.
 */
export class GradedPermissionPolicy implements ConfirmAwarePolicy {
  private readonly trusted = new Set<string>();
  private readonly batches = new Set<string>();
  private readonly deny: { model: string; globs: string[]; tools: RegExp[] }[];
  private readonly forbidden: readonly string[];
  private readonly icase: boolean;

  constructor(options: GradedPolicyOptions = {}) {
    this.deny = Object.entries(options.denyByModel ?? {}).map(([model, tools]) => ({
      model,
      globs: [...tools],
      tools: tools.map(toolGlob),
    }));
    const defaults = options.defaultForbiddenPaths === false ? [] : DEFAULT_FORBIDDEN_PATHS;
    this.forbidden = [...new Set([...defaults, ...(options.forbiddenPaths ?? [])])];
    this.icase = options.caseInsensitive ?? process.platform === 'win32';
  }

  describe(): ActivePolicy {
    return {
      forbiddenPaths: [...this.forbidden],
      denyByModel: Object.fromEntries(this.deny.map((d) => [d.model, [...d.globs]])),
      batchScope: 'session + node + model + root',
    };
  }

  decide(def: ToolDefinition, call: ToolCall, ctx: ToolContext): PermissionDecision {
    if (this.reason(def, call, ctx) !== undefined) return 'deny';
    if (def.risk === 'read') return 'allow';
    if (def.risk === 'destructive') return 'confirm';
    if (this.trusted.has(scopeKey(ctx.sessionId, rootKey(ctx.root), 'write'))) return 'allow';
    return this.batches.has(this.batchKey(ctx)) ? 'allow' : 'confirm';
  }

  reason(def: ToolDefinition, call: ToolCall, ctx: ToolContext): string | undefined {
    if (this.modelDenied(def.name, refToString(ctx.model))) {
      return `tool ${def.name} is denied for model ${refToString(ctx.model)}`;
    }
    const hit = pathsInCall(call).find((p) =>
      relForms(ctx.root, p).some((rel) => matchesForbidden(rel, this.forbidden, this.icase)),
    );
    return hit === undefined ? undefined : `path is in a forbidden zone: ${hit}`;
  }

  trust(scope: { sessionId: string; root: string; risk: Exclude<ToolRisk, 'destructive'> }): void {
    this.trusted.add(scopeKey(scope.sessionId, rootKey(scope.root), scope.risk));
  }

  confirmed(def: ToolDefinition, _call: ToolCall, ctx: ToolContext): void {
    if (def.risk === 'write') this.batches.add(this.batchKey(ctx));
  }

  /** A write batch is one node of one session, for one model (review P2-F14). */
  private batchKey(ctx: ToolContext): string {
    return scopeKey(ctx.sessionId, ctx.nodeId, refToString(ctx.model), rootKey(ctx.root));
  }

  private modelDenied(tool: string, model: string): boolean {
    const provider = model.split('/')[0] ?? '';
    return this.deny.some(
      (d) =>
        (d.model === '*' || d.model === model || d.model === `${provider}/*`) &&
        d.tools.some((re) => re.test(tool)),
    );
  }
}
