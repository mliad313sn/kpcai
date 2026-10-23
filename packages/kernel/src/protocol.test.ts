import { describe, expect, it } from 'vitest';
import { Methods, Notifications, isMethod, parseParams, parseResult } from './protocol.js';

describe('console protocol', () => {
  it('knows its methods and rejects others', () => {
    expect(isMethod('run.start')).toBe(true);
    expect(isMethod('toString')).toBe(false);
    expect(isMethod('shell.exec')).toBe(false);
    expect(Object.keys(Methods)).toContain('run.redirect');
  });

  it('validates params', () => {
    expect(parseParams('plan', { request: 'x' })).toMatchObject({ ok: true });
    expect(parseParams('plan', { request: '' })).toMatchObject({ ok: false });
    expect(
      parseParams('run.redirect', { runId: 'r', nodeId: 'n', to: { provider: 'p', model: 'm' } }),
    ).toMatchObject({ ok: true });
    expect(parseParams('confirm.answer', { confirmId: 'c' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/ok/),
    });
    expect(parseParams('plan', { request: 'x', options: { profile: 'cheap' } })).toMatchObject({
      ok: false,
    });
  });

  it('validates notifications', () => {
    expect(
      Notifications['confirm.request'].safeParse({
        confirmId: 'c',
        kind: 'tool',
        question: 'q',
        risk: 'write',
        timeoutMs: 1000,
      }).success,
    ).toBe(true);
    expect(Notifications['run.state'].safeParse({ runId: 'r', state: 'sleeping' }).success).toBe(
      false,
    );
  });
});

describe('protocol results and extensions (ADR-0019)', () => {
  it('validates the results clients depend on', async () => {
    const { parseResult } = await import('./protocol.js');
    expect(parseResult('run.start', { runId: 'r' })).toMatchObject({ ok: true });
    expect(parseResult('run.start', {})).toMatchObject({ ok: false });
    expect(
      parseResult('providers.list', {
        providers: [{ id: 'p', available: true, models: [{ id: 'm', extra: 1 }] }],
      }),
    ).toMatchObject({ ok: true, value: { providers: [{ models: [{ extra: 1 }] }] } });
    expect(
      parseResult('sessions.list', { sessions: [{ id: 's', createdAt: 't', title: 'x' }] }),
    ).toMatchObject({ ok: true });
    const estimate = {
      nodes: [
        {
          nodeId: 'n',
          protocol: 'solo',
          ref: null,
          minUsd: 0,
          expectedUsd: 0,
          reason: 'r',
          score: 1,
        },
      ],
      minUsd: 0,
      totalUsd: 0,
      complete: true,
      problems: [],
      band: { lowUsd: 0, highUsd: 1, basis: 'heuristic' },
    };
    const graph = { id: 'g', request: 'r', nodes: [], createdBy: 'template', reason: '' };
    expect(parseResult('plan', { planId: 'p', graph, estimate })).toMatchObject({ ok: true });
  });

  it('carries routing data, tokens, patches and control events', async () => {
    const { parseNotification, parseParams } = await import('./protocol.js');
    const ev = { type: 'contribution', nodeId: 'n', usage: { inputTokens: 1, outputTokens: 2 } };
    expect(parseNotification('run.event', { runId: 'r', event: ev })).toMatchObject({
      ok: true,
      value: { event: { usage: { outputTokens: 2 } } },
    });
    expect(parseNotification('run.event', { runId: 'r', event: { nodeId: 'n' } }).ok).toBe(false);
    expect(
      parseNotification('confirm.request', {
        confirmId: 'c',
        kind: 'patch',
        question: 'q',
        patch: 'diff',
        timeoutMs: 1,
      }),
    ).toMatchObject({ ok: true, value: { patch: 'diff' } });
    expect(parseNotification('run.control', { runId: 'r', event: { type: 'run_paused' } }).ok).toBe(
      true,
    );
    expect(parseParams('run.instruct', { runId: 'r', nodeId: 'n', text: '' }).ok).toBe(false);
    expect(parseParams('plan.validate', { planId: 'p', graph: { nodes: [] } }).ok).toBe(false);
    expect(
      parseParams('run.start', {
        request: 'x',
        planId: 'p',
        graph: { nodes: [{ id: 'a', model: { provider: 'p', model: 'm' } }] },
      }).ok,
    ).toBe(true);
  });
});

describe('protocol: deliverables (WI-S1-02)', () => {
  it('round-trips a node deliverable in plans and edited graphs; refuses unknown kinds', () => {
    const node = { id: 'n', title: 'T', dependsOn: [], deliverable: 'checklist' };
    const graph = { id: 'g', request: 'r', nodes: [node], createdBy: 'template', reason: '' };
    const est = { nodes: [], minUsd: 0, totalUsd: 0, complete: true, problems: [] };
    const plan = parseResult('plan', { planId: 'p', graph, estimate: est });
    expect(plan.ok && plan.value.graph.nodes[0]?.deliverable).toBe('checklist');
    expect(parseParams('plan.validate', { planId: 'p', graph: { nodes: [node] } }).ok).toBe(true);
    const bad = { planId: 'p', graph: { nodes: [{ ...node, deliverable: 'movie' }] } };
    expect(parseParams('plan.validate', bad).ok).toBe(false);
  });
});
