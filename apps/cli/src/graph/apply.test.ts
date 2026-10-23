import { describe, expect, it } from 'vitest';
import type { GraphResult, ProtocolResult, TaskGraph } from '@kernelpai/core';
import { collect } from './apply.js';
import { serialized } from '../io.js';

const DIFF = (f: string, line = 'hi') =>
  `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+${line}\n`;

function graphOf(results: Array<[string, Partial<ProtocolResult>]>): {
  g: TaskGraph;
  r: GraphResult;
} {
  const g = {
    id: 'g',
    request: 'r',
    createdBy: 'template',
    reason: '',
    nodes: results.map(([id]) => ({
      id,
      title: id,
      type: 'code_generation',
      protocol: 'author_critic',
      dependsOn: [],
      messages: [],
      criticality: 'normal',
    })),
  } as unknown as TaskGraph;
  const r = {
    graphId: 'g',
    ok: true,
    costUsd: 0,
    states: {},
    results: Object.fromEntries(
      results.map(([id, res]) => [
        id,
        { nodeId: id, protocol: 'author_critic', contributions: [], costUsd: 0, ok: true, ...res },
      ]),
    ),
  } as unknown as GraphResult;
  return { g, r };
}

describe('patch collection (review P2-F1, F4, F17)', () => {
  it('only takes patches whose critic approved them', () => {
    const { g, r } = graphOf([
      ['yes', { approved: true, output: DIFF('a.ts') }],
      ['no', { approved: false, output: DIFF('b.ts') }],
      ['unreviewed', { output: DIFF('c.ts') }],
      ['failed', { ok: false, approved: true, output: DIFF('d.ts') }],
    ]);
    expect(collect(g, r).patches.map((p) => p.nodeId)).toEqual(['yes']);
  });

  it('refuses patches with hidden control characters instead of cleaning them for display', () => {
    const { g, r } = graphOf([
      ['osc', { approved: true, output: DIFF('a.ts', '// tidy\u001b]0;x') + '+evil\u0007\n' }],
      ['bell', { approved: true, output: DIFF('b.ts', 'x\u0007') }],
      ['clean', { approved: true, output: DIFF('c.ts') }],
    ]);
    const { patches, refused } = collect(g, r);
    expect(patches.map((p) => p.nodeId)).toEqual(['clean']);
    expect(refused.map((p) => p.nodeId)).toEqual(['osc', 'bell']);
  });

  it('applies identical patches once', () => {
    const { g, r } = graphOf([
      ['a', { approved: true, output: DIFF('x.ts') }],
      ['b', { approved: true, output: DIFF('x.ts') }],
    ]);
    expect(collect(g, r).patches).toHaveLength(1);
  });
});

describe('serialized confirmations (review P2-F7)', () => {
  it('asks one question at a time, in order', async () => {
    const log: string[] = [];
    let release: (() => void) | undefined;
    const ask = serialized(async (q) => {
      log.push(`ask ${q}`);
      if (q === 'A') await new Promise<void>((r) => (release = r));
      log.push(`answer ${q}`);
      return true;
    });
    const a = ask('A');
    const b = ask('B');
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(['ask A']);
    release?.();
    await Promise.all([a, b]);
    expect(log).toEqual(['ask A', 'answer A', 'ask B', 'answer B']);
  });
});
