import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candidate } from '@kernelpai/core';
import { CompetenceRouter } from '@kernelpai/router';
import { AgentBudget } from './agent-budget.js';
import { validatePlan } from './plan.js';
import { GraphRunner } from './runner.js';
import { SourceLimits, avoiding, sourceKey, sourceOf } from './source-limits.js';
import { agentNode, agentOptions, tempRepo } from './test-helpers/agents.js';
import { RoleAdapter, friendly, gnode, graph, setup, type Script } from './test-helpers/fakes.js';

let repo: { root: string; cleanup: () => void };
beforeEach(() => {
  repo = tempRepo();
});
afterEach(() => repo.cleanup());

const strong = { critique: 0.99, code_generation: 0.99, analysis: 0.99 };
const weak = { critique: 0.5, code_generation: 0.5, analysis: 0.5 };

const notes = (s: ReturnType<typeof setup>) =>
  s.journal.events().filter((e) => e.type === 'intervention');

describe('D-029 R1: subscription agents are interactive only', () => {
  it('refuses the agent in an unattended run and journals the run as unattended', async () => {
    const a = agentOptions();
    const anthropic = new RoleAdapter('anthropic', friendly('anthropic'), strong);
    const openai = new RoleAdapter('openai', friendly('openai'), weak);
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents });
    const r = await new GraphRunner(s.options).run(graph([agentNode('ok')]), { unattended: true });
    expect(a.calls()).toEqual([]);
    expect(r.states['n1']).toBe('failed');
    expect(r.results['n1']?.error).toMatch(/interactive runs \(D-029 R1\)/);
    const started = notes(s).find((e) => e.payload['action'] === 'run started');
    expect(started?.payload['routing']).toMatchObject({ unattended: true });
  });

  it('falls back within policy when the node allows it', async () => {
    const a = agentOptions();
    const anthropic = new RoleAdapter('anthropic', friendly('anthropic'), strong);
    const openai = new RoleAdapter('openai', friendly('openai'), weak);
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents });
    const node = agentNode('ok', { agent: { id: 'fake-agent', fallback: 'route' } });
    const r = await new GraphRunner(s.options).run(graph([node]), { unattended: true });
    expect(a.calls()).toEqual([]);
    expect(r.results['n1']?.ok).toBe(true);
    expect(r.results['n1']?.contributions[0]?.ref).toEqual({ provider: 'anthropic', model: 'm' });
    const fb = notes(s).find((e) => e.payload['action'] === 'agent fallback');
    expect(fb?.payload['reason']).toMatch(/D-029 R1/);
    // The same runner, interactive again, uses the agent.
    const again = await new GraphRunner(s.options).run(graph([node]));
    expect(again.results['n1']?.ok).toBe(true);
    expect(a.calls()).toEqual(['ok author']);
  });
});

describe('policy: an agent never serves a node the policy keeps elsewhere', () => {
  const local = (a: RoleAdapter): Candidate => ({
    ...a.candidate,
    providerKind: 'local',
    jurisdiction: 'local',
  });

  it('a local-only node never uses the cloud agent, nor a cloud fallback', async () => {
    const a = agentOptions();
    const cloud = new RoleAdapter('anthropic', friendly('anthropic'), strong);
    const l1 = new RoleAdapter('l1', friendly('l1'), weak);
    const l2 = new RoleAdapter('l2', friendly('l2'), weak);
    const s = setup([cloud, l1, l2], {
      root: repo.root,
      agents: a.agents,
      nodeConstraints: () => ({ constraints: { localOnly: true }, reason: 'local-only memory' }),
    });
    s.options.candidates = [cloud.candidate, local(l1), local(l2)];
    const node = agentNode('ok', { agent: { id: 'fake-agent', fallback: 'route' } });
    const r = await new GraphRunner(s.options).run(graph([node]));
    expect(a.calls()).toEqual([]);
    expect(r.results['n1']?.ok).toBe(true);
    expect(cloud.seen).toHaveLength(0);
    const providers = r.results['n1']?.contributions.map((c) => c.ref.provider);
    expect(providers?.every((p) => p === 'l1' || p === 'l2')).toBe(true);
    const fb = notes(s).find((e) => e.payload['action'] === 'agent fallback');
    expect(fb?.payload['reason']).toMatch(/local-only node/);
  });

  it('refuses a denied provider or jurisdiction', async () => {
    const a = agentOptions();
    const x = new RoleAdapter('openai', friendly('openai'), weak);
    const y = new RoleAdapter('mistral', friendly('mistral'), weak);
    const denied = setup([x, y], {
      root: repo.root,
      agents: a.agents,
      constraints: { deniedProviders: ['anthropic'] },
    });
    const r1 = await new GraphRunner(denied.options).run(graph([agentNode('ok')]));
    expect(r1.results['n1']?.error).toMatch(/provider anthropic is not allowed/);
    const eu = setup([x, y], {
      root: repo.root,
      agents: a.agents,
      constraints: { allowedJurisdictions: ['us', 'EU'] },
    });
    expect((await new GraphRunner(eu.options).run(graph([agentNode('ok')]))).ok).toBe(true);
    const euOnly = setup([x, y], {
      root: repo.root,
      agents: a.agents,
      constraints: { allowedJurisdictions: ['EU'] },
    });
    const r2 = await new GraphRunner(euOnly.options).run(graph([agentNode('ok')]));
    expect(r2.results['n1']?.error).toMatch(/jurisdiction US/);
    expect(a.calls()).toEqual(['ok author']);
  });
});

