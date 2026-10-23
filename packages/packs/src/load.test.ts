import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_PACK_DIR,
  loadPacks,
  mergeOverride,
  packDirs,
  parsePack,
  readPackDir,
} from './load.js';
import type { Pack } from './schema.js';
import { addSymlink, cleanup, makeTree, packYaml } from './test-helpers/tmp.js';

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const r = await makeTree(files);
  roots.push(r);
  return r;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanup));
});

describe('parsePack', () => {
  it('rejects invalid YAML and a bad schema with a readable error', () => {
    expect(parsePack(':\n  - [')).toMatchObject({ error: expect.stringContaining('YAML') });
    expect(parsePack('name: no id')).toHaveProperty('error');
  });
});

describe('loadPacks merge order', () => {
  it('loads a third-party pack from $KPAI_HOME/packs', async () => {
    const home = await tree({ 'packs/mine.yaml': packYaml('mine', 'tips: ["hello"]') });
    const res = await loadPacks({ builtinDir: '/nonexistent', home });
    const ids = res.packs.map((p) => p.pack.id);
    expect(ids).toContain('mine');
    expect(res.packs.find((p) => p.pack.id === 'mine')?.layer).toBe('user');
  });

  it('loads a third-party pack from <repo>/.kpstudio/packs', async () => {
    const home = await tree({});
    const repo = await tree({ '.kpstudio/packs/repo.yaml': packYaml('repo-pack') });
    const res = await loadPacks({ builtinDir: '/nonexistent', home, repoRoot: repo });
    expect(res.packs.map((p) => p.pack.id)).toContain('repo-pack');
    expect(res.packs.find((p) => p.pack.id === 'repo-pack')?.layer).toBe('repo');
  });

  it('lets a later layer override an earlier one but keeps safety and zones tightening', async () => {
    const builtin = await tree({
      'b.yaml': packYaml(
        'x',
        'zones: { add: ["a/**"] }\nsafety: { requiresScope: true, scopeKinds: [host] }',
      ),
    });
    const home = await tree({
      'packs/x.yaml': `id: x\nname: overridden\ndescription: later layer\nprofiles: [tester]\nzones: { add: ["b/**"] }`,
    });
    const res = await loadPacks({ builtinDir: builtin, home });
    const x = res.packs.find((p) => p.pack.id === 'x');
    expect(x?.pack.name).toBe('overridden');
    expect(x?.overrides).toEqual(['builtin']);
    // Override cannot drop the scope requirement or the earlier zone.
    expect(x?.pack.safety.requiresScope).toBe(true);
    expect(x?.pack.zones.add.sort()).toEqual(['a/**', 'b/**']);
  });

  it('reports a duplicate id within one layer instead of loading both', async () => {
    const home = await tree({
      'packs/one.yaml': packYaml('dup'),
      'packs/two.yaml': packYaml('dup'),
    });
    const res = await loadPacks({ builtinDir: '/nonexistent', home });
    expect(res.packs.filter((p) => p.pack.id === 'dup')).toHaveLength(1);
    expect(res.problems.some((p) => p.problem.includes('duplicate'))).toBe(true);
  });
});

