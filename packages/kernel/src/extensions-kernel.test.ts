/**
 * R-502 acceptance through the kernel: a fixture skill is loaded and used by a node, and a
 * hook vetoes a tool call. Also before-plan and after-patch hooks, offline (mock providers,
 * `node -e` hook programs).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '@kernelpai/journal';
import { readRun } from '@kernelpai/orchestrator';
import { openJournal } from './env.js';
import { KernelError } from './errors.js';
import { Kernel } from './kernel.js';
import { REQ, TEST_OPTIONS, recordingHost, type RecordingHost } from './test-helpers/fixture.js';

const PATH = process.env.PATH ?? '';
const TOOL_REQ = 'add an OAuth state validator with tests [[tool:fs.read {"path":"README.md"}]]';

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function host(): RecordingHost {
  return recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100', PATH });
}

/** Hooks in the repository, allow-listed in $KPAI_HOME (no question asked). */
function hooks(h: RecordingHost, list: Array<Record<string, unknown>>, allow = true): void {
  put(h.cwd, '.kpstudio/hooks.json', JSON.stringify({ hooks: list }));
  const lines = list.map((x) => ({ command: x.command, args: x.args }));
  put(h.home, 'hooks.json', JSON.stringify({ allow: allow ? lines : [] }));
}

function allEvents(h: RecordingHost): JournalEvent[] {
  const j = openJournal(h.env);
  try {
    return j.sessions(50).flatMap((s) => j.events({ sessionId: s.id, limit: 100_000 }));
  } finally {
    j.close();
  }
}

describe('R-502: a fixture skill is loaded and used by a node', () => {
  it('runs every node with the skill text in front and its tools narrowed', async () => {
    const h = host();
    put(
      h.cwd,
      '.kpstudio/skills/tdd/SKILL.md',
      '---\nname: tdd\ndescription: Write the failing test first\nallowed-tools: Read\n---\nFIXTURE-SKILL-BODY: red, green, refactor.\n',
    );
    const k = new Kernel(h);
    const p = await k.plan(TOOL_REQ, { ...TEST_OPTIONS, skill: 'tdd' });
    expect(p.extensions?.skills.map((s) => s.name)).toEqual(['tdd']);
    const handle = await k.startRun({ request: TOOL_REQ, planId: p.planId });
    const o = await handle.done;
    await k.close();
    expect(o.status).toBe('finished');
    const j = openJournal(h.env);
    const run = readRun(j, handle.runId);
    j.close();
    const impl = run?.graph.nodes.find((n) => n.id === 'implementation');
    expect(impl?.messages.some((m) => m.content.includes('FIXTURE-SKILL-BODY'))).toBe(true);
    expect(impl?.messages.find((m) => m.content.includes('FIXTURE'))?.role).toBe('user');
    // The template gives code nodes fs.list, fs.read, git.status, git.diff: Read keeps one.
    expect(impl?.tools).toEqual(['fs.read']);
    const routing = allEvents(h).find((e) => e.type === 'routing' && e.payload.extensions);
    expect(routing?.payload.extensions).toMatchObject({ implementation: { skill: 'tdd' } });
  });

  it('refuses an unknown skill at planning and in an edited plan', async () => {
    const h = host();
    const k = new Kernel(h);
    await expect(k.plan(REQ, { ...TEST_OPTIONS, agent: 'ghost' })).rejects.toMatchObject({
      code: 'invalid',
    });
    const p = await k.plan(REQ, TEST_OPTIONS);
    const nodes = p.graph.nodes.map((n) => ({ ...n, skill: 'nope' }));
    const c = k.validatePlan(p.planId, { nodes });
    expect(c.ok).toBe(false);
    expect(c.problems.join()).toMatch(/unknown skill "nope"/);
    await k.close();
  });
});

describe('R-502: a hook vetoes a tool call', () => {
  it('a before-tool hook that exits non-zero refuses the model’s fs.read; journaled', async () => {
    const h = host();
    hooks(h, [
      {
        name: 'no-read',
        event: 'before-tool',
        tools: ['fs.read'],
        command: 'node',
        args: ['-e', 'process.exit(3)'],
      },
    ]);
    const k = new Kernel(h);
    const handle = await k.startRun({ request: TOOL_REQ, options: TEST_OPTIONS });
    await handle.done;
    await k.close();
    const events = allEvents(h);
    const vetoes = events.filter((e) => e.payload.action === 'tool vetoed by hook');
    expect(vetoes.length).toBeGreaterThan(0);
    expect(vetoes[0]?.payload).toMatchObject({ tool: 'fs.read', runId: handle.runId });
    const reads = events.filter((e) => e.type === 'tool' && e.payload.tool === 'fs.read');
    expect(reads).toEqual([]);
    // The hook itself ran through the bus, allow-listed: no question was asked for it.
    expect(events.some((e) => e.type === 'tool' && e.payload.tool === 'shell.run')).toBe(true);
    expect(h.asked.filter((q) => q.question.includes('hook'))).toEqual([]);
  });

  it('a before-plan hook that exits non-zero refuses the plan', async () => {
    const h = host();
    hooks(h, [
      { name: 'freeze', event: 'before-plan', command: 'node', args: ['-e', 'process.exit(1)'] },
    ]);
    const k = new Kernel(h);
    const err = await k.plan(REQ, TEST_OPTIONS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect((err as KernelError).message).toMatch(/plan vetoed by hook "freeze"/);
    await k.close();
  });

  it('a before-plan hook not allow-listed asks first; a no refuses the plan', async () => {
    const h = host();
    hooks(
      h,
      [{ name: 'ok', event: 'before-plan', command: 'node', args: ['-e', 'process.exit(0)'] }],
      false,
    );
    const k = new Kernel(h);
    await expect(k.plan(REQ, TEST_OPTIONS)).rejects.toMatchObject({ code: 'refused' });
    expect(h.asked.at(-1)).toMatchObject({ kind: 'tool', inWorktree: false });
    expect(h.asked.at(-1)?.question).toMatch(/Run repository hook "ok" \(before-plan\)/);
    h.answers.push(true);
    expect((await k.plan(REQ, TEST_OPTIONS)).planId).toBeTruthy();
    await k.close();
  });

  it('after-patch hooks run once a patch is written, with the files', async () => {
    const h = host();
    const code = 'require("fs").writeFileSync("after.txt", process.argv[1])';
    hooks(h, [{ name: 'fmt', event: 'after-patch', command: 'node', args: ['-e', code] }]);
    const k = new Kernel(h);
    const handle = await k.startRun({ request: REQ, options: TEST_OPTIONS });
    await handle.done;
    const results = await k.applyPatches(handle.runId, { yesApply: true });
    await k.close();
    expect(results[0]?.hooks).toEqual([{ name: 'fmt', ok: true }]);
    expect(existsSync(join(h.cwd, 'after.txt'))).toBe(true);
    const payload = JSON.parse(readFileSync(join(h.cwd, 'after.txt'), 'utf8')) as {
      event: string;
      files: string[];
    };
    expect(payload.event).toBe('after-patch');
    expect(payload.files.length).toBeGreaterThan(0);
  });
});
