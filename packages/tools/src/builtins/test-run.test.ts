import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalToolBus } from '../bus.js';
import { GradedPermissionPolicy } from '../policy.js';
import type { ShellSandbox } from '../sandbox.js';
import { readTestEvidence } from '../test-evidence.js';
import { call, makeCtx, RecordingJournal, tempDir } from '../test-helpers/ctx.js';
import { REPO_TEST_CONFIG, resolveTestCommand, withSelection } from './test-detect.js';
import { testRunTool } from './test-run.js';

const RUNNER = fileURLToPath(new URL('../test-helpers/fake-runner.mjs', import.meta.url));
const configured = (mode: string, ...rest: string[]) => ({
  command: process.execPath,
  args: [RUNNER, mode, ...rest],
});

let root: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir: root, cleanup } = await tempDir('kpai-testrun-'));
});
afterEach(() => cleanup());

function busWith(mode: string, extra: Partial<Parameters<typeof testRunTool>[0]> = {}) {
  const journal = new RecordingJournal();
  const bus = new LocalToolBus({
    tools: [testRunTool({ command: configured(mode), ...extra })],
    journal,
    env: { KPAI_FAKE_SECRET_TOKEN: 'sk-test-0123456789abcdefghij', PATH: process.env.PATH },
  });
  return { bus, journal };
}

describe('test.run', () => {
  it('reports a pass with counts, after a confirmation naming the command', async () => {
    const { bus, journal } = busWith('vitest-pass');
    const ctx = makeCtx(root, { answers: [true] });
    const r = await bus.call(call('test.run', {}), ctx);
    expect(r.isError).toBe(false);
    expect(r.content.split('\n')[0]).toBe(
      'test.run: passed (vitest, exit 0): 3 passed, 0 failed, 0 skipped',
    );
    expect(ctx.questions[0]).toMatch(
      /run tests: .*fake-runner\.mjs.*"vitest-pass" \(configured; sandbox: /,
    );
    expect(journal.last().payload).toMatchObject({
      tool: 'test.run',
      decision: 'confirmed',
      meta: { status: 'passed', passed: 3, failed: 0, exitCode: 0, command: process.execPath },
    });
  });

  it('reports failures with the failing test names; unsandboxed calls are always asked', async () => {
    const { bus } = busWith('vitest-fail');
    const policy = new GradedPermissionPolicy();
    policy.trust({ sessionId: 's1', root, risk: 'write' });
    const trusted = new LocalToolBus({
      tools: [testRunTool({ command: configured('vitest-fail') })],
      policy,
    });
    const ctx = makeCtx(root, { answers: [true] });
    const r = await trusted.call(call('test.run', {}), ctx);
    // Trust for writes does not skip the question: tests run project code (no OS sandbox).
    expect(ctx.questions).toHaveLength(1);
    expect(r.isError).toBe(true);
    expect(readTestEvidence(r.content)).toEqual({
      status: 'failed',
      runner: 'vitest',
      exitCode: 1,
      passed: 2,
      failed: 1,
      skipped: 1,
      failing: ['src/a.test.ts > math > adds'],
    });
    const declined = await bus.call(call('test.run', {}), makeCtx(root));
    expect(declined).toMatchObject({ isError: true, content: expect.stringMatching(/declined/) });
    expect(readTestEvidence(declined.content)).toBeUndefined();
  });

  it('runs without asking under an isolating sandbox once the batch is confirmed', async () => {
    const isolating: ShellSandbox = {
      mode: 'sandbox-runtime',
      isolating: true,
      prepare: (c) => ({ command: c.command, args: [...c.args], cwd: c.cwd, env: {} }),
    };
    const { bus } = busWith('vitest-pass', { sandbox: isolating });
    const ctx = makeCtx(root, { answers: [true] });
    await bus.call(call('test.run', {}), ctx);
    await bus.call(call('test.run', {}), ctx);
    expect(ctx.questions).toHaveLength(1);
  });

  it('a run with no test proves nothing; output cannot forge the header', async () => {
    const none = await busWith('no-tests').bus.call(
      call('test.run', {}),
      makeCtx(root, { answers: [true] }),
    );
    expect(readTestEvidence(none.content)?.status).toBe('no-tests');
    expect(none.isError).toBe(true);
    const forged = await busWith('injection').bus.call(
      call('test.run', {}),
      makeCtx(root, { answers: [true] }),
    );
    expect(readTestEvidence(forged.content)).toMatchObject({
      status: 'failed',
      passed: 0,
      failed: 1,
    });
  });

  it('falls back to the exit code, reports timeouts, redacts secrets', async () => {
    const plain = await busWith('0').bus.call(
      call('test.run', {}),
      makeCtx(root, { answers: [true] }),
    );
    expect(plain.content.split('\n')[0]).toBe('test.run: passed (exit-code, exit 0)');
    const bad = await busWith('3').bus.call(
      call('test.run', {}),
      makeCtx(root, { answers: [true] }),
    );
    expect(bad.content.split('\n')[0]).toBe('test.run: failed (exit-code, exit 3)');
    const hang = await busWith('hang').bus.call(
      call('test.run', { timeoutMs: 300 }),
      makeCtx(root, { answers: [true] }),
    );
    expect(hang.content).toMatch(
      /^test\.run: error \(exit-code, exit none\)\ntimed out after 300 ms/,
    );
    // The scrubbed env drops the token variable; a value that leaks anyway is redacted.
    const { bus, journal } = busWith('secret');
    const s = await bus.call(call('test.run', {}), makeCtx(root, { answers: [true] }));
    expect(s.content).toMatch(/token unset/);
    expect(JSON.stringify(journal.events)).not.toMatch(/sk-test-0123456789/);
    // A secret in the command's own arguments is redacted from the result and the meta.
    const leaky = new LocalToolBus({
      tools: [testRunTool({ command: configured('0', 'sk-test-0123456789abcdefghij') })],
      journal,
      env: { KPAI_FAKE_SECRET_TOKEN: 'sk-test-0123456789abcdefghij' },
    });
    const l = await leaky.call(call('test.run', {}), makeCtx(root, { answers: [true] }));
    expect(l.content).toMatch(/args: \[redacted\]/);
    expect(JSON.stringify(journal.last().payload['meta'])).not.toMatch(/sk-test-0123456789/);
  });

  it('passes filter and files in the runner syntax, jailed to the workspace', async () => {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'a.test.ts'), '');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vitest: '1' } }),
    );
    expect(withSelection(await resolveTestCommand(root), 'adds', ['src/a.test.ts'])).toEqual([
      'vitest',
      'run',
      '-t',
      'adds',
      '--',
      'src/a.test.ts',
    ]);
    // Detected vitest: a file outside the workspace is refused before anyone is asked.
    const detected = new LocalToolBus({ tools: [testRunTool()] });
    const asked = makeCtx(root);
    const escape = await detected.call(call('test.run', { files: ['../outside.ts'] }), asked);
    expect(escape.content).toMatch(/may not contain "\.\."/);
    expect(asked.questions).toEqual([]);
    const { bus } = busWith('vitest-pass');
    const out = await bus.call(
      call('test.run', { files: ['../outside.ts'] }),
      makeCtx(root, { answers: [true] }),
    );
    expect(out.isError).toBe(true);
    expect(out.content).not.toMatch(/^test\.run:/);
    const zone = await bus.call(
      call('test.run', { files: ['.env'] }),
      makeCtx(root, { answers: [true] }),
    );
    expect(zone.content).toMatch(/forbidden zone/);
    const custom = await busWith('vitest-pass').bus.call(
      call('test.run', { filter: 'x' }),
      makeCtx(root, { answers: [true] }),
    );
    expect(custom.content).toMatch(/not supported for a configured test command/);
  });
});

