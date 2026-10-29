/**
 * P5-F4 (D-035): `test.run` reads the test command from the run's own worktree
 * (package.json `scripts.test`, `.kpstudio/test.json`). A run that changes it, or the
 * runner's configuration, or the script it names, gets a `tampered` result: said in the
 * confirmation, shown to the critic in the evidence, journaled for packages/learning.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LocalToolBus } from '../bus.js';
import { readTestEvidence } from '../test-evidence.js';
import { call, makeCtx, RecordingJournal, tempDir } from '../test-helpers/ctx.js';
import { makeRepo, put } from '../test-helpers/repo.js';
import { shellTool } from './shell.js';
import { resolveTestCommand } from './test-detect.js';
import { testRunTool } from './test-run.js';
import { testConfigTamper } from './test-tamper.js';

const PASS = 'node -e "console.log(\' Tests  7 passed (7)\')"';
const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'p', scripts, ...extra }, null, 2);

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});
async function repo(files: Record<string, string>) {
  const r = await makeRepo(files);
  cleanups.push(r.cleanup);
  return r.root;
}
const files = async (root: string) => (await testConfigTamper(root, undefined)).files;

describe('test configuration tampering (P5-F4)', () => {
  it('a run that rewrites scripts.test gets a tampered run: asked, evidence, meta', async () => {
    const root = await repo({ 'package.json': pkg({ test: 'node real-tests.mjs' }) });
    await put(root, { 'package.json': pkg({ test: PASS }) });
    const journal = new RecordingJournal();
    const bus = new LocalToolBus({
      tools: [testRunTool()],
      journal,
      env: { PATH: process.env.PATH },
    });
    const ctx = makeCtx(root, { answers: [true] });
    const r = await bus.call(call('test.run', {}), ctx);
    expect(ctx.questions[0]).toMatch(
      /TAMPERED: this run changed its own test configuration \(package\.json\)/,
    );
    expect(readTestEvidence(r.content)).toMatchObject({
      status: 'passed',
      tampered: ['package.json'],
    });
    expect(r.content.split('\n')[1]).toMatch(/^tampered \(.*not test evidence\): package\.json$/);
    expect(journal.last().payload['meta']).toMatchObject({
      status: 'passed',
      tampered: true,
      tamperedFiles: ['package.json'],
    });
  });

  it('an untouched configuration is no tampering; other edits do not count', async () => {
    const root = await repo({
      'package.json': pkg({ test: 'vitest run', build: 'tsc' }, { dependencies: { a: '1' } }),
      'src/a.ts': 'x',
    });
    expect(await testConfigTamper(root, undefined)).toEqual({ checked: true, files: [] });
    await put(root, {
      'src/a.ts': 'y',
      'src/b.ts': 'new',
      'package.json': pkg({ test: 'vitest run', build: 'tsc' }, { dependencies: { a: '2' } }),
    });
    expect(await files(root)).toEqual([]);
  });

  it('flags the repository test command, runner configs, a new runner and named scripts', async () => {
    const root = await repo({
      'package.json': pkg({ test: 'node scripts/run-tests.js' }),
      'scripts/run-tests.js': 'real',
      'vitest.config.ts': 'a',
    });
    await put(root, {
      '.kpstudio/test.json': '{"command":"node","args":["-e","0"]}',
      'vitest.config.ts': 'b',
      'scripts/run-tests.js': 'fake',
      'pkg/conftest.py': 'x',
    });
    expect(await files(root)).toEqual([
      '.kpstudio/test.json',
      'pkg/conftest.py',
      'scripts/run-tests.js',
      'vitest.config.ts',
    ]);
    const added = await repo({ 'package.json': pkg({ build: 'tsc' }) });
    await put(added, {
      'package.json': pkg({ build: 'tsc' }, { devDependencies: { vitest: '1' } }),
    });
    expect(await files(added)).toEqual(['package.json']);
  });

  it('a configured script file named by .kpstudio/test.json counts', async () => {
    const root = await repo({
      '.kpstudio/test.json': '{"command":"node","args":["t/run.mjs"]}',
      't/run.mjs': 'a',
    });
    await put(root, { 't/run.mjs': 'b' });
    const cmd = await resolveTestCommand(root);
    expect((await testConfigTamper(root, cmd)).files).toEqual(['t/run.mjs']);
  });

  it('outside git nothing can be compared: unchecked, not tampered', async () => {
    const { dir, cleanup } = await tempDir('kpai-tamper-');
    cleanups.push(cleanup);
    expect(await testConfigTamper(dir, undefined)).toEqual({ checked: false, files: [] });
  });

  it('shell.run journals tampered too, so `npm test` by hand is no evidence', async () => {
    const root = await repo({ 'package.json': pkg({ test: 'vitest run' }) });
    await put(root, { 'package.json': pkg({ test: PASS }) });
    const journal = new RecordingJournal();
    const bus = new LocalToolBus({
      tools: [shellTool()],
      journal,
      env: { PATH: process.env.PATH },
    });
    await bus.call(
      call('shell.run', { command: 'git', args: ['status'] }),
      makeCtx(root, { answers: [true] }),
    );
    expect(journal.last().payload['meta']).toMatchObject({
      tampered: true,
      tamperedFiles: ['package.json'],
    });
  });
});
