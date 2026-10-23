import { describe, expect, it } from 'vitest';
import { ModelPlanner, parsePlan, plannerPrompt } from './planner/model.js';
import { TemplatePlanner, classifyRequest, inferCriticality } from './planner/template.js';
import { RoleAdapter, setup, type Script } from './test-helpers/fakes.js';

const ctx = { root: '/work' };

describe('TemplatePlanner', () => {
  const planner = new TemplatePlanner({ newId: () => 'g' });

  it('plans a code request as architecture → implementation → tests → review', async () => {
    const g = await planner.plan('add an OAuth state validator with tests', ctx);
    expect(g.createdBy).toBe('template');
    expect(g.id).toBe('g');
    expect(g.nodes.map((n) => [n.id, n.type, n.protocol, n.dependsOn.join(',')])).toEqual([
      ['architecture', 'analysis', 'debate', ''],
      ['implementation', 'code_generation', 'author_critic', 'architecture'],
      ['tests', 'test', 'author_critic', 'implementation'],
      ['review', 'critique', 'solo', 'implementation,tests'],
    ]);
    expect(g.nodes[1]?.criticality).toBe('critical');
    expect(g.nodes[3]?.criticality).toBe('normal');
    expect(g.nodes[1]?.tools).toEqual(['fs.list', 'fs.read', 'git.status', 'git.diff']);
    expect(g.nodes[1]?.messages[0]?.content).toContain('add an OAuth state validator');
    expect(g.reason).toMatch(/template "code".*criticality critical/);
  });

  it('uses a solo architecture node when the request is not critical', async () => {
    const g = await new TemplatePlanner({ codeTools: [] }).plan(
      'implement a function that adds numbers',
      ctx,
    );
    expect(g.nodes[0]?.protocol).toBe('solo');
    expect(g.nodes[0]?.tools).toEqual([]);
    expect(g.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['draft a blog post about our launch', 'draft', 'author_critic'],
    ['should we adopt event sourcing for billing history?', 'decision', 'debate'],
    ['which database should we use: Postgres or SQLite?', 'choice', 'vote'],
    ['explain how the fallback policy works', 'answer', 'solo'],
  ])('%s → %s/%s', async (request, id, protocol) => {
    const g = await planner.plan(request, ctx);
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]).toMatchObject({ id, protocol });
  });

  it('classifies and infers criticality transparently', () => {
    expect(classifyRequest('pick between redis or memcached').kind).toBe('choice');
    expect(inferCriticality('rotate the payment token')).toBe('critical');
    expect(inferCriticality('rename a variable')).toBe('normal');
    expect(new TemplatePlanner({ criticality: 'low' })).toBeDefined();
  });
});

const PLAN = {
  reason: 'two steps',
  nodes: [
    {
      id: 'impl',
      title: 'Impl',
      type: 'code_generation',
      protocol: 'author_critic',
      prompt: 'write it',
      tools: ['fs.read', 'shell.run'],
    },
    {
      id: 'rev',
      title: 'Review',
      type: 'critique',
      protocol: 'solo',
      dependsOn: ['impl'],
      prompt: 'review it',
    },
  ],
};

describe('parsePlan', () => {
  it('validates, keeps the request in each node and drops tools that are not allowed', () => {
    const p = parsePlan('```json\n' + JSON.stringify(PLAN) + '\n```', 'REQ [[x]]', ['fs.read']);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.nodes[0]?.tools).toEqual(['fs.read']);
    expect(p.nodes[0]?.criticality).toBe('normal');
    expect(p.nodes[1]?.messages[0]?.content).toBe('review it\n\nOverall request:\nREQ [[x]]');
    expect(p.reason).toBe('two steps');
  });

  it.each([
    ['no json', 'no JSON object'],
    [JSON.stringify({ nodes: [] }), 'invalid plan at nodes'],
    [
      JSON.stringify({ nodes: [{ ...PLAN.nodes[1], dependsOn: ['ghost'] }] }),
      'unknown node "ghost"',
    ],
    [
      JSON.stringify({
        nodes: [{ ...PLAN.nodes[0], dependsOn: ['rev'] }, PLAN.nodes[1]],
      }),
      'cycle',
    ],
    [
      JSON.stringify({
        nodes: Array.from({ length: 13 }, (_, i) => ({
          ...PLAN.nodes[1],
          id: `n${i}`,
          dependsOn: [],
        })),
      }),
      '13 nodes (max 12)',
    ],
    [JSON.stringify({ nodes: [PLAN.nodes[1], PLAN.nodes[1]] }), 'duplicate node id'],
  ])('rejects %#', (text, why) => {
    const p = parsePlan(text, 'r', []);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toContain(why);
  });
});

describe('ModelPlanner', () => {
  const planWith = (script: Script, budget: () => boolean = () => true) => {
    const a = new RoleAdapter('a', script);
    const s = setup([a]);
    return { a, s, planner: new ModelPlanner({ ...s.options, budget }, { newId: () => 'mg' }) };
  };

  it('asks a routed model with Role: planner and returns its validated plan', async () => {
    const { a, s, planner } = planWith(() => JSON.stringify(PLAN));
    const g = await planner.plan('build it', ctx);
    expect(g).toMatchObject({ id: 'mg', createdBy: 'model', reason: 'model plan: two steps' });
    expect(g.nodes[0]?.tools).toEqual(['fs.read']);
    expect(a.seen[0]?.prompt).toBe(plannerPrompt('build it'));
    const routing = s.journal.events().find((e) => e.type === 'routing');
    expect(routing?.payload['role']).toBe('planner');
    expect(s.journal.events().find((e) => e.type === 'call')?.payload['role']).toBe('planner');
  });

  it('falls back to the template with the reason on a bad plan', async () => {
    const { planner } = planWith(() => 'I would do it in three steps');
    const g = await planner.plan('draft a blog post', ctx);
    expect(g.createdBy).toBe('template');
    expect(g.reason).toMatch(
      /^model plan rejected \(no JSON object in the reply\); template "writing"/,
    );
  });

  it('falls back when the model fails or the budget blocks it', async () => {
    const failing = planWith(() => [{ fail: 'auth' }]);
    expect((await failing.planner.plan('x', ctx)).reason).toMatch(/planner model did not answer/);
    const blocked = planWith(
      () => JSON.stringify(PLAN),
      () => false,
    );
    expect((await blocked.planner.plan('x', ctx)).reason).toMatch(/planner blocked by budget/);
    const none = new ModelPlanner({ ...failing.s.options, budget: () => true, candidates: [] });
    expect((await none.plan('x', ctx)).createdBy).toBe('template');
  });
});