describe('R-5E3: fallback per source:provider', () => {
  it("an agent's exhausted plan is skipped by later nodes; the same provider's API is not", async () => {
    const a = agentOptions();
    const anthropic = new RoleAdapter('anthropic', friendly('anthropic'), strong);
    const openai = new RoleAdapter('openai', friendly('openai'), weak);
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents, concurrency: 1 });
    const route = { id: 'fake-agent', fallback: 'route' as const };
    const nodes = [
      agentNode('quota', { agent: route }),
      agentNode('ok', { id: 'n2', agent: route }),
    ];
    const r = await new GraphRunner(s.options).run(graph(nodes));
    expect(r.ok).toBe(true);
    // One agent call: the second node knew subscription:anthropic was exhausted.
    expect(a.calls()).toEqual(['quota author']);
    for (const id of ['n1', 'n2']) {
      expect(r.results[id]?.contributions[0]?.ref).toEqual({ provider: 'anthropic', model: 'm' });
    }
    const hit = notes(s).find((e) => e.payload['action'] === 'source rate-limited');
    expect(hit?.payload['source']).toBe('subscription:anthropic');
    const skipped = notes(s).filter((e) => e.payload['action'] === 'agent fallback');
    expect(skipped.map((e) => String(e.payload['reason']))).toEqual([
      expect.stringMatching(/rate limit or quota/),
      expect.stringMatching(/subscription:anthropic is rate-limited/),
    ]);
  });

  it("an API's 429 sends later steps to the next candidate, within policy", async () => {
    const limited: Script = ({ role }) =>
      role === 'author' ? [{ fail: 'rate_limit' }] : friendly('x')({ role, n: 0 } as never);
    const x = new RoleAdapter('x', limited, strong);
    const y = new RoleAdapter('y', friendly('y'), { ...weak, code_generation: 0.8 });
    const z = new RoleAdapter('z', friendly('z'), weak);
    const shared = new SourceLimits();
    const s = setup([x, y, z], {
      rateLimitCooldownMs: 600_000,
      concurrency: 1,
      sourceLimits: shared,
    });
    const code = (id: string, dependsOn: string[] = []) =>
      gnode({ id, type: 'code_generation', protocol: 'author_critic', dependsOn });
    const r = await new GraphRunner(s.options).run(graph([code('a'), code('b', ['a'])]));
    expect(r.ok).toBe(true);
    // x answered 429 once; neither its critic step nor the next node went back to it.
    expect(x.seen.map((v) => v.role)).toEqual(['author']);
    expect(r.results['a']?.contributions.map((c) => c.ref.provider)).toEqual(['y', 'z']);
    expect(r.results['b']?.contributions[0]?.ref.provider).toBe('y');
    const hit = notes(s).find((e) => e.payload['action'] === 'source rate-limited');
    expect(hit?.payload['source']).toBe('api:x');
    // Another runner sharing the limits (one kernel, many runs) skips x as well.
    const other = await new GraphRunner(s.options).run(graph([code('c')]));
    expect(other.results['c']?.contributions[0]?.ref.provider).toBe('y');
    expect(x.seen).toHaveLength(1);
  });

  it('a local-only node stays local when its local model is rate-limited', async () => {
    const l1 = new RoleAdapter('l1', () => [{ fail: 'rate_limit' }], strong);
    const cloud = new RoleAdapter('cloud', friendly('cloud'), strong);
    const s = setup([l1, cloud], { constraints: { localOnly: true } });
    s.options.candidates = [{ ...l1.candidate, providerKind: 'local' }, cloud.candidate];
    const runner = new GraphRunner(s.options);
    const r = await runner.run(graph([gnode({ id: 'a' })]));
    expect(r.ok).toBe(false);
    expect(cloud.seen).toHaveLength(0);
    // The limit is kept across runs, and the next step still has no cloud to go to.
    const again = await runner.run(graph([gnode({ id: 'b' })]));
    expect(again.ok).toBe(false);
    expect(cloud.seen).toHaveLength(0);
    expect(notes(s).some((e) => e.payload['action'] === 'rate-limited source used')).toBe(true);
  });

  it('SourceLimits keys by source and lifts with time', () => {
    let now = 0;
    const l = new SourceLimits(() => now);
    expect(l.mark(sourceKey('api', 'x'), 10)).toBe(1_000);
    expect(l.limited('api:x')).toBe(true);
    expect(l.limited('subscription:x')).toBe(false);
    const c = (provider: string, kind: Candidate['providerKind']): Candidate =>
      ({ ref: { provider, model: 'm' }, providerKind: kind }) as Candidate;
    expect(l.limitedProviders([c('x', 'cloud'), c('x2', 'local')])).toEqual(['x']);
    expect(sourceOf(c('y', 'local'))).toBe('local');
    now = 2_000;
    expect(l.limited('api:x')).toBe(false);
    expect(l.limited('api:never')).toBe(false);
    expect(avoiding(undefined, [])).toEqual({});
    expect(avoiding({ deniedProviders: ['a'] }, ['b'])).toEqual({ deniedProviders: ['a', 'b'] });
  });
});

