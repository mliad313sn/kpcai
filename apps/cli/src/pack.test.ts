import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';

function io(files: Record<string, string> = {}): FakeIo {
  const f = fakeIo();
  f.cwd = mkdtempSync(join(tmpdir(), 'kpai-pack-cli-'));
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(f.cwd, rel), text);
  return f;
}

describe('kpai pack (WI-S1-05)', () => {
  it('lists the built-in packs and shows one, unverified tools marked [U]', async () => {
    const f = io();
    expect(await main(['pack', 'list'], f)).toBe(0);
    expect(f.stdout).toMatch(/^data-science\s+.*\(builtin\)$/m);
    f.stdout = '';
    expect(await main(['pack', 'show', 'reverse-engineering'], f)).toBe(0);
    expect(f.stdout).toMatch(/^reverse-engineering — /);
    expect(f.stdout).toMatch(/safety: needs an authorised scope/);
    expect(f.stdout).toMatch(/never installed/);
    expect(await main(['pack', 'show', 'nope'], f)).toBe(1);
    expect(await main(['pack', 'show'], f)).toBe(2);
  });

  it('detects a notebook folder as data-science, with its evidence', async () => {
    const f = io({ 'analysis.ipynb': '{}' });
    expect(await main(['pack', 'detect'], f)).toBe(0);
    expect(f.stdout).toMatch(/^data-science\s+score \d.*analysis\.ipynb/m);
    const bin = io({ 'firmware.bin': 'x' });
    await main(['pack', 'detect'], bin);
    expect(bin.stdout).toMatch(/reverse-engineering.*needs your opt-in/);
  });

  it('check reports errors with hints and exits 1; init writes a pack that checks', async () => {
    const f = io({ 'bad.yaml': 'id: Bad Id\nname: x\nmodel: gpt\n' });
    expect(await main(['pack', 'check', join(f.cwd, 'bad.yaml')], f)).toBe(1);
    expect(f.stderr).toMatch(/error in .*bad\.yaml/);
    expect(await main(['pack', 'validate'], f)).toBe(2);
    const out = join(f.cwd, 'mine.yaml');
    expect(await main(['pack', 'init', 'my-lab', '--out', out], f)).toBe(0);
    expect(readFileSync(out, 'utf8')).toMatch(/^id: my-lab$/m);
    expect(await main(['pack', 'check', out], f)).toBe(0);
    expect(f.stdout).toMatch(/ok: my-lab/);
    expect(await main(['pack', 'init', 'my-lab', '--out', out], f)).toBe(1);
    expect(await main(['pack', 'init', 'Bad Id'], f)).toBe(2);
    expect(await main(['pack', 'init', 'home-lab'], f)).toBe(0);
    expect(f.stdout).toMatch(/packs\/home-lab\.yaml/);
    expect(await main(['pack', 'frobnicate'], f)).toBe(2);
  });
});
