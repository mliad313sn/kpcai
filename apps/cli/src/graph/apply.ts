import type { GraphResult, TaskGraph } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import { createToolBus } from '@kernelpai/tools';
import type { Io } from '../io.js';
import { sanitizeForTerminal } from '../sanitize.js';
import { extractPatches, patchFiles } from './patches.js';
import type { GraphOptions } from './setup.js';

const CODE_TYPES = new Set(['code_generation', 'test']);

/**
 * Patches from code and test nodes that succeeded and were approved by their critic
 * (principle 2). Shown always; applied only with `--apply`, through the tool bus
 * (`git.apply`: jailed to the workspace, `--check` first, write permission confirmed).
 */
export async function applyPatches(
  io: Io,
  journal: Journal,
  sessionId: string,
  graph: TaskGraph,
  result: GraphResult,
  o: GraphOptions,
): Promise<string> {
  const patches = collect(graph, result);
  if (patches.length === 0) return 'no patch';
  for (const p of patches) {
    io.err(`\n--- patch from ${p.nodeId} (${patchFiles(p.patch).join(', ') || 'unknown files'})\n`);
    io.err(sanitizeForTerminal(p.patch));
  }
  if (!o.apply) return `${patches.length} patch(es) shown, not applied (use --apply)`;
  const { bus } = await createToolBus({ journal, env: io.env });
  try {
    let applied = 0;
    for (const p of patches) {
      const r = await bus.call(
        { id: `apply-${p.nodeId}`, name: 'git.apply', input: { patch: p.patch } },
        {
          model: { provider: 'kernel', model: 'apply' },
          root: io.cwd,
          sessionId,
          nodeId: p.nodeId,
          confirm: (q) => (o.yes ? Promise.resolve(true) : io.confirm(q)),
        },
      );
      io.err(
        `${r.isError ? '✗' : '✓'} ${p.nodeId}: ${sanitizeForTerminal(r.content).slice(0, 300)}\n`,
      );
      if (!r.isError) applied++;
    }
    return `${applied}/${patches.length} patch(es) applied`;
  } finally {
    await bus.close();
  }
}

/** Approved patches of code/test nodes, without exact duplicates (two nodes may agree). */
function collect(graph: TaskGraph, r: GraphResult): Array<{ nodeId: string; patch: string }> {
  const seen = new Set<string>();
  const all = graph.nodes
    .filter((n) => CODE_TYPES.has(n.type))
    .filter((n) => r.results[n.id]?.ok === true && r.results[n.id]?.approved !== false)
    .flatMap((n) =>
      extractPatches(r.results[n.id]?.output ?? '').map((patch) => ({ nodeId: n.id, patch })),
    );
  return all.filter((p) => {
    if (seen.has(p.patch)) return false;
    seen.add(p.patch);
    return true;
  });
}
