import { describe, expect, it } from 'vitest';
import type { GraphEvent } from '../rpc/schemas';
import { MAX_STREAM_CHARS, applyEvent, applyResult, newRun, streamKey } from './reducer';

const A = { provider: 'anthropic', model: 'a' };
const B = { provider: 'openai', model: 'b' };

function play(events: GraphEvent[], times: number[] = []) {
  return events.reduce((r, e, i) => applyEvent(r, e, times[i] ?? i * 1000), newRun('r1', 'req', 0));
}

describe('run reducer', () => {
  it('tracks node state, model, step start and end', () => {
    const r = play(
      [
        { type: 'node_state', nodeId: 'n', state: 'running', ref: A, role: 'author' },
        { type: 'node_state', nodeId: 'n', state: 'running', ref: A, role: 'author' },
        {
          type: 'node_state',
          nodeId: 'n',
          state: 'review',
          ref: B,
          role: 'critic',
          score: 0.7,
          reason: 'best critic',
        },
        { type: 'node_state', nodeId: 'n', state: 'done' },
      ],
      [10, 20, 30, 40],
    );
    expect(r.nodes.n).toMatchObject({
      state: 'done',
      ref: B,
      role: 'critic',
      startedAt: 10,
      stepStartedAt: 30,
      endedAt: 40,
      score: 0.7,
      reason: 'best critic',
    });
  });

  it('streams text and replaces it with the contribution, summing costs', () => {
    const r = play([
      { type: 'text', nodeId: 'n', role: 'solo', ref: A, delta: 'Hel' },
      { type: 'text', nodeId: 'n', role: 'solo', ref: A, delta: 'lo' },
    ]);
    expect(r.nodes.n?.streams[streamKey('solo', A)]).toBe('Hello');
    const done = applyEvent(
      r,
      {
        type: 'contribution',
        nodeId: 'n',
        contribution: { role: 'solo', ref: A, text: 'Hello', costUsd: 0.1 },
      },
      5,
    );
    const again = applyEvent(
      done,
      {
        type: 'contribution',
        nodeId: 'n',
        contribution: { role: 'critic', ref: B, text: 'ok', costUsd: 0.2 },
      },
      6,
    );
    expect(again.nodes.n?.streams).toEqual({});
    expect(again.nodes.n?.costUsd).toBe(0.3);
    expect(again.costUsd).toBe(0.3);
    const fin = applyEvent(again, { type: 'graph_done', costUsd: 0.31, ok: true }, 7);
    expect(fin).toMatchObject({ ok: true, costUsd: 0.31 });
  });

  it('keeps only the tail of a very long stream', () => {
    const big = 'x'.repeat(MAX_STREAM_CHARS);
    const r = play([
      { type: 'text', nodeId: 'n', role: 'solo', ref: A, delta: big },
      { type: 'text', nodeId: 'n', role: 'solo', ref: A, delta: 'END' },
    ]);
    const s = r.nodes.n!.streams[streamKey('solo', A)]!;
    expect(s).toHaveLength(MAX_STREAM_CHARS);
    expect(s.endsWith('END')).toBe(true);
  });

  it('folds the final result into the nodes', () => {
    const run = newRun('r', 'q', 0);
    const r = applyResult(run, {
      ok: false,
      results: {
        a: { output: 'out', approved: false },
        b: { error: 'boom' },
        c: null,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.nodes.a).toMatchObject({ output: 'out', approved: false });
    expect(r.nodes.b?.error).toBe('boom');
    expect(r.nodes.c).toBeUndefined();
    expect(applyResult(run, null)).toBe(run);
    expect(applyResult(run, { results: {} }).ok).toBeUndefined();
  });
});
