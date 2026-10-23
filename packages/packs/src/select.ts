import type { Criticality, GraphNode } from '@kernelpai/core';
import type { Pack, PlanHint } from './schema.js';

/** Lower case, accents removed, so "Rétro-ingénierie" matches "retro-ingenierie". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matches(request: string, cue: string): boolean {
  const c = fold(cue).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${c}(?:$|[^a-z0-9])`).test(request);
}

export interface HintChoice {
  pack: string;
  hint: PlanHint;
  /** The cues found in the request, for the plan's reason line. */
  cues: string[];
}

/**
 * The plan hint of the active packs whose cues best match the request (most cues wins;
 * ties keep pack order). Undefined when no cue matches: the default planner applies.
 */
export function pickPlanHint(packs: readonly Pack[], request: string): HintChoice | undefined {
  const r = fold(request);
  let best: HintChoice | undefined;
  for (const pack of packs) {
    for (const hint of pack.plans) {
      const cues = hint.when.filter((w) => matches(r, w));
      if (cues.length > (best?.cues.length ?? 0)) best = { pack: pack.id, hint, cues };
    }
  }
  return best;
}

/**
 * Turns a hint into task-graph nodes with today's core types (proposal for S4,
 * WI-S4-01). Each node gets the request, prefixed by the node's instruction.
 */
export function hintToNodes(
  hint: PlanHint,
  request: string,
  criticality: Criticality = 'normal',
): GraphNode[] {
  return hint.nodes.map((n) => {
    const content = n.instruction ? `${n.instruction}\n\nRequest:\n${request}` : request;
    const node: GraphNode = {
      id: n.id,
      title: n.title,
      type: n.type,
      protocol: n.protocol,
      dependsOn: [...n.dependsOn],
      criticality,
      messages: [{ role: 'user', content }],
    };
    if (n.tools.length > 0) node.tools = [...n.tools];
    return node;
  });
}

/** One reason line for the plan header. */
export function hintReason(choice: HintChoice): string {
  return `pack ${choice.pack}, plan "${choice.hint.title}" (matched ${choice.cues.join(', ')})`;
}
