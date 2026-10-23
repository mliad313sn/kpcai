import type { ToolBus, ToolCall, ToolContext, ToolResult } from '@kernelpai/core';
import { formatEvidence, type TestEvidence } from '@kernelpai/tools';
import { describe, expect, it } from 'vitest';
import { GraphRunner } from './runner.js';
import {
  RoleAdapter,
  gnode,
  graph,
  setup,
  toolDef,
  verdict,
  type Script,
} from './test-helpers/fakes.js';

const evidence = (status: TestEvidence['status']): TestEvidence => ({
  status,
  runner: 'vitest',
  exitCode: status === 'passed' ? 0 : 1,
  passed: 2,
  failed: status === 'passed' ? 0 : 1,
  skipped: 0,
  failing: status === 'passed' ? [] : ['src/a.test.ts > adds'],
});

/** A bus whose `test.run` answers from `results`, in order (the last one repeats). */
class TestBus implements ToolBus {
  readonly calls: ToolCall[] = [];
  constructor(private readonly results: string[]) {}
  list() {
    return [toolDef('test.run', 'write'), toolDef('fs.read')];
  }
  call(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
    this.calls.push(call);
    if (call.name !== 'test.run') return Promise.resolve({ content: 'file', isError: false });
    const i = Math.min(this.calls.filter((c) => c.name === 'test.run').length, this.results.length);
    const content = this.results[i - 1] as string;
    return Promise.resolve({ content, isError: !content.startsWith('test.run: passed') });
  }
  close() {
    return Promise.resolve();
  }
}

/** Author and reviser run the tests (`tool`) before answering. */
const tester =
  (tool = 'test.run'): Script =>
  ({ role, req, n }) => {
    if (role === 'critic') return verdict(true);
    if (req.messages.at(-1)?.role === 'tool') return `${role} draft ${n}`;
    return [{ tool: { id: `t-${role}-${n}`, name: tool, input: {} } }, { end: 'tool_use' }];
  };

async function runNode(results: string[], over: { maxRevisions?: number; tool?: string } = {}) {
  const a = new RoleAdapter('a', tester(over.tool), { code_generation: 0.9 });
  const b = new RoleAdapter('b', () => verdict(true), { code_generation: 0.5 });
  const tools = new TestBus(results);
  const s = setup([a, b], {
    tools,
    root: '/work',
    confirm: () => Promise.resolve(true),
    ...(over.maxRevisions !== undefined ? { maxRevisions: over.maxRevisions } : {}),
  });
  const node = gnode({
    type: 'code_generation',
    protocol: 'author_critic',
    tools: ['test.run', 'fs.read'],
  });
  const r = await new GraphRunner(s.options).run(graph([node]));
  const notes = s.journal.events().filter((e) => e.type === 'intervention');
  return { r: r.results['n1'], a, b, notes };
}

describe('tests as evidence for the critic (R-505)', () => {
  it('acceptance: a failing test turns an approval into a revision request', async () => {
    const failed = `${formatEvidence(evidence('failed'))}\n--- output ---\nAssertionError`;
    const passed = formatEvidence(evidence('passed'));
    const { r, a, b, notes } = await runNode([failed, passed]);
    expect(r?.contributions.map((c) => `${c.role}@${c.ref.provider}`)).toEqual([
      'author@a',
      'critic@b',
      'revision@a',
      'critic@b',
    ]);
    expect(r?.approved).toBe(true);
    // The revision prompt also says `Role: author` (n counts the author's calls, tool rounds included).
    expect(r?.output).toBe('author draft 3');
    // The critic saw the evidence, quoted as data.
    expect(b.seen[0]?.prompt).toMatch(/<<<BEGIN TESTS>>>\ntest\.run: failed \(vitest, exit 1\)/);
    expect(b.seen[1]?.prompt).toMatch(/test\.run: passed/);
    // The author was asked to fix the failing test.
    const revision = a.seen.find((s) => /Revise your previous version/.test(s.prompt));
    expect(revision?.prompt).toMatch(
      /\[major\] tests failed \(1 failed, 2 passed\) \[vitest\]: src\/a\.test\.ts > adds/,
    );
    const override = notes.find(
      (e) => e.payload['action'] === 'approval overridden by failing tests',
    );
    expect(override?.payload).toMatchObject({ role: 'critic', critics: 1 });
  });

  it('tests that keep failing leave the node unapproved', async () => {
    const failed = formatEvidence(evidence('error'));
    const { r, notes } = await runNode([failed], { maxRevisions: 1 });
    expect(r?.approved).toBe(false);
    expect(notes.map((e) => e.payload['action'])).toContain('not approved');
  });

  it('a rejecting critic carries the test failure to the revision too', async () => {
    const failed = formatEvidence(evidence('failed'));
    const a = new RoleAdapter('a', tester(), { code_generation: 0.9 });
    const b = new RoleAdapter('b', ({ n }) => verdict(n > 0), { code_generation: 0.5 });
    const tools = new TestBus([failed, formatEvidence(evidence('passed'))]);
    const s = setup([a, b], { tools, confirm: () => Promise.resolve(true) });
    const node = gnode({ type: 'code_generation', protocol: 'author_critic', tools: ['test.run'] });
    const r = (await new GraphRunner(s.options).run(graph([node]))).results['n1'];
    expect(r?.approved).toBe(true);
    const revision = a.seen.find((x) => /Revise your previous version/.test(x.prompt));
    expect(revision?.prompt).toMatch(/\[major\] missing check[\s\S]*\[major\] tests failed/);
    const notes = s.journal.events().filter((e) => e.type === 'intervention');
    expect(notes.map((e) => e.payload['action'])).not.toContain(
      'approval overridden by failing tests',
    );
  });

  it('a revision that does not re-run failing tests is not approved on stale grounds', async () => {
    const failed = formatEvidence(evidence('failed'));
    const a = new RoleAdapter(
      'a',
      ({ req, n }) => {
        if (req.messages.at(-1)?.role === 'tool' || n > 1) return `draft ${n}`;
        return [{ tool: { id: 't0', name: 'test.run', input: {} } }, { end: 'tool_use' }];
      },
      { code_generation: 0.9 },
    );
    const b = new RoleAdapter('b', () => verdict(true), { code_generation: 0.5 });
    const s = setup([a, b], {
      tools: new TestBus([failed]),
      confirm: () => Promise.resolve(true),
      maxRevisions: 1,
    });
    const node = gnode({ type: 'code_generation', protocol: 'author_critic', tools: ['test.run'] });
    const r = (await new GraphRunner(s.options).run(graph([node]))).results['n1'];
    expect(r?.contributions.map((c) => c.role)).toEqual(['author', 'critic', 'revision', 'critic']);
    expect(r?.approved).toBe(false);
    expect(b.seen[1]?.prompt).toMatch(/test\.run: failed/);
  });

  it('no test run, a run that proves nothing, or another tool leave the verdict as it is', async () => {
    const none = await runNode([formatEvidence(evidence('no-tests'))]);
    expect(none.r?.approved).toBe(true);
    expect(none.r?.contributions).toHaveLength(2);
    expect(none.b.seen[0]?.prompt).toMatch(/test\.run: no-tests/);
    const declined = await runNode(['permission declined: declined by the user']);
    expect(declined.r?.approved).toBe(true);
    expect(declined.b.seen[0]?.prompt).not.toMatch(/BEGIN TESTS/);
    const other = await runNode([formatEvidence(evidence('failed'))], { tool: 'fs.read' });
    expect(other.r?.approved).toBe(true);
  });
});
