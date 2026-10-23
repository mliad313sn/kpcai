import { describe, expect, it } from 'vitest';
import type { GraphEvent, TaskGraph } from '@kernelpai/core';
import { CompetenceRouter } from '@kernelpai/router';
import { estimateGraph } from './estimate.js';
import { GraphRunner } from './runner.js';
import { RoleAdapter, friendly, gnode, graph, setup, type Script } from './test-helpers/fakes.js';
import type { OrchestratorOptions } from './types.js';

/** Review P3-F8: a redirect is checked against the band top, as the graph cap is (D-021). */

const slowX: Script = (seen) =>
  seen.prompt.includes('Task (X)')
    ? [{ delay: 30 }, { text: 'A-x' }, { end: 'end' }]
    : friendly('A')(seen);

const chain = (): TaskGraph =>
  graph([gnode({ id: 'x', title: 'X' }), gnode({ id: 'y', title: 'Y', dependsOn: ['x'] })]);

function harness(over: Partial<OrchestratorOptions> = {}) {
  const a = new RoleAdapter('a', slowX, { analysis: 0.9 });
  const dear = new RoleAdapter('e', friendly('E'), {}, { inputPerMTok: 1000, outputPerMTok: 2000 });
  const s = setup([a, dear], over);
  const runner = new GraphRunner(s.options);
  let got: Promise<unknown> | undefined;
  s.options.onEvent = (e: GraphEvent) => {
    const startedX = e.type === 'node_state' && e.nodeId === 'x' && e.state === 'running';
    if (startedX && !e.ref && !got) got = runner.redirect('y', dear.ref);
  };
  const run = async () => {
    const r = await runner.run(chain());
    return { r, value: (await got) as { ok: boolean; reason?: string } };
  };
  return { ...s, dear, run };
}

/** Likely (expected) and worst (band top) cost of the chain with y on the dear model. */
function figures(): { likely: number; top: number } {
  const h = harness();
  const nodes = chain().nodes.map((n) => (n.id === 'y' ? { ...n, model: h.dear.ref } : n));
  const est = estimateGraph(
    { ...chain(), nodes },
    {
      router: new CompetenceRouter(),
      candidates: h.options.candidates,
      allowSameProvider: false,
      known: new Map(),
    },
  );
  return { likely: est.totalUsd, top: est.band.highUsd };
}

describe('P3-F8: redirect checked against the band top', () => {
  const { likely, top } = figures();
  // Between the two: the expected cost fits the cap, the band top does not.
  const cap = (likely + top) / 2;

  it('the fixture has a cap between the likely and the worst cost', () => {
    expect(likely).toBeLessThan(cap);
    expect(top).toBeGreaterThan(cap);
  });

  it('refuses without a hook when the band top exceeds maxGraphUsd', async () => {
    const h = harness({ maxGraphUsd: cap });
    const { r, value } = await h.run();
    expect(value.ok).toBe(false);
    expect(value.reason).toMatch(
      /^budget: graph total: up to \$[\d.]+ \(likely \$[\d.]+\) would exceed maxGraphUsd \$[\d.]+ \(redirect y to e\/m\)$/,
    );
    expect(r.results['y']?.contributions[0]?.ref.provider).toBe('a');
  });

  it('asks the hook with both figures, and applies the redirect on a yes', async () => {
    const labels: string[] = [];
    const h = harness({ maxGraphUsd: cap, budget: (_c, l) => (labels.push(l), true) });
    const { r, value } = await h.run();
    expect(value).toEqual({ ok: true });
    const asked = labels.find((l) => l.includes('(redirect y to e/m)'));
    const usd = (n: number) => `$${Number(n.toPrecision(3))}`;
    expect(asked).toBe(
      `graph total: up to ${usd(top)} (likely ${usd(likely)}) would exceed maxGraphUsd ${usd(cap)} (redirect y to e/m)`,
    );
    expect(r.results['y']?.contributions[0]?.ref).toEqual(h.dear.ref);
    const iv = h.journal.events().find((e) => e.payload['action'] === 'redirect');
    expect(iv?.payload).toMatchObject({ projectedUsd: likely, projectedHighUsd: top });
  });
});
