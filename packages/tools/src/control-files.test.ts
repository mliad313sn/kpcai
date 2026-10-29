/** D-035 control files: never pre-answered or batched (P5-F2), no test evidence (P5-F4). */
import { describe, expect, it } from 'vitest';
import {
  isControlPath,
  isLockfilePath,
  isTestConfigPath,
  patchPaths,
  writesControl,
} from './control-files.js';
import { formatEvidence, readTestEvidence, evidenceSummary } from './test-evidence.js';

describe('control files', () => {
  it('KP Studio and Claude settings, MCP config, package.json and test configs', () => {
    for (const p of [
      '.kpstudio/hooks.json',
      'sub/.claude/settings.json',
      '.MCP.json',
      'package.json',
      'packages/a/package.json',
      'vitest.config.ts',
      'vite.config.mjs',
      'jest.config.cjs',
      'pytest.ini',
      'tests\\conftest.py',
      '.mocharc.yml',
    ])
      expect(isControlPath(p), p).toBe(true);
    for (const p of ['src/a.ts', 'README.md', 'docs/package.md', 'kpstudio/x', '.claude'])
      expect(isControlPath(p), p).toBe(false);
    expect(isTestConfigPath('.kpstudio/test.json')).toBe(true);
    expect(isTestConfigPath('.kpstudio/hooks.json')).toBe(false);
  });

  it('P5-R2: package-manager, toolchain and lockfiles are control; ordinary files are not', () => {
    for (const p of [
      '.npmrc',
      'sub/.yarnrc',
      '.yarnrc.yml',
      '.pnpmrc',
      'pnpm-workspace.yaml',
      '.pnpmfile.cjs',
      'bunfig.toml',
      '.nvmrc',
      '.node-version',
      '.tool-versions',
      '.pnp.cjs',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'poetry.lock',
      '.yarn/releases/yarn-4.cjs',
      '.cargo/config.toml',
      'pytest/__main__.py',
      'sitecustomize.py',
      'lib/site.pth',
      'go.work',
    ])
      expect(isControlPath(p), p).toBe(true);
    for (const p of ['src/npmrc.ts', 'docs/yarn.md', 'src/pytest_helpers.py', 'lockfile.txt'])
      expect(isControlPath(p), p).toBe(false);
    expect(isLockfilePath('a/PNPM-LOCK.yaml')).toBe(true);
    expect(isLockfilePath('.npmrc')).toBe(false);
    expect(writesControl('fs.write', { path: '.npmrc' })).toBe(true);
  });

  it('reads every path a patch names, renames and quoted names included', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      'diff --git a/old.js b/new.js',
      'rename from old.js',
      'rename to "jest.config.js"',
      '--- /dev/null',
      '+++ "b/sp ace.ts"\t2026-01-01',
    ].join('\n');
    expect(patchPaths(patch).sort()).toEqual(
      ['jest.config.js', 'new.js', 'old.js', 'sp ace.ts', 'src/a.ts'].sort(),
    );
  });

  it('only builtin writers, and only their target paths', () => {
    expect(writesControl('fs.write', { path: '.claude/x' })).toBe(true);
    expect(writesControl('fs.delete', { path: 'src/a.ts' })).toBe(false);
    expect(writesControl('git.apply', { patch: '+++ b/package.json\n' })).toBe(true);
    expect(writesControl('git.apply', { patch: 3 })).toBe(false);
    expect(writesControl('fs.write', null)).toBe(false);
    expect(writesControl('shell.run', { path: 'package.json' })).toBe(false);
  });
});

describe('tampered evidence (P5-F4)', () => {
  it('round-trips the tampered line before the failing tests, and says it in the summary', () => {
    const e = {
      status: 'failed' as const,
      runner: 'vitest',
      exitCode: 1,
      passed: 1,
      failed: 1,
      skipped: 0,
      failing: ['a > b'],
      tampered: ['package.json', 'vitest.config.ts'],
    };
    const text = formatEvidence(e);
    expect(text.split('\n')[1]).toMatch(/^tampered /);
    expect(readTestEvidence(text)).toEqual(e);
    expect(evidenceSummary(e)).toMatch(/tampered: the run changed its test configuration/);
    const plain = { ...e, failing: [], tampered: undefined };
    expect(readTestEvidence(formatEvidence(plain))).not.toHaveProperty('tampered');
  });
});
