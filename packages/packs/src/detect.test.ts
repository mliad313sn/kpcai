import { afterEach, describe, expect, it } from 'vitest';
import { acceptsWorkspace, detectPacks, GENERIC_PACK_ID, walk } from './detect.js';
import { BUILTIN_PACK_DIR, loadPacks } from './load.js';
import type { Pack } from './schema.js';
import { addSymlink, cleanup, makeTree } from './test-helpers/tmp.js';

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const r = await makeTree(files);
  roots.push(r);
  return r;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanup));
});

async function builtins(): Promise<Pack[]> {
  const res = await loadPacks({ builtinDir: BUILTIN_PACK_DIR, home: '/nonexistent' });
  return res.packs.map((p) => p.pack);
}

describe('detectPacks', () => {
  it('suggests data-science from a notebook', async () => {
    const root = await tree({ 'analysis.ipynb': '{}', 'data/sales.csv': 'a,b\n1,2' });
    const det = await detectPacks(root, await builtins());
    expect(det.suggestions[0]?.id).toBe('data-science');
    expect(det.suggestions[0]?.needsOptIn).toBe(false);
  });

  it('flags a lone binary as opt-in only', async () => {
    const root = await tree({ 'crackme.elf': 'x' });
    const det = await detectPacks(root, await builtins());
    const re = det.suggestions.find((s) => s.id === 'reverse-engineering');
    expect(re?.needsOptIn).toBe(true);
  });

  it('falls back to the generic pack when nothing matches', async () => {
    const root = await tree({ 'notes.txt': 'hello' });
    const det = await detectPacks(root, await builtins());
    expect(det.suggestions).toHaveLength(1);
    expect(det.suggestions[0]?.id).toBe(GENERIC_PACK_ID);
  });

  it('suggests the smart-home pack from a Home Assistant config', async () => {
    const root = await tree({ 'configuration.yaml': 'x', 'automations.yaml': '[]' });
    const det = await detectPacks(root, await builtins());
    expect(det.suggestions.map((s) => s.id)).toContain('smart-home');
  });
});

describe('walk is jailed and bounded', () => {
  it('does not follow a symlink out of the root', async () => {
    const outside = await tree({ 'secret.ipynb': '{}' });
    const root = await tree({ 'readme.md': '#' });
    await addSymlink(root, 'escape', outside);
    const { entries } = await walk(root);
    expect(entries.some((e) => e.rel.startsWith('escape'))).toBe(false);
  });

  it('stops at the entry bound and reports truncation', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`f${i}.txt`] = 'x';
    const root = await tree(files);
    const { truncated, scanned } = await walk(root, { maxEntries: 10 });
    expect(truncated).toBe(true);
    expect(scanned).toBeLessThanOrEqual(10);
  });
});

describe('acceptsWorkspace', () => {
  it('accepts a folder of CSVs that the old guard would refuse', async () => {
    const root = await tree({ 'sales.csv': 'a,b', 'readme.md': '#' });
    const res = await acceptsWorkspace(root, await builtins());
    expect(res.accepted).toBe(true);
    expect(res.by?.pack).toBe('data-science');
  });

  it('asks before accepting a folder whose only marker is opt-in', async () => {
    const root = await tree({ 'firmware.bin': 'x' });
    const res = await acceptsWorkspace(root, await builtins());
    expect(res.accepted).toBe(false);
    expect(res.askOptIn).toContain('reverse-engineering');
  });

  it('accepts an opt-in folder once the pack is opted in', async () => {
    const root = await tree({ 'firmware.bin': 'x' });
    const res = await acceptsWorkspace(root, await builtins(), new Set(['reverse-engineering']));
    expect(res.accepted).toBe(true);
  });
});
