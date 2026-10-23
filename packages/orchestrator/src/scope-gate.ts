import {
  AuthorisedScopeSchema,
  describeScope,
  scopeJournalPayload,
  scopeProblems,
  type AuthorisedScope,
  type Pack,
} from '@kernelpai/packs';
import { OrchestrationError, type PlannedNode } from './types.js';

/** Outcome of the run-start scope check (WI-S4-02, audit F8). */
export interface ScopeCheck {
  ok: boolean;
  /** Ids of the selected packs that need an authorised scope. */
  required: string[];
  /** Why the run may not start; empty when `ok`. */
  problems: string[];
  /** The validated scope, when one is required and accepted. */
  scope?: AuthorisedScope;
  /** The boundary shown in every prompt (`describeScope` lines), when accepted. */
  boundary?: string;
}

/** Thrown by `GraphRunner.run` when a selected pack needs a scope that is missing or invalid. */
export class ScopeError extends OrchestrationError {
  constructor(
    readonly packs: string[],
    readonly problems: string[],
  ) {
    super(`run refused: ${problems.join('; ')}`);
    this.name = 'ScopeError';
  }
}

/**
 * Checks the authorised scope before anything runs. Every selected pack with
 * `safety.requiresScope` validates `scope` with `scopeProblems` (bounded, unexpired, in
 * kind). A node tagged with a pack that is not among `packs` is refused too: its safety
 * rules cannot be checked (fail closed). No pack needs a scope: ok, nothing shown.
 */
export function checkRunScope(
  packs: readonly Pack[],
  nodes: readonly PlannedNode[],
  scope: unknown,
  now: Date,
): ScopeCheck {
  const known = new Set(packs.map((p) => p.id));
  const problems = nodes.flatMap((n) =>
    n.pack !== undefined && !known.has(n.pack)
      ? [
          `node "${n.id}" comes from pack "${n.pack}", which is not loaded; its safety rules cannot be checked`,
        ]
      : [],
  );
  const needing = packs.filter((p) => p.safety.requiresScope);
  const required = needing.map((p) => p.id);
  for (const p of needing) problems.push(...scopeProblems(p, scope, now));
  if (problems.length > 0) return { ok: false, required, problems };
  if (needing.length === 0) return { ok: true, required, problems };
  const parsed = AuthorisedScopeSchema.parse(scope);
  return {
    ok: true,
    required,
    problems,
    scope: parsed,
    boundary: describeScope(parsed).join('\n'),
  };
}

/** Journal payloads of an accepted scope, one per pack that required it (no free-text notes). */
export function scopePayloads(
  packs: readonly Pack[],
  check: ScopeCheck,
): Record<string, unknown>[] {
  if (!check.scope) return [];
  const scope = check.scope;
  return packs
    .filter((p) => check.required.includes(p.id))
    .map((p) => scopeJournalPayload(p, scope));
}

/** Sets the runner-validated boundary on every node; a value carried by the graph is dropped. */
export function stampScope(nodes: PlannedNode[], boundary: string | undefined): void {
  for (const n of nodes) {
    delete n.authorisedScope;
    if (boundary !== undefined) n.authorisedScope = boundary;
  }
}
