import type { GraphResult, TaskGraph } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import { createToolBus } from '@kernelpai/tools';
import { kpaiHome } from '../context.js';
import type { Io } from '../io.js';
import { extractPatches, hasHiddenBytes, patchFiles } from './patches.js';
import type { GraphOptions } from './setup.js';

const CODE_TYPES = new Set(['code_generation', 'test']);

interface Patch {
  nodeId: string;
  patch: string;
}

/**
 * Patches from code and test nodes that succeeded **and were approved** by a critic from
 * another provider (principle 2, review P2-F4). A patch carrying control characters is
 * refused outright, so what the human reads is exactly what would be applied (P2-F1, F12).
 * Applied only with `--apply`, never after a cancel (P2-F6), through the tool bus; the
 * write is confirmed unless `--yes-apply` (P2-F15) — `--yes` alone never approves writes.
 */
export async function applyPatches(
  io: Io,
  journal: Journal,
  sessionId: string,
  graph: TaskGraph,
  result: GraphResult,
  o: GraphOptions & { cancelled?: boolean },
): Promise<string> {
  const { patches, refused } = collect(graph, result);
  for (const r of refused) {
    io.err(
      `\n✗ patch from ${r.nodeId} refused: it contains control characters that could hide content\n`,
    );
    journal.append({
      sessionId,
      type: 'intervention',
      nodeId: r.nodeId,
      payload: { action: 'patch refused: control characters' },
    });
  }
  if (patches.length === 0) return refused.length ? 'patches refused' : 'no patch';
  for (const p of patches) {
    io.err(`\n--- patch from ${p.nodeId} (${patchFiles(p.patch).join(', ') || 'unknown files'})\n`);
    io.err(p.patch);
  }
  if (o.cancelled) return `${patches.length} patch(es) shown, not applied (run cancelled)`;
  if (!o.apply) return `${patches.length} patch(es) shown, not applied (use --apply)`;
  return applyAll(io, journal, sessionId, patches, o);
}

async function applyAll(
  io: Io,
  journal: Journal,
  sessionId: string,
  patches: Patch[],
  o: GraphOptions,
): Promise<string> {
  // Same policy as the run: user forbidden zones from $KPAI_HOME/policy.json apply to writes too.
  const { bus } = await createToolBus({ kpaiHome: kpaiHome(io.env), journal, env: io.env });
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
          confirm: (q) => (o.yesApply ? Promise.resolve(true) : io.confirm(q)),
        },
      );
      io.err(`${r.isError ? '✗' : '✓'} ${p.nodeId}: ${r.content.slice(0, 300)}\n`);
      if (!r.isError) applied++;
    }
    return `${applied}/${patches.length} patch(es) applied`;
  } finally {
    await bus.close();
  }
}

/** Approved patches of code/test nodes, without exact duplicates; hidden-byte patches refused. */
export function collect(graph: TaskGraph, r: GraphResult): { patches: Patch[]; refused: Patch[] } {
  const seen = new Set<string>();
  const all = graph.nodes
    .filter((n) => CODE_TYPES.has(n.type))
    .filter((n) => r.results[n.id]?.ok === true && r.results[n.id]?.approved === true)
    .flatMap((n) =>
      extractPatches(r.results[n.id]?.output ?? '').map((patch) => ({ nodeId: n.id, patch })),
    );
  const unique = all.filter((p) => !seen.has(p.patch) && (seen.add(p.patch), true));
  return {
    patches: unique.filter((p) => !hasHiddenBytes(p.patch)),
    refused: unique.filter((p) => hasHiddenBytes(p.patch)),
  };
}
