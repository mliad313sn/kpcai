import { TaskTypeSchema, type Criticality, type TaskType } from '@kernelpai/core';
import {
  GENERIC_PACK_ID,
  hintReason,
  pickPlanHint,
  type HintChoice,
  type NodeHint,
  type Pack,
} from '@kernelpai/packs';
import { MAX_CRITERION_CHARS, MAX_GUIDANCE_CHARS, MAX_REVIEW_CRITERIA, cap } from '../prompts.js';
import type { PlannedNode } from '../types.js';

/** A plan built from a pack's plan hint. */
export interface PackPlan {
  nodes: PlannedNode[];
  /** `pack <id>, plan "<title>" (matched …)`. */
  reason: string;
  choice: HintChoice;
}

/** A task type name resolved onto core: itself, or a pack's proposed type via `mapsTo`. */
export interface ResolvedTaskType {
  type: TaskType;
  /** The pack-proposed name, when `name` was not a core type. */
  proposed?: string;
  pack?: string;
}

/**
 * Maps a task type name onto core's enum (WI-S1-04 pending): a core type stays as it is;
 * a pack's `proposedTaskTypes` id becomes its `mapsTo` (first pack in order wins).
 * Undefined when neither knows the name. packages/core is not changed.
 */
export function resolveTaskType(
  packs: readonly Pack[],
  name: string,
): ResolvedTaskType | undefined {
  const core = TaskTypeSchema.safeParse(name);
  if (core.success) return { type: core.data };
  for (const p of packs) {
    const t = p.proposedTaskTypes.find((x) => x.id === name);
    if (t) return { type: t.mapsTo, proposed: t.id, pack: p.id };
  }
  return undefined;
}

/** Every pack-proposed type id with the core type it maps to (core names excluded). */
export function proposedTypeAliases(packs: readonly Pack[]): Map<string, TaskType> {
  const out = new Map<string, TaskType>();
  for (const p of packs) {
    for (const t of p.proposedTaskTypes) {
      if (!out.has(t.id) && !TaskTypeSchema.safeParse(t.id).success) out.set(t.id, t.mapsTo);
    }
  }
  return out;
}

/** The pack's proposed name for a node of this core type, when exactly one maps to it. */
export function proposedTypeFor(pack: Pack, type: TaskType): string | undefined {
  const hits = pack.proposedTaskTypes.filter((t) => t.mapsTo === type);
  return hits.length === 1 ? hits[0]?.id : undefined;
}

/**
 * Criticality after the packs: a pack that requires an authorised scope raises it to
 * `critical` (independent critic on every solo node). Packs never lower it.
 */
export function packCriticality(packs: readonly Pack[], base: Criticality): Criticality {
  return packs.some((p) => p.safety.requiresScope) ? 'critical' : base;
}

function criteriaOf(pack: Pack): string[] {
  return pack.reviewCriteria.slice(0, MAX_REVIEW_CRITERIA).map((c) => cap(c, MAX_CRITERION_CHARS));
}

/**
 * One planned node from a hint node. The user's request stays the node's message; the
 * pack instruction travels apart as `guidance` (quoted in prompts), so a pack file can
 * neither impersonate the user nor change protocol rules. Criticality comes from the
 * request (and `packCriticality`), never from the pack.
 */
function hintNode(pack: Pack, n: NodeHint, request: string, criticality: Criticality): PlannedNode {
  const node: PlannedNode = {
    id: n.id,
    title: n.title,
    type: n.type,
    protocol: n.protocol,
    dependsOn: [...n.dependsOn],
    criticality,
    messages: [{ role: 'user', content: request }],
    deliverable: n.deliverable,
    pack: pack.id,
  };
  if (n.tools.length > 0) node.tools = [...n.tools];
  if (n.instruction) node.guidance = cap(n.instruction, MAX_GUIDANCE_CHARS);
  const criteria = criteriaOf(pack);
  if (criteria.length > 0) node.reviewCriteria = criteria;
  const proposed = proposedTypeFor(pack, n.type);
  if (proposed) node.proposedType = proposed;
  return node;
}

function build(
  packs: readonly Pack[],
  choice: HintChoice,
  request: string,
  criticality: Criticality,
): PackPlan {
  const pack = packs.find((p) => p.id === choice.pack) as Pack;
  return {
    nodes: choice.hint.nodes.map((n) => hintNode(pack, n, request, criticality)),
    reason: hintReason(choice),
    choice,
  };
}

/** The best-matching domain pack plan (the generic pack excluded), if any cue matches. */
export function domainPackPlan(
  packs: readonly Pack[],
  request: string,
  criticality: Criticality,
): PackPlan | undefined {
  const domain = packs.filter((p) => p.id !== GENERIC_PACK_ID);
  const choice = pickPlanHint(domain, request);
  return choice && build(domain, choice, request, criticality);
}

/** The generic pack's plan, used only when no domain pack and no template fits. */
export function genericPackPlan(
  packs: readonly Pack[],
  request: string,
  criticality: Criticality,
): PackPlan | undefined {
  const generic = packs.filter((p) => p.id === GENERIC_PACK_ID);
  const choice = pickPlanHint(generic, request);
  return choice && build(generic, choice, request, criticality);
}
