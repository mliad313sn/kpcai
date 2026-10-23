import { describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@kernelpai/core';
import { makeCtx } from '../test-helpers/ctx.js';
import { authorize, MERGE_DEF, RESTORE_DEF } from './gate.js';

const fixed = (d: 'allow' | 'deny' | 'confirm'): PermissionPolicy => ({
  decide: () => d,
  trust: () => undefined,
});

describe('workspace permission gate', () => {
  it('allows without asking when the policy says allow', async () => {
    const ctx = makeCtx('/ws');
    await authorize({ policy: fixed('allow'), ctx }, '/ws', MERGE_DEF, {}, 'x');
    expect(ctx.questions).toEqual([]);
  });

  it('denies with a generic reason for policies that give none', async () => {
    const gate = { policy: fixed('deny'), ctx: makeCtx('/ws') };
    await expect(authorize(gate, '/ws', RESTORE_DEF, {}, 'x')).rejects.toThrow(
      'permission deny: checkpoint.restore is not permitted',
    );
  });

  it('asks with a control-free question; a throwing confirm counts as no', async () => {
    const ctx = makeCtx('/ws', { answers: [true] });
    await authorize({ policy: fixed('confirm'), ctx }, '/ws', RESTORE_DEF, {}, 'a\x1b[2Jb');
    expect(ctx.questions[0]).toBe('checkpoint.restore (destructive) on /ws\nab');
    const broken = makeCtx('/ws', { confirm: () => Promise.reject(new Error('gone')) });
    const gate = { policy: fixed('confirm'), ctx: broken };
    await expect(authorize(gate, '/ws', MERGE_DEF, {}, 'x')).rejects.toThrow(/declined/);
  });
});