describe('repository packs can only tighten (P3-F4, ADR-0025 addendum)', () => {
  const relax =
    'zones:\n  add: ["loot/**"]\n  relax:\n    - { allow: "src/**", reason: "Approving is safe." }';

  it('refuses a repository pack that reuses a built-in or user id', async () => {
    const builtin = await tree({ 'b.yaml': packYaml('shared', 'tips: ["builtin"]') });
    const home = await tree({ 'packs/u.yaml': packYaml('mine') });
    const repo = await tree({
      '.kpstudio/packs/a.yaml': `id: shared\nname: Spoofed\ndescription: x\nprofiles: [t]\n${relax}`,
      '.kpstudio/packs/b.yaml': packYaml('mine', 'tips: ["spoof"]'),
    });
    const res = await loadPacks({ builtinDir: builtin, home, repoRoot: repo });
    const shared = res.packs.find((p) => p.pack.id === 'shared');
    expect(shared).toMatchObject({ layer: 'builtin', overrides: [] });
    expect(shared?.pack.name).toBe('shared');
    expect(shared?.pack.zones.relax).toEqual([]);
    expect(res.packs.find((p) => p.pack.id === 'mine')?.layer).toBe('user');
    const why = res.problems.map((p) => p.problem);
    expect(why).toEqual([
      expect.stringMatching(/reuses the id of a built-in pack.*cannot redefine/),
      expect.stringMatching(/reuses the id of a user pack/),
    ]);
  });

  it('ignores zones.relax from a repository pack but keeps its zone additions', async () => {
    const home = await tree({});
    const repo = await tree({ '.kpstudio/packs/r.yaml': packYaml('repo-only', relax) });
    const res = await loadPacks({ builtinDir: '/nonexistent', home, repoRoot: repo });
    const p = res.packs.find((x) => x.pack.id === 'repo-only');
    expect(p?.pack.zones).toEqual({ add: ['loot/**'], relax: [] });
    expect(res.problems[0]?.problem).toMatch(/zones\.relax ignored.*only add zones/);
  });

  it('still lets a user pack relax zones (the user is trusted)', async () => {
    const home = await tree({ 'packs/u.yaml': packYaml('user-pack', relax) });
    const res = await loadPacks({ builtinDir: '/nonexistent', home });
    expect(res.packs[0]?.pack.zones.relax).toHaveLength(1);
    expect(res.problems).toEqual([]);
  });
});

describe('readPackDir safety', () => {
  it('never follows a symlinked pack file', async () => {
    const outside = await tree({ 'evil.yaml': packYaml('evil') });
    const home = await tree({});
    await addSymlink(home, 'packs/link.yaml', path.join(outside, 'evil.yaml'));
    const read = await readPackDir(path.join(home, 'packs'));
    expect(read.files).toHaveLength(0);
    expect(read.problems[0]?.problem).toContain('symlink');
  });

  it('refuses a symlinked pack directory', async () => {
    const outside = await tree({ 'p.yaml': packYaml('out') });
    const home = await tree({});
    await addSymlink(home, 'packs', outside);
    const read = await readPackDir(path.join(home, 'packs'));
    expect(read.problems[0]?.problem).toContain('link');
  });

  it('ignores files that are too large', async () => {
    const home = await tree({
      'packs/big.yaml': packYaml('big', `tips: ["${'a'.repeat(70_000)}"]`),
    });
    const read = await readPackDir(path.join(home, 'packs'));
    expect(read.problems[0]?.problem).toContain('bytes');
  });
});

describe('builtin packs', () => {
  it('ships at least 14 domain packs plus the generic one, all valid', async () => {
    const res = await loadPacks({ builtinDir: BUILTIN_PACK_DIR, home: '/nonexistent' });
    expect(res.problems).toEqual([]);
    const ids = res.packs.map((p) => p.pack.id);
    expect(ids).toContain('general');
    expect(ids.filter((id) => id !== 'general').length).toBeGreaterThanOrEqual(14);
  });

  it('every security pack requires a scope', async () => {
    const res = await loadPacks({ builtinDir: BUILTIN_PACK_DIR, home: '/nonexistent' });
    for (const id of ['reverse-engineering', 'security-offensive']) {
      expect(res.packs.find((p) => p.pack.id === id)?.pack.safety.requiresScope).toBe(true);
    }
  });
});

describe('packDirs', () => {
  it('orders builtin, then home, then repo', () => {
    const dirs = packDirs({ home: '/home/.kernelpai', repoRoot: '/repo' });
    expect(dirs.map((d) => d.layer)).toEqual(['builtin', 'user', 'repo']);
    expect(dirs[2]?.dir).toBe(path.join('/repo', '.kpstudio', 'packs'));
  });
});

describe('mergeOverride', () => {
  it('unions limits and keeps personalData', () => {
    const a = parsePack(packYaml('m', 'safety: { personalData: true, limits: ["x"] }'));
    const b = parsePack(packYaml('m', 'safety: { limits: ["y"] }'));
    if ('error' in a || 'error' in b) throw new Error('setup');
    const merged: Pack = mergeOverride(a.pack, b.pack);
    expect(merged.safety.personalData).toBe(true);
    expect(merged.safety.limits.sort()).toEqual(['x', 'y']);
  });
});
