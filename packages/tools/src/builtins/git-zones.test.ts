import { execFileSync } from 'node:child_process';
import { mkdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalToolBus } from '../bus.js';
import { createToolBus } from '../create.js';
import { call, makeCtx, tempDir } from '../test-helpers/ctx.js';
import type { ZoneSet } from '../zones.js';
import { zoneSetFromGlobs } from '../zones.js';
import { DEFAULT_ZONES, inForbiddenZone } from '../zones.js';
import { envCredentialGlobs, excludePathspecs, filterDiff, filterStatus } from './git-filter.js';
import { gitTools } from './git.js';

function git(cwd: string, ...args: string[]): string {
  const opts = ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'core.autocrlf=false'];
  return execFileSync('git', [...opts, ...args], { cwd, encoding: 'utf8' });
}

describe('forbidden zones stay out of git output (N2)', () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: root, cleanup } = await tempDir());
    git(root, 'init', '-q');
    await mkdir(path.join(root, 'config'));
    await writeFile(path.join(root, '.env'), 'X=1\n');
    await writeFile(path.join(root, 'config', 'secrets.yml'), 'db_password: old\n');
    await writeFile(path.join(root, 'config', 'app.yml'), 'port: 1\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
    await writeFile(path.join(root, '.env'), 'X=supersecret\n');
    await writeFile(path.join(root, 'config', 'secrets.yml'), 'db_password: hunter2-prod\n');
    await writeFile(path.join(root, 'config', 'app.yml'), 'port: 2\n');
  });
  afterEach(() => cleanup());

  it('git.diff and git.status hide .env and config/secrets.yml (gd.mjs)', async () => {
    const bus = new LocalToolBus({ tools: gitTools() });
    for (const input of [{}, { path: 'config' }, { path: '.' }]) {
      const r = await bus.call(call('git.diff', input), makeCtx(root));
      expect(r.isError, r.content).toBe(false);
      expect(r.content).toContain('+port: 2');
      expect(r.content).not.toMatch(/supersecret|hunter2|secrets\.yml|\.env/);
    }
    git(root, 'add', '.');
    const staged = await bus.call(call('git.diff', { staged: true }), makeCtx(root));
    expect(staged.content).not.toMatch(/hunter2|supersecret/);
    const status = await bus.call(call('git.status', {}), makeCtx(root));
    expect(status.content).toContain('config/app.yml');
    expect(status.content).not.toMatch(/secrets\.yml|\.env/);
  });

  it('uses the active policy (policy.json); an empty list still hides credentials', async () => {
    const { dir: home, cleanup: rmHome } = await tempDir();
    try {
      await writeFile(
        path.join(home, 'policy.json'),
        JSON.stringify({ forbiddenPaths: ['config/app.yml'] }),
      );
      const { bus } = await createToolBus({ kpaiHome: home });
      const r = await bus.call(call('git.diff', {}), makeCtx(root));
      expect(r.content).toBe('(no output)');
    } finally {
      await rmHome();
    }
    const open = new LocalToolBus({ tools: gitTools({ forbiddenPaths: [] }) });
    const r = await open.call(call('git.diff', {}), makeCtx(root));
    expect(r.content).toContain('+port: 2');
    expect(r.content).not.toMatch(/hunter2-prod|supersecret/);
  });

  it('defence in depth: drops forbidden sections and status lines from raw output', () => {
    const zones = zoneSetFromGlobs(['.env', '**/*secret*'], false);
    const diff = [
      'diff --git a/.env b/.env',
      '+X=supersecret',
      'diff --git a/src/a.ts b/src/a.ts',
      '+ok',
      'diff --git a/x b/config/secrets.yml',
      '+hunter2',
      '',
    ].join('\n');
    const out = filterDiff(diff, zones);
    expect(out).toBe(
      'diff --git a/src/a.ts b/src/a.ts\n+ok\n[2 entries in forbidden zones omitted]\n',
    );
    const status = '## main\n M .env\n M src/a.ts\nR  old.txt -> my-secret.txt\n';
    expect(filterStatus(status, zones)).toBe(
      '## main\n M src/a.ts\n[2 entries in forbidden zones omitted]\n',
    );
    const none: ZoneSet = { entries: [], relaxed: [], caseInsensitive: false };
    expect(filterDiff(diff, none)).toBe(diff);
    expect(filterStatus(status, none)).toBe(status);
  });

  it('hides files under a forbidden directory even with diff.noprefix or mnemonicPrefix (NF-1)', async () => {
    await mkdir(path.join(root, 'config', 'secrets'));
    await writeFile(path.join(root, 'config', 'secrets', 'prod.yaml'), 'base\n');
    git(root, 'add', 'config/secrets');
    git(root, 'commit', '-qm', 'secrets dir');
    await writeFile(path.join(root, 'config', 'secrets', 'prod.yaml'), 'PROD_PW=hunter3\n');
    const bus = new LocalToolBus({ tools: gitTools() });
    for (const setting of ['diff.noprefix', 'diff.mnemonicPrefix']) {
      git(root, 'config', setting, 'true');
      const r = await bus.call(call('git.diff', {}), makeCtx(root));
      expect(r.content).toContain('+port: 2');
      expect(r.content).not.toMatch(/hunter3|prod\.yaml/);
      git(root, 'config', '--unset', setting);
    }
  });

  it('fails closed on a diff header it cannot parse', () => {
    const zones = zoneSetFromGlobs([], false);
    const out = filterDiff('diff --git weird header\n+leak\n', zones);
    expect(out).not.toContain('+leak');
    expect(out).toContain('1 entry in forbidden zones omitted');
  });

  it('git.status runs no repository hook, even when the index is stale (NF-2)', async () => {
    await writeFile(path.join(root, 'clean.txt'), 'clean\n');
    git(root, 'add', 'clean.txt');
    git(root, 'commit', '-qm', 'clean');
    // Installed after the test's own git calls, which would otherwise fire it.
    const marker = path.join(root, 'HOOK_RAN');
    const hook = path.join(root, '.git', 'hooks', 'post-index-change');
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, `#!/bin/sh\necho x > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    const old = new Date('2020-01-01');
    await utimes(path.join(root, 'clean.txt'), old, old);
    const bus = new LocalToolBus({ tools: gitTools() });
    expect((await bus.call(call('git.status', {}), makeCtx(root))).isError).toBe(false);
    await expect(stat(marker)).rejects.toThrow();
  });

  it('turns globs into git exclude pathspecs', () => {
    expect(
      excludePathspecs({
        entries: ['.env', 'secrets/', 'private/**', 'a/b.txt', ''].map((glob) => ({
          glob,
          tier: 'added' as const,
          origin: 'caller' as const,
        })),
        relaxed: [],
        caseInsensitive: true,
      }),
    ).toEqual([
      ':(exclude,glob,icase)**/.env',
      ':(exclude,glob,icase)**/.env/**',
      ':(exclude,glob,icase)**/secrets',
      ':(exclude,glob,icase)**/secrets/**',
      ':(exclude,glob,icase)private/**',
      ':(exclude,glob,icase)private',
      ':(exclude,glob,icase)a/b.txt',
      ':(exclude,glob,icase)a/b.txt/**',
    ]);
  });
});

describe('git pathspecs match the zone decision exactly', () => {
  const NAMES = [
    '.env',
    '.env.',
    '.env.e',
    '.env.exampl',
    '.env.example',
    '.env.examplex',
    '.env.exbmple',
    '.env.sample',
    '.env.samples',
    '.env.template',
    '.env.templat',
    '.env.local',
    '.env.production',
    '.env.Example',
    '.env.SAMPLE',
    '.env.dist',
    'notes.md',
  ];

  it.each([false, true])('for every .env name (caseInsensitive %s)', async (ci) => {
    const { dir, cleanup } = await tempDir();
    try {
      git(dir, 'init', '-q');
      await mkdir(path.join(dir, 'sub'));
      // On a case-insensitive file system (macOS, Windows) `.env.Example` and `.env.example`
      // are one file: keep the first spelling of each name only.
      await writeFile(path.join(dir, 'probe.txt'), 'x');
      const icaseFs = await stat(path.join(dir, 'PROBE.TXT')).then(
        () => true,
        () => false,
      );
      await unlink(path.join(dir, 'probe.txt'));
      const seen = new Set<string>();
      const names = NAMES.filter((n) => {
        const key = icaseFs ? n.toLowerCase() : n;
        return !seen.has(key) && (seen.add(key), true);
      });
      for (const n of names) {
        await writeFile(path.join(dir, n), 'x\n');
        await writeFile(path.join(dir, 'sub', n), 'x\n');
      }
      const zones = zoneSetFromGlobs(DEFAULT_ZONES, ci);
      const out = git(dir, 'ls-files', '-o', '--', '.', ...excludePathspecs(zones));
      const listed = new Set(out.split('\n').filter(Boolean));
      for (const n of names) {
        for (const p of [n, `sub/${n}`]) {
          expect(listed.has(p), `${p} (ci ${ci})`).toBe(!inForbiddenZone(p, zones));
        }
      }
    } finally {
      await cleanup();
    }
  });

  it('keeps credential pathspecs while a relaxation drops the heuristic ones', () => {
    const zones = { ...zoneSetFromGlobs(DEFAULT_ZONES, false) };
    const relaxed = { ...zones, relaxed: [{ pack: 'p', allow: 'detections/**', reason: 'r' }] };
    const before = excludePathspecs(zones);
    const after = excludePathspecs(relaxed);
    expect(before).toContain(':(exclude,glob)**/*secret*');
    expect(after).not.toContain(':(exclude,glob)**/*secret*');
    expect(after).toContain(':(exclude,glob)**/id_rsa*');
    expect(after).toContain(':(exclude,glob)**/.env');
    expect(envCredentialGlobs()).toContain('.env.[!est]*');
  });
});

describe('submodules never run their filters (N4)', () => {
  let base: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: base, cleanup } = await tempDir());
    const sub = path.join(base, 'sub');
    const sup = path.join(base, 'sup');
    await mkdir(sub);
    await mkdir(sup);
    git(sub, 'init', '-q');
    await writeFile(path.join(sub, 'g.txt'), 'g\n');
    await writeFile(path.join(sub, '.gitattributes'), '* filter=y\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-qm', 'sub');
    git(sup, 'init', '-q');
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm');
    git(sup, 'commit', '-qm', 'sup');
    // r3/sup: the submodule's own config defines the filter; it leaves ../PWNED2.
    const sm = path.join(sup, 'sm');
    git(sm, 'config', 'filter.y.clean', `node -e "require('fs').writeFileSync('../PWNED2','')"`);
    await new Promise((r) => setTimeout(r, 1100));
    await writeFile(path.join(sm, 'g.txt'), 'changed\n');
  });
  afterEach(() => cleanup());

  it('git.status and git.diff in the superproject do not descend (status.mjs)', async () => {
    const sup = path.join(base, 'sup');
    const bus = new LocalToolBus({ tools: gitTools() });
    const status = await bus.call(call('git.status', {}), makeCtx(sup));
    expect(status.isError, status.content).toBe(false);
    const diff = await bus.call(call('git.diff', {}), makeCtx(sup));
    expect(diff.isError, diff.content).toBe(false);
    await expect(stat(path.join(sup, 'PWNED2'))).rejects.toThrow();
  });
});
