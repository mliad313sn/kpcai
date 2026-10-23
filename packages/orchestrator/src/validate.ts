import type { GraphNode } from '@kernelpai/core';

/**
 * Structural problems of a node list: duplicate ids, unknown or self dependencies,
 * cycles. Empty when the graph is a valid DAG.
 */
export function graphProblems(nodes: readonly GraphNode[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) problems.push(`duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (d === n.id) problems.push(`node "${n.id}" depends on itself`);
      else if (!ids.has(d)) problems.push(`node "${n.id}" depends on unknown node "${d}"`);
    }
  }
  if (problems.length === 0) {
    const cycle = findCycle(nodes);
    if (cycle) problems.push(`cycle: ${cycle.join(' → ')}`);
  }
  return problems;
}

/** A dependency cycle as a list of ids (first = last), or undefined. */
export function findCycle(nodes: readonly GraphNode[]): string[] | undefined {
  const deps = new Map(nodes.map((n) => [n.id, n.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      const found = visit(d);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const n of nodes) {
    const found = visit(n.id);
    if (found) return found;
  }
  return undefined;
}
