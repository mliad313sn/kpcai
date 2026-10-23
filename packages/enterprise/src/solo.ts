/**
 * A one-node, read-only graph: a single critique step with no tool, for the charter critic
 * (S10 R10) and the gate's independent review (ADR-0031 §5). Whatever the template planner
 * would make of the text, a reviewer writes nothing and reviews once.
 */
import type { Plan } from '@kernelpai/kernel';

export function soloGraph(plan: Plan, title: string, request: string) {
  const node = {
    id: 'review',
    title,
    type: 'critique',
    protocol: 'solo',
    dependsOn: [],
    criticality: 'normal',
    messages: [{ role: 'user', content: request }],
  };
  return { ...plan.graph, nodes: [node] };
}
