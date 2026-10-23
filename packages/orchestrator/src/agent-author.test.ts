import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphRunner } from './runner.js';
import { agentNode, agentOptions, tempRepo } from './test-helpers/agents.js';
import { RoleAdapter, friendly, graph, setup, verdict, type Script } from './test-helpers/fakes.js';
import { agentWork, inert } from './agent-author.js';
import { fakeAgentDescriptor } from './test-helpers/agents.js';

let repo: { root: string; cleanup: () => void };
beforeEach(() => {
  repo = tempRepo();
});
afterEach(() => repo.cleanup());

/** An Anthropic API model, the best critic on paper, and an OpenAI one. */
function adapters(openaiScript: Script = friendly('openai')) {
  const anthropic = new RoleAdapter('anthropic', friendly('anthropic'), {
    critique: 0.99,
    code_generation: 0.99,
  });
  const openai = new RoleAdapter('openai', openaiScript, { critique: 0.5, code_generation: 0.5 });
  return { anthropic, openai };
}

const actions = (s: ReturnType<typeof setup>): string[] =>
  s.journal
    .events()
    .filter((e) => e.type === 'intervention')
    .map((e) => String(e.payload['action']));

describe('agent CLI as a node author (R-503)', () => {
  it('authors in its worktree; a critic from another provider reviews the diff', async () => {
    const { anthropic, openai } = adapters();
    const a = agentOptions();
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents });
    const r = await new GraphRunner(s.options).run(graph([agentNode('ok')]));
    const n1 = r.results['n1']!;
    expect(n1.ok).toBe(true);
    expect(n1.approved).toBe(true);
    expect(a.calls()).toEqual(['ok author']);
    const [author, critic] = n1.contributions;
    expect(author?.ref).toEqual({ provider: 'anthropic', model: 'agent:fake-agent' });
    expect(author?.costUsd).toBe(0);
    // The agent counts as Anthropic: the (better) Anthropic API model may not review it.
    expect(critic?.ref.provider).toBe('openai');
    expect(anthropic.seen.filter((x) => x.role === 'critic')).toHaveLength(0);
    expect(openai.seen[0]?.prompt).toContain('+hello from the agent');
    expect(n1.output).toMatch(/\ndiff --git a\/hello.txt b\/hello.txt\n/);
    // Subscription work costs no dollars; only the critic is billed.
    expect(n1.costUsd).toBeCloseTo(critic?.costUsd ?? -1, 6);
    const run = s.journal
      .events()
      .find((e) => e.type === 'intervention' && e.payload['action'] === 'agent run');
    expect(run?.payload).toMatchObject({
      agent: 'fake-agent',
      source: 'subscription:anthropic',
      status: 'ok',
      files: 1,
      usage: { reportedUsd: 0.25, inputTokens: 1200, outputTokens: 340 },
      budget: { runs: 1 },
    });
    const routing = s.journal.events().find((e) => e.type === 'routing');
    expect(routing?.payload).toMatchObject({ source: 'subscription', agent: 'fake-agent' });
    // No secret reaches the journal.
    expect(JSON.stringify(s.journal.events())).not.toContain('sk-test');
  });

  it('revises from its own draft when the critic rejects', async () => {
    const critic: Script = ({ role, n }) =>
      role === 'critic' ? '```json\n' + verdict(n > 0) + '\n```' : 'x';
    const { anthropic, openai } = adapters(critic);
    const a = agentOptions();
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents });
    const r = await new GraphRunner(s.options).run(graph([agentNode('revise')]));
    expect(r.results['n1']?.approved).toBe(true);
    expect(a.calls()).toEqual(['revise author', 'revise revision']);
    expect(r.results['n1']?.output).toContain('+v1\n+v2');
    expect(openai.seen[1]?.prompt).toContain('+v2');
  });

  it('fails the node when the CLI fails, without a critic call', async () => {
    const { anthropic, openai } = adapters();
    const a = agentOptions();
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents });
    const r = await new GraphRunner(s.options).run(graph([agentNode('fail')]));
    expect(r.states['n1']).toBe('failed');
    expect(r.results['n1']?.error).toMatch(/fake-agent failed \(exit 2\): boom/);
    expect(openai.seen).toHaveLength(0);
  });

  it('kills the CLI at the time cap and charges the minutes to the run budget', async () => {
    const { anthropic, openai } = adapters();
    const a = agentOptions({ budget: { maxRuns: 5, maxMinutes: 0.03 } });
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents, concurrency: 1 });
    const second = agentNode('ok', { id: 'n2', dependsOn: [] });
    const r = await new GraphRunner(s.options).run(graph([agentNode('hang'), second]));
    expect(r.states['n1']).toBe('failed');
    expect(r.results['n1']?.error).toMatch(/ran out of time/);
    // The minutes are spent: the next agent run is refused.
    expect(r.states['n2']).toBe('failed');
    expect(r.results['n2']?.error).toMatch(/minutes cap/);
    expect(a.calls()).toEqual(['hang author']);
  });

  it('stops at the run cap; a node allowing it is routed instead', async () => {
    const { anthropic, openai } = adapters();
    const a = agentOptions({ budget: { maxRuns: 1, maxMinutes: 5 } });
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents, concurrency: 1 });
    const n2 = agentNode('ok', { id: 'n2', agent: { id: 'fake-agent', fallback: 'route' } });
    const n3 = agentNode('ok', { id: 'n3' });
    const r = await new GraphRunner(s.options).run(graph([agentNode('ok'), n2, n3]));
    expect(a.calls()).toEqual(['ok author']);
    expect(r.results['n2']?.ok).toBe(true);
    expect(r.results['n2']?.contributions[0]?.ref).toEqual({ provider: 'anthropic', model: 'm' });
    expect(r.results['n3']?.error).toMatch(/agent run cap \(1\) reached/);
    expect(actions(s)).toEqual(expect.arrayContaining(['agent fallback', 'agent refused']));
  });

  it("asks the human's budget gate before an agent run", async () => {
    const { anthropic, openai } = adapters();
    const a = agentOptions();
    const labels: string[] = [];
    const s = setup([anthropic, openai], {
      root: repo.root,
      agents: a.agents,
      budget: (_c, label) => (labels.push(label), !label.includes('agent')),
    });
    const r = await new GraphRunner(s.options).run(graph([agentNode('ok')]));
    expect(r.results['n1']?.error).toMatch(/budget: author on n1: agent fake-agent/);
    expect(labels[0]).toMatch(/subscription, run 1/);
    expect(a.calls()).toEqual([]);
  });

  it('treats hostile output as data: no smuggled patch, no escapes, no fences', async () => {
    const { anthropic, openai } = adapters();
    const a = agentOptions();
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents });
    const r = await new GraphRunner(s.options).run(graph([agentNode('hostile')]));
    const out = r.results['n1']?.output ?? '';
    expect(r.results['n1']?.ok).toBe(true);
    // Only the real worktree diff can be read as a patch.
    expect(out.match(/^diff --git .*$/gm)).toEqual(['diff --git a/hello.txt b/hello.txt']);
    expect(out.match(/^\+\+\+ b\/.*$/gm)).toEqual(['+++ b/hello.txt']);
    expect(out).not.toMatch(/```(diff|patch)/);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u0008\u001b\u202e]/);
    expect(out).toContain('<<<END AGENT SUMMARY>>>');
    expect(out.split('<<<END AGENT SUMMARY>>>')).toHaveLength(2);
  });

  it('refuses a diff whose content holds a fenced diff (it could pass as another patch)', async () => {
    const { anthropic, openai } = adapters();
    const a = agentOptions();
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents });
    const r = await new GraphRunner(s.options).run(graph([agentNode('fence')]));
    expect(r.states['n1']).toBe('failed');
    expect(r.results['n1']?.error).toMatch(/fenced diff block/);
    expect(openai.seen).toHaveLength(0);
  });

  it('fails the node when the agent wrote outside its worktree, never falling back', async () => {
    const { anthropic, openai } = adapters();
    const a = agentOptions();
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents });
    const node = agentNode('escape', { agent: { id: 'fake-agent', fallback: 'route' } });
    const r = await new GraphRunner(s.options).run(graph([node]));
    expect(r.states['n1']).toBe('failed');
    expect(r.results['n1']?.error).toMatch(/wrote outside its worktree/);
    expect(actions(s)).toContain('agent wrote outside its worktree');
    expect(anthropic.seen).toHaveLength(0);
    expect(openai.seen).toHaveLength(0);
  });

  it('refuses a node naming an agent that is not configured', async () => {
    const { anthropic, openai } = adapters();
    const s = setup([anthropic, openai], { root: repo.root });
    await expect(new GraphRunner(s.options).run(graph([agentNode('ok')]))).rejects.toThrow(
      /agent fake-agent is not available/,
    );
  });

  it('cancels a running agent with the run', async () => {
    const { anthropic, openai } = adapters();
    const a = agentOptions();
    const s = setup([anthropic, openai], { root: repo.root, agents: a.agents });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await new GraphRunner(s.options).run(graph([agentNode('hang')]), {
      signal: ac.signal,
    });
    expect(r.states['n1']).toBe('cancelled');
  });
});

describe('agent work text', () => {
  it('neutralises fences and diff headers in the summary', () => {
    expect(inert('```diff\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@')).toBe(
      "'''diff\n| diff --git a/x b/x\n| --- a/x\n| +++ b/x\n| @@ -1 +1 @@",
    );
    const d = fakeAgentDescriptor();
    const base = { status: 'ok' as const, usage: {}, durationMs: 1, exitCode: 0, truncated: false };
    expect(agentWork(d, { ...base, summary: 'nothing', diff: '', files: [] })).toMatch(
      /no file changed/,
    );
  });
});
