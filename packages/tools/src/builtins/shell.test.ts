import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalToolBus } from '../bus.js';
import { GradedPermissionPolicy } from '../policy.js';
import { runProcess } from '../process.js';
import { detectSandbox, type ShellSandbox } from '../sandbox.js';
import { call, makeCtx, RecordingJournal, tempDir } from '../test-helpers/ctx.js';
import { DEFAULT_SHELL_ALLOWLIST, isAllowlisted, shellTool } from './shell.js';

const isWin = process.platform === 'win32';
const node = (script: string) => ({ command: 'node', args: ['-e', script] });

describe('shell.run', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  const env = {
    ...process.env,
    OPENAI_API_KEY: 'sk-should-never-leak-000000000000',
    GITHUB_TOKEN: 'ghp_never',
    AWS_SECRET_ACCESS_KEY: 'aws-never',
    KPAI_VISIBLE: 'yes',
  };
  const journal = new RecordingJournal();
  const make = (opts: Parameters<typeof shellTool>[0] = {}) =>
    new LocalToolBus({ tools: [shellTool({ env, ...opts })], journal, env });
  const yes = () => makeCtx(root, { answers: Array(5).fill(true) });

  beforeEach(async () => {
    ({ dir: root, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  it('runs with cwd = root and a scrubbed environment', async () => {
    const script =
      "console.log(process.cwd()); for (const k of ['OPENAI_API_KEY','GITHUB_TOKEN','AWS_SECRET_ACCESS_KEY','KPAI_VISIBLE']) console.log(k + '=' + (process.env[k] ?? 'unset'))";
    const r = await make().call(call('shell.run', node(script)), yes());
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toMatch(/^exit code 0/);
    expect(r.content).toContain('OPENAI_API_KEY=unset');
    expect(r.content).toContain('GITHUB_TOKEN=unset');
    expect(r.content).toContain('AWS_SECRET_ACCESS_KEY=unset');
    expect(r.content).toContain('KPAI_VISIBLE=yes');
    expect(r.content.toLowerCase()).toContain(path.basename(root).toLowerCase());
    expect(journal.last().payload.meta).toMatchObject({
      sandbox: isWin ? 'confirm-only' : 'scrubbed',
      exitCode: 0,
    });
  });

  it('runs a script naming secrets with Windows-style case-insensitive zones', async () => {
    const policy = new GradedPermissionPolicy({ caseInsensitive: true });
    const bus = new LocalToolBus({ tools: [shellTool({ env })], policy, env });
    const script =
      "for (const k of ['AWS_SECRET_ACCESS_KEY']) console.log(k + '=' + (process.env[k] ?? 'unset'))";
    const r = await bus.call(call('shell.run', node(script)), yes());
    expect(r.isError, r.content).toBe(false);
    expect(r.content).toContain('AWS_SECRET_ACCESS_KEY=unset');
    const denied = await bus.call(call('shell.run', { command: 'node', args: ['.ENV'] }), yes());
    expect(denied.content).toMatch(/forbidden zone/);
  });

  it('never interprets shell syntax', async () => {
    const r = await make().call(
      call('shell.run', node('console.log(process.argv.slice(1).join("|"))')),
      yes(),
    );
    expect(r.isError).toBe(false);
    const args = {
      command: 'node',
      args: ['-e', 'console.log(process.argv.slice(1).join("|"))', '$(id)', '; rm -rf /', '*'],
    };
    const out = await make().call(call('shell.run', args), yes());
    expect(out.content).toContain('$(id)|; rm -rf /|*');
  });

  it('kills the process on timeout', async () => {
    const r = await make().call(
      call('shell.run', { ...node('setInterval(() => {}, 1000)'), timeoutMs: 300 }),
      yes(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^timed out after 300 ms/);
  });

  it('caps the output and kills a chatty process', async () => {
    const bus = make({ maxOutputBytes: 1000 });
    const r = await bus.call(
      call('shell.run', node("for(;;) process.stdout.write('x'.repeat(4096))")),
      yes(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('[output truncated]');
    expect(r.content.split('--- stdout ---\n')[1]?.length).toBeLessThanOrEqual(1000);
  });

  it('reports non-zero exits, stderr and missing programs', async () => {
    const r = await make().call(
      call('shell.run', node("console.error('bad'); process.exit(3)")),
      yes(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^exit code 3[\s\S]*--- stderr ---\nbad/);
    const missing = await make().call(
      call('shell.run', { command: 'kpai-no-such-cmd', args: [] }),
      yes(),
    );
    expect(missing.content).toMatch(/failed to start/);
  });

  it('accepts relative programs inside root, refuses absolute and escaping ones', async () => {
    const bus = make();
    for (const command of ['/bin/sh', 'C:\\Windows\\System32\\cmd.exe', '../x', '..']) {
      const r = await bus.call(call('shell.run', { command, args: [] }), yes());
      expect(r.isError).toBe(true);
      expect(r.content).not.toMatch(/^exit code/);
    }
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'bin', 'tool.js'), '');
    const rel = await bus.call(call('shell.run', { command: './bin/missing', args: [] }), yes());
    expect(rel.content).toMatch(/not found/);
  });

  it('confirms every call without an isolating sandbox, even allow-listed ones', async () => {
    const policy = new GradedPermissionPolicy();
    policy.trust({ sessionId: 's1', root, risk: 'write' });
    const bus = new LocalToolBus({ tools: [shellTool({ env, allowlist: ['node -e'] })], policy });
    const ctx = makeCtx(root, { answers: [true, false] });
    expect((await bus.call(call('shell.run', node('1')), ctx)).isError).toBe(false);
    expect((await bus.call(call('shell.run', node('1')), ctx)).content).toMatch(/declined/);
    expect(ctx.questions[0]).toMatch(/shell\.run \(write\)/);
  });

  it('lets an isolating sandbox skip the forced confirmation for allow-listed commands', async () => {
    const fake: ShellSandbox = {
      mode: 'sandbox-runtime',
      isolating: true,
      prepare: (c) => ({
        command: c.command,
        args: [...c.args],
        cwd: c.cwd,
        env: { ...process.env } as Record<string, string>,
      }),
    };
    const policy = new GradedPermissionPolicy();
    policy.trust({ sessionId: 's1', root, risk: 'write' });
    const bus = new LocalToolBus({
      tools: [shellTool({ allowlist: ['node -e'], sandbox: fake })],
      policy,
    });
    const ctx = makeCtx(root);
    const r = await bus.call(call('shell.run', node('1')), ctx);
    expect(r.isError).toBe(false);
    expect(ctx.questions).toHaveLength(0);
    const destructive = await bus.call(call('shell.run', { command: 'node', args: ['x.js'] }), ctx);
    expect(destructive.content).toMatch(/declined/);
  });

  it('classifies allow-listed commands conservatively', () => {
    const list = DEFAULT_SHELL_ALLOWLIST;
    expect(isAllowlisted(list, 'ls', ['-la', 'src'])).toBe(true);
    expect(isAllowlisted(list, 'git', ['status', '--short'])).toBe(false);
    expect(isAllowlisted(list, 'git', ['status'])).toBe(true);
    expect(isAllowlisted(list, 'git', ['diff', '--output=/tmp/x'])).toBe(false);
    expect(isAllowlisted(list, 'git', ['push'])).toBe(false);
    expect(isAllowlisted(list, 'cat', ['/etc/passwd'])).toBe(false);
    expect(isAllowlisted(list, 'cat', ['../x'])).toBe(false);
    expect(isAllowlisted(list, 'rm', ['x'])).toBe(false);
  });

  it('detects the sandbox mode per OS', () => {
    expect(detectSandbox('win32').mode).toBe('confirm-only');
    expect(detectSandbox('linux').mode).toBe('scrubbed');
    expect(detectSandbox('darwin')).toMatchObject({ mode: 'scrubbed', isolating: false });
    const prepared = detectSandbox('linux').prepare({ command: 'x', args: ['a'], cwd: root, env });
    expect(prepared.env.OPENAI_API_KEY).toBeUndefined();
  });

  it('runProcess honours an abort signal', async () => {
    const ac = new AbortController();
    const p = runProcess({
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: root,
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
      timeoutMs: 10_000,
      maxOutputBytes: 100,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    expect((await p).aborted).toBe(true);
    const pre = await runProcess({
      command: 'node',
      args: [],
      cwd: root,
      env: {},
      timeoutMs: 1,
      maxOutputBytes: 1,
      signal: ac.signal,
    });
    expect(pre).toMatchObject({ aborted: true, code: null });
  });
});
