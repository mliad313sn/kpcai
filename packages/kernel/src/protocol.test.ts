import { describe, expect, it } from 'vitest';
import { Methods, Notifications, isMethod, parseParams } from './protocol.js';

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