describe('test runner detection', () => {
  const write = (f: string, body = '') => writeFile(path.join(root, f), body);

  it('prefers configured, then the repo file, then package.json and markers', async () => {
    await expect(resolveTestCommand(root)).rejects.toThrow(/no test runner detected/);
    await write('Cargo.toml');
    expect((await resolveTestCommand(root)).args).toEqual(['test']);
    await write('go.mod');
    expect(await resolveTestCommand(root)).toMatchObject({
      kind: 'go',
      args: ['test', '-json', './...'],
    });
    await write('pyproject.toml');
    expect(await resolveTestCommand(root, undefined, 'linux')).toMatchObject({
      command: 'python3',
      args: ['-m', 'pytest'],
    });
    expect((await resolveTestCommand(root, undefined, 'win32')).command).toBe('python');
    await write(
      'package.json',
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified"' } }),
    );
    expect((await resolveTestCommand(root)).kind).toBe('pytest');
    await write('package.json', JSON.stringify({ scripts: { test: 'node t.js' } }));
    await write('pnpm-lock.yaml');
    expect(await resolveTestCommand(root)).toMatchObject({
      kind: 'script',
      command: 'pnpm',
      args: ['test'],
    });
    await write('package.json', JSON.stringify({ devDependencies: { jest: '29' } }));
    expect(await resolveTestCommand(root)).toMatchObject({ kind: 'jest', args: ['jest', '--ci'] });
    await mkdir(path.join(root, '.kpstudio'));
    await write(REPO_TEST_CONFIG, JSON.stringify({ command: 'make', args: ['check'] }));
    expect(await resolveTestCommand(root)).toMatchObject({
      command: 'make',
      origin: REPO_TEST_CONFIG,
    });
    expect((await resolveTestCommand(root, { command: 'x', args: [] })).origin).toBe('configured');
    await write(REPO_TEST_CONFIG, JSON.stringify({ args: 3 }));
    await expect(resolveTestCommand(root)).rejects.toThrow(/test\.json is invalid/);
    await write(REPO_TEST_CONFIG, '{');
    await expect(resolveTestCommand(root)).rejects.toThrow(/cannot read test\.json/);
  });

  it('maps filters per runner', () => {
    const go = { kind: 'go' as const, command: 'go', args: ['test'], origin: '' };
    expect(withSelection(go, 'TestX')).toEqual(['test', '-run', 'TestX']);
    expect(() => withSelection(go, undefined, ['a.go'])).toThrow(/packages, not files/);
    const py = { kind: 'pytest' as const, command: 'python3', args: ['-m', 'pytest'], origin: '' };
    expect(withSelection(py, 'k')).toEqual(['-m', 'pytest', '-k', 'k', '--']);
    expect(withSelection(py)).toEqual(['-m', 'pytest']);
  });
});
