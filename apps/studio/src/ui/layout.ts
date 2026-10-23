/** Execution-thread layout: nodes in dependency columns (column = longest path from a root). */
import type { GraphNode } from '../rpc/schemas';

export function columns(nodes: readonly GraphNode[]): GraphNode[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const visit = (n: GraphNode, path: Set<string>): number => {
    const known = depth.get(n.id);
    if (known !== undefined) return known;
    path.add(n.id);
    let d = 0;
    for (const id of n.dependsOn) {
      const dep = byId.get(id);
      // Unknown or cyclic dependencies do not move the node (the kernel rejects cycles).
      if (dep && !path.has(id)) d = Math.max(d, visit(dep, path) + 1);
    }
    path.delete(n.id);
    depth.set(n.id, d);
    return d;
  };
  const cols: GraphNode[][] = [];
  for (const n of nodes) (cols[visit(n, new Set())] ??= []).push(n);
  return cols.filter((c) => c !== undefined);
}

/** Keyboard navigation in the graph: arrows move within and across columns. */
export function neighbour(
  cols: readonly GraphNode[][],
  id: string,
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight',
): string | undefined {
  const c = cols.findIndex((col) => col.some((n) => n.id === id));
  if (c < 0) return undefined;
  const r = cols[c]!.findIndex((n) => n.id === id);
  if (key === 'ArrowUp') return cols[c]![r - 1]?.id;
  if (key === 'ArrowDown') return cols[c]![r + 1]?.id;
  const next = cols[key === 'ArrowLeft' ? c - 1 : c + 1];
  return next?.[Math.min(r, next.length - 1)]?.id;
}
