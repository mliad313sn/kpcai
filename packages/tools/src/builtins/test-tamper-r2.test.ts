/**
 * P5-R2 (D-035): the re-verification's three bypasses of the P5-F4 tamper check, and the
 * line it draws: test files and the code under test may change; the runner side, package
 * manager configuration and what the runner resolves from may not.
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeCtx, tempDir } from '../test-helpers/ctx.js';
import { git, makeRepo, put } from '../test-helpers/repo.js';
import { resolveTestCommand } from './test-detect.js';
import { testRunTool } from './test-run.js';
import { tamperMeta, tamperNote, testConfigTamper } from './test-tamper.js';

const FAKE = "console.log(' Tests  7 passed (7)')";
const pkg = (o: Record<string, unknown>) => JSON.stringify({ name: 'p', ...o }, null, 2);

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
async function exe(root: string, rel: string, body: string) {
  await put(root, { [rel]: body });
  await chmod(path.join(root, rel), 0o755);
}
const check = (root: string) => testConfigTamper(root, undefined);
const run = (root: string) => testRunTool().run({}, makeCtx(root, { answers: [true] }));

describe('P5-R2: the reviewer bypasses are tampered', () => {
  it('(a) a file a test script requires, followed transitively', async () => {
    const root = await repo({
      'package.json': pkg({ scripts: { test: 'node scripts/run.js' } }),
      'scripts/run.js': "require('../lib/runner.js')",
      'lib/runner.js': "require('./deep')\nprocess.exit(1)",
      'lib/deep.js': '',
    });
    await put(root, { 'lib/runner.js': FAKE });
    const out = await run(root);
    expect(out.meta).toMatchObject({ status: 'passed', tampered: true, configChecked: true });
    expect(out.meta?.['tamperedFiles']).toEqual(['lib/runner.js']);
    git(root, 'checkout', '--', 'lib/runner.js');
    await put(root, { 'lib/deep.js': FAKE });
    expect((await check(root)).files).toEqual(['lib/deep.js']);
  });

  it('(b) an added .npmrc script-shell, and an executable the run wrote', async () => {
    const root = await repo({
      'package.json': pkg({ scripts: { test: 'node t.js' } }),
      't.js': 'process.exit(1)',
    });
    await exe(root, 'sh.js', `#!/usr/bin/env node\n${FAKE}`);
    await put(root, { '.npmrc': `script-shell=${path.join(root, 'sh.js')}\n` });
    const out = await run(root);
    expect(out.meta).toMatchObject({ tampered: true, tamperedFiles: ['.npmrc', 'sh.js'] });
    expect(String(out.content)).toMatch(/^tampered \(.*not test evidence\): \.npmrc, sh\.js$/m);
    // An executable nothing names is still no test file or code under test.
    // Windows has no executable bit: there the rule cannot apply (ADR-0032, P5-R2 limits).
    if (process.platform === 'win32') return;
    await exe(root, 'tools/fake', '#!/bin/sh\necho ok');
    expect((await check(root)).files).toEqual(['.npmrc', 'sh.js', 'tools/fake']);
  });

  it('(c) a fake runner under git-ignored node_modules: runner unverified', async () => {
    const root = await repo({
      'package.json': pkg({ devDependencies: { vitest: '1.0.0' } }),
      '.gitignore': 'node_modules\n',
    });
    await exe(root, 'node_modules/.bin/vitest', `#!/usr/bin/env node\n${FAKE}`);
    const t = await check(root);
    expect(t).toEqual({ checked: true, files: [], unverified: ['node_modules/.bin/vitest'] });
    expect(tamperMeta(t)).toEqual({
      tampered: true,
      tamperedFiles: ['node_modules/.bin/vitest'],
      runnerUnverified: true,
    });
    expect(tamperNote(t)).toMatch(
      /RUNNER UNVERIFIED: .*tests ran, runner unverified, so the result/,
    );
  });
});

describe('P5-R2: where the line is', () => {
  it('a normal code change with updated tests is not tampered', async () => {
    const root = await repo({
      'package.json': pkg({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' } }),
      'vitest.config.ts':
        "export default { test: { setupFiles: ['./test/setup.ts'], include: ['src/a.test.ts'] } }",
      'test/setup.ts': "import './helpers.js'",
      'test/helpers.ts': '',
      'src/a.ts': 'export const a = 1',
      'src/a.test.ts': 'a',
      'src/old.ts': 'x',
      'README.md': 'r',
      '.gitignore': 'coverage\n',
    });
    await put(root, {
      'src/a.ts': 'export const a = 2',
      'src/a.test.ts': 'b',
      'src/b.ts': 'new',
      'src/__tests__/b.ts': 'new test',
      'test/b.test.ts': 'new test',
      'README.md': 's',
      'coverage/index.html': 'report',
    });
    await rm(path.join(root, 'src/old.ts'));
    expect(await check(root)).toEqual({ checked: true, files: [], unverified: [] });
    expect(tamperMeta(await check(root))).toEqual({ tampered: false });
    // The setup file and what it imports are the runner side.
    await put(root, { 'test/helpers.ts': 'globalThis.expect = () => ({ toBe() {} })' });
    expect((await check(root)).files).toEqual(['test/helpers.ts']);
  });

  it('package-manager and toolchain configuration counts, a lockfile by its runner lines', async () => {
    const lock = (v: string, lodash: string) =>
      JSON.stringify(
        {
          packages: {
            'node_modules/vitest': { version: v },
            'node_modules/lodash': { version: lodash },
          },
        },
        null,
        2,
      );
    const root = await repo({
      'package.json': pkg({}),
      'package-lock.json': lock('1.0.0', '4.0.0'),
    });
    await put(root, { 'package-lock.json': lock('1.0.0', '4.1.0') });
    expect((await check(root)).files).toEqual([]);
    await put(root, { 'package-lock.json': lock('6.6.6', '4.1.0') });
    expect((await check(root)).files).toEqual(['package-lock.json']);
    const names = ['.yarnrc.yml', 'pnpm-workspace.yaml', 'bunfig.toml', '.nvmrc', '.tool-versions'];
    const more = [
      '.yarn/releases/yarn.cjs',
      'yarn.lock',
      'pytest/__main__.py',
      '.cargo/config.toml',
    ];
    await put(root, Object.fromEntries([...names, ...more].map((n) => [n, 'x'])));
    expect((await check(root)).files).toEqual([...names, ...more, 'package-lock.json'].sort());
  });

  it('files a configuration names, and a deleted runner file', async () => {
    const root = await repo({
      'package.json': pkg({ scripts: { test: 'npm run unit', unit: 'node run.mjs' } }),
      '.npmrc': 'node-options=--require ./hook.cjs\n',
      'hook.cjs': '',
      'run.mjs': "import './guard.mjs'",
      'guard.mjs': '',
      'pyproject.toml':
        '[project]\nreadme = "README.md"\n[tool.pytest.ini_options]\naddopts = "-p plug"\n',
      'plug.py': '',
      'README.md': '',
    });
    await put(root, { 'hook.cjs': FAKE, 'plug.py': 'x', 'README.md': 'x' });
    await rm(path.join(root, 'guard.mjs'));
    expect((await check(root)).files).toEqual(['guard.mjs', 'hook.cjs', 'plug.py']);
  });

  it('a Python runner script: its imports are the runner side, the app is not', async () => {
    const root = await repo({
      '.kpstudio/test.json': '{"command":"python3","args":["tools/run.py"]}',
      'tools/run.py': 'from tools.guard import ok\nfrom .local import z\n',
      'tools/guard.py': '',
      'tools/local.py': '',
      'src/app.py': '',
    });
    const cmd = await resolveTestCommand(root);
    await put(root, { 'src/app.py': 'x', 'tests/test_app.py': 'x' });
    expect((await testConfigTamper(root, cmd)).files).toEqual([]);
    await put(root, { 'tools/guard.py': 'x', 'tools/local.py': 'x' });
    expect((await testConfigTamper(root, cmd)).files).toEqual(['tools/guard.py', 'tools/local.py']);
  });

  it('ignored files: what the run wrote counts, what was there before does not', async () => {
    const { dir: root, cleanup } = await tempDir('kpai-r2-');
    cleanups.push(cleanup);
    git(root, 'init', '-q');
    await put(root, {
      '.gitignore': 'node_modules\n.npmrc\nout.log\n',
      'package.json': pkg({ devDependencies: { vitest: '1' } }),
      'node_modules/vitest/index.js': 'real',
      '.npmrc': 'registry=x',
    });
    git(root, 'add', '-A');
    // HEAD is younger than everything already on disk: none of it is the run's.
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    const env = { ...process.env, GIT_COMMITTER_DATE: `${future} +0000` };
    const opts = ['-c', 'user.name=t', '-c', 'user.email=t@e'];
    execFileSync('git', [...opts, 'commit', '-qm', 'init'], { cwd: root, env });
    expect(await check(root)).toEqual({ checked: true, files: [], unverified: [] });
    // Now HEAD is the run's start: wait into the next second so the files above are older.
    await new Promise((r) => setTimeout(r, 1020 - (Date.now() % 1000)));
    execFileSync('git', [...opts, 'commit', '-q', '--amend', '-m', 'now'], { cwd: root });
    await put(root, { 'node_modules/.vite/vitest/results.json': '{}', 'out.log': 'x' });
    await put(root, { '.npmrc': 'script-shell=x' });
    expect(await check(root)).toEqual({ checked: true, files: ['.npmrc'], unverified: [] });
    await mkdir(path.join(root, 'node_modules/vitest'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/vitest/index.js'), FAKE);
    expect((await check(root)).unverified).toEqual(['node_modules/vitest/index.js']);
  });
});
