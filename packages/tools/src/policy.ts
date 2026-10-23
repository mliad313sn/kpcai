import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  refToString,
  type PermissionDecision,
  type PermissionPolicy,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
  type ToolRisk,
} from '@kernelpai/core';
import { keynoteProbe } from './keynote.js';
import { canonicalSync, toPosixRel } from './paths.js';
import {
  DEFAULT_ZONES,
  defaultCaseInsensitive,
  relaxationFor,
  zoneGlobs,
  zoneHit,
  type ZoneEntry,
  type ZoneRelaxation,
  type ZoneSet,
} from './zones.js';
import { buildZoneSet, type PackZonePlan } from './zone-set.js';

export interface GradedPolicyOptions {
  /**
   * Per-model deny list (spec §3.3): key `provider/model`, `provider/*` or `*`;
   * value: tool-name globs (`shell.*`, `mcp.github.*`, `*`).
   */
  denyByModel?: Readonly<Record<string, readonly string[]>>;
  /** Extra forbidden path globs from the caller (spec §6): any matching path is refused. */
  forbiddenPaths?: readonly string[];
  /** Forbidden path globs from `$KPAI_HOME/policy.json` (kept apart for their origin). */
  policyForbiddenPaths?: readonly string[];
  /** Zone additions and approved relaxations from the user's enabled packs (pack-zones.ts). */
  packZones?: PackZonePlan;
  /**
   * Include the relaxable name heuristics (default true). The credential tier is
   * always in force: nothing turns it off (principle 5, WI-S7-01).
   */
  defaultForbiddenPaths?: boolean;
  /** Case-insensitive path matching (default: on Windows only). */
  caseInsensitive?: boolean;
}

/**
 * The default zones as one flat list: the immovable credential tier, then the two
 * relaxable name heuristics (see zones.ts for both tiers and their exemptions).
 * A glob without `/` matches a path segment at any depth; `x/**` also matches `x`.
 */
export const DEFAULT_FORBIDDEN_PATHS: readonly string[] = DEFAULT_ZONES;

/** The policy in force, for `kpai tools` / the console to show. */
export interface ActivePolicy {
  /** Every forbidden glob in force (flat; see `zones` for tier and origin). */
  forbiddenPaths: string[];
  /** Each zone with its tier (credential / heuristic / added) and origin. */
  zones: ZoneEntry[];
  /** Pack relaxations in force (heuristic tier only), each journaled when applied. */
  relaxations: ZoneRelaxation[];
  denyByModel: Record<string, string[]>;
  /** Write confirmations are remembered per session + node + model + root. */
  batchScope: string;
}

/** Optional hook the bus calls after a human said yes, so a batch is confirmed once. */
export interface ConfirmAwarePolicy extends PermissionPolicy {
  confirmed(def: ToolDefinition, call: ToolCall, ctx: ToolContext): void;
  /** Why the last `deny` was decided for this call (journaled). */
  reason?(def: ToolDefinition, call: ToolCall, ctx: ToolContext): string | undefined;
  /** Paths a permitted call reaches only through a pack relaxation (journaled). */
  relaxedPaths?(call: ToolCall, ctx: ToolContext): { path: string; pack: string; allow: string }[];
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
  // A `file:` URL names a file too (browser.open).
  if (typeof input.url === 'string' && /^file:/i.test(input.url)) {
    try {
      out.push(fileURLToPath(input.url));
    } catch {
      out.push(input.url);
    }
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

function zoneLabel(z: ZoneEntry): string {
  if (z.tier === 'credential') return 'credential file, cannot be relaxed';
  const from = z.origin === 'default' ? 'default name heuristic' : `added by ${z.origin}`;
  return z.tier === 'heuristic' ? `${from} ${z.glob}; a domain pack can exempt a folder` : from;
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
  private readonly zones: ZoneSet;

  constructor(options: GradedPolicyOptions = {}) {
    this.deny = Object.entries(options.denyByModel ?? {}).map(([model, tools]) => ({
      model,
      globs: [...tools],
      tools: tools.map(toolGlob),
    }));
    this.zones = buildZoneSet({
      heuristics: options.defaultForbiddenPaths !== false,
      policyPaths: options.policyForbiddenPaths ?? [],
      callerPaths: options.forbiddenPaths ?? [],
      packs: options.packZones,
      caseInsensitive: options.caseInsensitive ?? defaultCaseInsensitive(),
    });
  }

  /** The effective zones, shared with the git tools and workspace helpers. */
  zoneSet(): ZoneSet {
    return this.zones;
  }

  describe(): ActivePolicy {
    return {
      forbiddenPaths: zoneGlobs(this.zones),
      zones: this.zones.entries.map((e) => ({ ...e })),
      relaxations: this.zones.relaxed.map((r) => ({ ...r })),
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
    const probe = keynoteProbe(ctx.root);
    for (const p of pathsInCall(call)) {
      for (const rel of relForms(ctx.root, p)) {
        const z = zoneHit(rel, this.zones, probe);
        if (z !== undefined) return `path is in a forbidden zone: ${p} (${zoneLabel(z)})`;
      }
    }
    return undefined;
  }

  /** Paths of a permitted call that only an approved pack relaxation let through (journaled). */
  relaxedPaths(call: ToolCall, ctx: ToolContext): { path: string; pack: string; allow: string }[] {
    const out: { path: string; pack: string; allow: string }[] = [];
    for (const p of pathsInCall(call)) {
      const r = relForms(ctx.root, p)
        .map((rel) => relaxationFor(rel, this.zones))
        .find((x) => x !== undefined);
      if (r) out.push({ path: p, pack: r.pack, allow: r.allow });
    }
    return out;
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
