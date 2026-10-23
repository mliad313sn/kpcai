import { describe, expect, it } from 'vitest';
import { GraphRunner } from './runner.js';
import {
  FakeToolBus,
  RoleAdapter,
  gnode,
  graph,
  setup,
  toolDef,
  type Script,
  isNote,
} from './test-helpers/fakes.js';

const call = (name: string, id = `c-${name}`) => ({ tool: { id, name, input: { path: 'a.ts' } } });

/** Calls the given tools on its first turn, then answers with what it saw. */
const toolUser =
  (...names: string[]): Script =>
  ({ req }) => {
    const last = req.messages.at(-1);
    if (last?.role === 'tool') {
      const results = req.messages.filter((m) => m.role === 'tool');
      return `done: ${results.map((m) => `${m.isError ? '!' : ''}${m.content}`).join(' | ')}`;
    }
    return [{ text: 'let me look' }, ...names.map((n) => call(n)), { end: 'tool_use' }];
  };

const bus = () =>
  new FakeToolBus(
    [toolDef('fs.read'), toolDef('fs.write', 'write'), toolDef('shell.run', 'destructive')],
    ['fs.write'],
  );

describe('tool loop', () => {
  it('runs tool calls through the bus and feeds results back', async () => {
    const tools = bus();
    const a = new RoleAdapter('a', toolUser('fs.read'));
    const confirm = () => Promise.resolve(true);
    const s = setup([a], { tools, root: '/work', confirm });
    const r = await new GraphRunner(s.options).run(graph([gnode({ tools: ['fs.read'] })]));
    expect(r.results['n1']?.output).toBe('done: result of fs.read');
    expect(a.seen[0]?.req.tools?.map((t) => t.name)).toEqual(['fs.read']);
    const second = a.seen[1]?.req.messages ?? [];
    expect(second.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ name: 'fs.read' }] });
    expect(second.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c-fs.read', isError: false });
    const ctx = tools.calls[0]?.ctx;
    expect(ctx).toMatchObject({ root: '/work', nodeId: 'n1', model: { provider: 'a' } });
    expect(await ctx?.confirm('?')).toBe(true);
  });

  it('feeds a permission denial back as an error result', async () => {
    const s = setup([new RoleAdapter('a', toolUser('fs.write'))], { tools: bus() });
    const r = await new GraphRunner(s.options).run(graph([gnode({ tools: ['fs.write'] })]));
    expect(r.results['n1']?.output).toBe('done: !permission denied: fs.write');
  });

  it('refuses tools the node does not allow, without reaching the bus', async () => {
    const tools = bus();
    const s = setup([new RoleAdapter('a', toolUser('shell.run', 'boom'))], { tools });
    const r = await new GraphRunner(s.options).run(graph([gnode({ tools: ['fs.read'] })]));
    expect(r.results['n1']?.output).toMatch(/!tool "shell.run" is not available.*!tool "boom"/);
    expect(tools.calls).toHaveLength(0);
    const denied = s.journal.events().filter((e) => e.type === 'tool');
    expect(denied.map((e) => e.payload['decision'])).toEqual(['deny', 'deny']);
  });

  it('turns a throwing bus into an error result', async () => {
    const tools = new FakeToolBus([toolDef('boom')]);
    const s = setup([new RoleAdapter('a', toolUser('boom'))], { tools });
    const r = await new GraphRunner(s.options).run(graph([gnode({ tools: ['boom'] })]));
    expect(r.results['n1']?.output).toBe('done: !tool boom failed: bus exploded');
  });

  it('stops after the tool round limit', async () => {
    const s = setup([new RoleAdapter('a', () => [call('fs.read'), { end: 'tool_use' }])], {
      tools: bus(),
      maxToolRounds: 2,
    });
    const r = await new GraphRunner(s.options).run(graph([gnode({ tools: ['fs.read'] })]));
    expect(r.results['n1']?.error).toBe('tool round limit (2) reached');
  });

  it('budget-gates every tool round', async () => {
    const s = setup([new RoleAdapter('a', toolUser('fs.read'))], {
      tools: bus(),
      budget: (_c, label) => !label.includes('tool round'),
    });
    const r = await new GraphRunner(s.options).run(graph([gnode({ tools: ['fs.read'] })]));
    expect(r.results['n1']?.error).toBe('budget: solo tool round 1 on n1 not allowed');
    expect(r.results['n1']?.output).toBe('let me look');
  });

  it('journals tools a node lists but the bus does not know, and runs without a bus', async () => {
    const s = setup([new RoleAdapter('a', toolUser('fs.read'))], { tools: bus() });
    await new GraphRunner(s.options).run(graph([gnode({ tools: ['fs.read', 'git.blame'] })]));
    const iv = s.journal.events().filter(isNote);
    expect(iv[0]?.payload).toEqual({ action: 'tools unavailable', tools: ['git.blame'] });
    const none = setup([new RoleAdapter('a', () => 'plain')]);
    const r = await new GraphRunner(none.options).run(graph([gnode({ tools: ['fs.read'] })]));
    expect(r.results['n1']?.output).toBe('plain');
  });
});
