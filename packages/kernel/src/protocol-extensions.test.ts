import { describe, expect, it } from 'vitest';
import { isMethod, parseNotification, parseParams, parseResult } from './protocol.js';

const confirm = { confirmId: 'c1', kind: 'budget', question: 'q', timeoutMs: 1000 };

describe('protocol version 1, additive (R-502, D-028)', () => {
  it('carries the structured facts on confirm.request; older requests still parse', () => {
    expect(parseNotification('confirm.request', confirm).ok).toBe(true);
    const facts = { ...confirm, amountUsd: 0.25, inWorktree: true, physical: false };
    const r = parseNotification('confirm.request', facts);
    expect(r.ok && r.value).toMatchObject({ amountUsd: 0.25, inWorktree: true });
    expect(parseNotification('confirm.request', { ...confirm, amountUsd: -1 }).ok).toBe(false);
  });

  it('carries providers and source on run.done', () => {
    const done = { runId: 'r', result: {}, patches: [] };
    expect(parseNotification('run.done', done).ok).toBe(true);
    const withSources = {
      ...done,
      providers: ['ollama'],
      source: 'local',
      sources: [{ provider: 'ollama', source: 'local' }],
    };
    expect(parseNotification('run.done', withSources).ok).toBe(true);
    expect(parseNotification('run.done', { ...done, source: 'cloud' }).ok).toBe(false);
  });

  it('takes a skill and an agent in run options and plan edits', () => {
    expect(parseParams('plan', { request: 'x', options: { skill: 'tdd', agent: 'sec' } }).ok).toBe(
      true,
    );
    const edit = { planId: 'p', graph: { nodes: [{ id: 'a', skill: 'x'.repeat(65) }] } };
    expect(parseParams('plan.validate', edit).ok).toBe(false);
  });

  it('defines the extensions and tickets methods with strict ticket ids', () => {
    for (const m of ['extensions.list', 'tickets.list', 'tickets.show', 'tickets.setStatus'])
      expect(isMethod(m)).toBe(true);
    expect(parseParams('tickets.show', { id: '../x' }).ok).toBe(false);
    expect(parseParams('tickets.setStatus', { id: 'T-1', status: 'merged' }).ok).toBe(false);
    const ticket = {
      id: 'T-1',
      path: '.kpstudio/tickets/T-1.md',
      title: 't',
      status: 'unknown',
      criteria: [],
      trust: 'untrusted',
    };
    expect(parseResult('tickets.list', { tickets: [ticket], problems: [] }).ok).toBe(true);
    expect(
      parseResult('tickets.list', { tickets: [{ ...ticket, trust: 'user' }], problems: [] }).ok,
    ).toBe(false);
  });
});
