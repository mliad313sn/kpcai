/**
 * ADR-0030: the review policy from `KPAI_REVIEW_POLICY` (estimate and run), the
 * `$KPAI_HOME/**` zone when the home is inside the workspace, and the proposal
 * hint's token budget (ADR-0027). Offline.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tokensOf } from '@kernelpai/memory';
import { SUGGESTED_REVIEW_POLICY } from '@kernelpai/orchestrator';
import { describe, expect, it } from 'vitest';
import { homeZones } from './home-zone.js';
import { Kernel } from './kernel.js';
import { PROPOSAL_HINT, PROPOSAL_HINT_MAX_TOKENS } from './memory.js';
import { selectPacks } from './packs.js';
import { reviewPolicyOf } from './review-config.js';
import { REQ, TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };
const IN_PLACE = { ...TEST_OPTIONS, isolated: false } as const;

describe('review policy from KPAI_REVIEW_POLICY (ADR-0030)', () => {
  it('parses off, suggested and overrides; refuses anything else', () => {
    expect(reviewPolicyOf({})).toBeUndefined();
    expect(reviewPolicyOf({ KPAI_REVIEW_POLICY: ' off ' })).toBeUndefined();
    expect(reviewPolicyOf({ KPAI_REVIEW_POLICY: 'suggested' })).toEqual(SUGGESTED_REVIEW_POLICY);
    expect(reviewPolicyOf({ KPAI_REVIEW_POLICY: 'critical=debate, low = critic' })).toEqual({
      low: 'critic',
      normal: 'critic',
      critical: 'debate',
    });
    for (const bad of ['on', 'urgent=critic', 'low=lots', 'low', 'low=none=critic', 'low=none,'])
      expect(() => reviewPolicyOf({ KPAI_REVIEW_POLICY: bad }), bad).toThrow(/KPAI_REVIEW_POLICY/);
  });

  it('is in the estimate and in the run; a replay is estimated without it', async () => {
    const plain = new Kernel(recordingHost(CHEAP));
    const before = await plain.plan(REQ, TEST_OPTIONS);
    await plain.close();
    const host = recordingHost({ ...CHEAP, KPAI_REVIEW_POLICY: 'suggested' });
    const k = new Kernel(host);
    const after = await k.plan(REQ, TEST_OPTIONS);
    // critical code nodes get two critics: the band covers the extra reviews.
    expect(after.estimate.capUsd).toBeGreaterThan(before.estimate.capUsd);
    const h = await k.startRun({ request: REQ, planId: after.planId, options: IN_PLACE });
    expect((await h.done).status).toBe('finished');
    const set = k
      .events(h.sessionId, 10_000)
      .filter((e) => e.payload['action'] === 'protocol set by review policy');
    expect(set.map((e) => e.nodeId)).toEqual(expect.arrayContaining(['implementation']));
    expect(set.every((e) => e.payload['depth'] === 'critics')).toBe(true);
    const r = await k.replay(h.runId, 'implementation', { protocol: 'solo' }, TEST_OPTIONS);
    expect(r.replay.ok).toBe(true);
    await k.close();
  });

  it('refuses to plan with a bad setting', async () => {
    const k = new Kernel(recordingHost({ ...CHEAP, KPAI_REVIEW_POLICY: 'always' }));
    await expect(k.plan(REQ, TEST_OPTIONS)).rejects.toThrow(/KPAI_REVIEW_POLICY/);
    await k.close();
  });
});

describe('$KPAI_HOME (memory, policy.json…) when the home is inside the workspace (ADR-0030)', () => {
  it('computes the zone only when the home is inside', () => {
    expect(homeZones({ KPAI_HOME: '/elsewhere/.kp' }, '/work/repo')).toEqual([]);
    // The whole home: policy.json there would otherwise let a model rewrite the zones.
    expect(homeZones({ KPAI_HOME: '/work/repo/.kp' }, '/work/repo')).toEqual(['.kp/**']);
    expect(homeZones({ KPAI_HOME: '/work/repo' }, '/work/repo')).toEqual(
      expect.arrayContaining(['memory/**', 'policy.json', 'zone-approvals.json', 'journal.db*']),
    );
    expect(homeZones({ KPAI_HOME: '/work/repo/.kp' }, undefined)).toEqual([]);
  });

  it('lists the zone and refuses a patch into the memory files', async () => {
    const host = recordingHost(CHEAP);
    const home = join(host.cwd, '.kernelpai');
    mkdirSync(home);
    host.env = { ...host.env, KPAI_HOME: home };
    // The mock providers move with the home.
    const { writeMocks } = await import('./test-helpers/fixture.js');
    writeMocks(home);
    const zones = (await selectPacks(host.env, host.cwd)).zones;
    expect(zones).toContainEqual({ glob: '.kernelpai/**', tier: 'added', origin: 'caller' });
    const k = new Kernel(host);
    const h = await k.startRun({
      request: 'add a fact file with tests [[diff:.kernelpai/memory/user.md]]',
      options: IN_PLACE,
    });
    const o = await h.done;
    expect(o.status).toBe('finished');
    const res = await k.applyPatches(h.runId, { yesApply: true });
    const mem = res.filter((r) => r.nodeId === 'implementation');
    expect(mem.length).toBe(1);
    expect(mem[0]).toMatchObject({ ok: false, message: expect.stringMatching(/forbidden/i) });
    expect(existsSync(join(home, 'memory/user.md'))).toBe(false);
    await k.close();
  });
});

describe('proposal hint (ADR-0027)', () => {
  it('stays under its token budget and keeps its rules', () => {
    expect(tokensOf(PROPOSAL_HINT)).toBeLessThan(PROPOSAL_HINT_MAX_TOKENS);
    for (const rule of [
      /not review\/judge\/vote/,
      /```memory/,
      /"- \[project\] fact"/,
      /\[user\], \[session\]/,
      /local-only/,
      /Max 5/,
      /no secrets or credential paths/,
      /A human confirms each/,
    ])
      expect(PROPOSAL_HINT).toMatch(rule);
  });
});