describe('agent budget and plan checks', () => {
  it('counts runs and minutes, and gives unused time back', () => {
    const b = new AgentBudget({ maxRuns: 2, maxMinutes: 1 });
    const c1 = b.claim(45_000);
    expect(c1).toMatchObject({ ok: true, timeoutMs: 45_000, run: 1 });
    const c2 = b.claim(45_000);
    expect(c2).toMatchObject({ ok: true, timeoutMs: 15_000 });
    if (c1.ok) c1.release(10_000);
    if (c1.ok) c1.release(10_000); // a second release is ignored
    if (c2.ok) c2.release(99_999); // charged at most its slice
    expect(b.used()).toEqual({ runs: 2, minutes: 0.42 });
    expect(b.claim(1)).toMatchObject({ ok: false, reason: expect.stringMatching(/run cap/) });
    const t = new AgentBudget({ maxRuns: 9, maxMinutes: 0.01 });
    expect(t.claim(60_000)).toMatchObject({ ok: false, reason: expect.stringMatching(/minutes/) });
    b.reset();
    expect(b.used()).toEqual({ runs: 0, minutes: 0 });
  });

  it('validates agent nodes in an edited plan', () => {
    const x = new RoleAdapter('x', friendly('x'));
    const y = new RoleAdapter('y', friendly('y'));
    const opts = {
      router: new CompetenceRouter(),
      candidates: [x.candidate, y.candidate],
      agents: ['fake-agent'],
    };
    const bad = (over: Record<string, unknown>) =>
      validatePlan(graph([{ ...agentNode('ok'), ...over } as never]), opts).problems;
    expect(validatePlan(graph([agentNode('ok')]), opts).ok).toBe(true);
    expect(bad({ agent: { id: 'other' } })).toEqual(['node "n1": agent other is not available']);
    expect(bad({ agent: { id: 1 } })[0]).toMatch(/agent must be/);
    expect(bad({ agent: { id: 'fake-agent', fallback: 'maybe' } })[0]).toMatch(/agent must be/);
    expect(bad({ model: x.ref })).toEqual(['node "n1": choose a model or an agent, not both']);
    expect(bad({ deliverable: 'answer' })).toEqual(['node "n1": an agent node delivers a patch']);
    expect(bad({ protocol: 'vote' })).toEqual(['node "n1": an agent node runs author+critic']);
    const changes = validatePlan(
      graph([{ ...agentNode('ok'), agent: { id: 'fake-agent', fallback: 'route' } } as never]),
      { ...opts, original: graph([gnode({ ...agentNode('ok'), agent: undefined } as never)]) },
    ).changes;
    expect(changes).toContain('n1: agent none → fake-agent+route');
  });
});
