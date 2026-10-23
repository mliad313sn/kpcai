import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalToolBus } from '../bus.js';
import { call, makeCtx, RecordingJournal, tempDir } from '../test-helpers/ctx.js';
import { FS_READ_MAX_BYTES, fsTools } from './fs.js';

const isWin = process.platform === 'win32';

describe('fs built-ins', () => {
  let base: string;
  let root: string;
  let cleanup: () => Promise<void>;
  const bus = new LocalToolBus({ tools: fsTools });
  const yes = () => makeCtx(root, { answers: Array(10).fill(true) });

  beforeEach(async () => {
    ({ dir: base, cleanup } = await tempDir());
    root = path.join(base, 'ws');
    await mkdir(path.join(root, 'src', 'deep'), { recursive: true });
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(root, 'src', 'deep', 'b.ts'), 'b');
    await writeFile(path.join(base, 'outside.txt'), 'top secret');
  });
  afterEach(() => cleanup());

  it('lists, flat and recursive, skipping .git contents', async () => {
    const flat = await bus.call(call('fs.list', {}), yes());
    expect(flat.content.split('\n')).toEqual(['.git/', 'src/']);
    const rec = await bus.call(call('fs.list', { path: 'src', recursive: true }), yes());
    expect(rec.content.split('\n')).toEqual(['src/a.ts', 'src/deep/', 'src/deep/b.ts']);
    const out = await bus.call(call('fs.list', { path: '..' }), yes());
    expect(out.isError).toBe(true);
  });

  it('reads files with an offset and refuses directories and escapes', async () => {
    const r = await bus.call(call('fs.read', { path: 'src/a.ts' }), makeCtx(root));
    expect(r).toEqual({ content: 'export const a = 1;\n', isError: false });
    const o = await bus.call(call('fs.read', { path: 'src/a.ts', offset: 7 }), makeCtx(root));
    expect(o.content).toBe('const a = 1;\n');
    expect((await bus.call(call('fs.read', { path: 'src' }), makeCtx(root))).content).toMatch(
      /not a regular file/,
    );
    const esc = await bus.call(
      call('fs.read', { path: path.join(base, 'outside.txt') }),
      makeCtx(root),
    );
    expect(esc.isError).toBe(true);
    expect(esc.content).not.toContain('top secret');
  });

  it('marks files longer than the read cap', async () => {
    await writeFile(path.join(root, 'big.txt'), 'z'.repeat(FS_READ_MAX_BYTES + 10));
    const bigBus = new LocalToolBus({ tools: fsTools, maxResultBytes: 10 * FS_READ_MAX_BYTES });
    const r = await bigBus.call(call('fs.read', { path: 'big.txt' }), makeCtx(root));
    expect(r.content.endsWith(`[file continues: ${FS_READ_MAX_BYTES + 10} bytes total]`)).toBe(
      true,
    );
  });

  it('writes files, creating parent folders, after confirmation', async () => {
    const ctx = yes();
    const w = await bus.call(call('fs.write', { path: 'new/dir/c.ts', content: 'c' }), ctx);
    expect(w).toEqual({ content: 'wrote 1 bytes to new/dir/c.ts', isError: false });
    expect(await readFile(path.join(root, 'new', 'dir', 'c.ts'), 'utf8')).toBe('c');
    expect(ctx.questions).toHaveLength(1);
    const declined = await bus.call(
      call('fs.write', { path: 'x', content: 'x' }),
      makeCtx(root, { nodeId: 'n9' }),
    );
    expect(declined.isError).toBe(true);
    await expect(stat(path.join(root, 'x'))).rejects.toThrow();
  });

  it('journals the size and hash of written content, never the text', async () => {
    const journal = new RecordingJournal();
    const jbus = new LocalToolBus({ tools: fsTools, journal });
    await jbus.call(call('fs.write', { path: 'k.txt', content: 'tiny secret text' }), yes());
    const input = journal.last().payload.input as Record<string, unknown>;
    expect(input.path).toBe('k.txt');
    expect(input.content).toEqual({ chars: 16, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(journal.events)).not.toContain('tiny secret text');
  });

  it('refuses writes outside root, into .git, onto the root, or through links', async () => {
    for (const p of ['../outside.txt', '.git/hooks/pre-commit', '.', path.join(base, 'pwn.txt')]) {
      const r = await bus.call(call('fs.write', { path: p, content: 'pwn' }), yes());
      expect(r.isError).toBe(true);
    }
    expect(await readFile(path.join(base, 'outside.txt'), 'utf8')).toBe('top secret');
    await symlink(base, path.join(root, 'up'), isWin ? 'junction' : 'dir');
    const viaLink = await bus.call(
      call('fs.write', { path: 'up/outside.txt', content: 'pwn' }),
      yes(),
    );
    expect(viaLink.content).toMatch(/escapes/);
    expect(await readFile(path.join(base, 'outside.txt'), 'utf8')).toBe('top secret');
  });

  it.skipIf(isWin)('refuses to write through a final symlink even inside root', async () => {
    await symlink(path.join(root, 'src', 'a.ts'), path.join(root, 'alias.ts'));
    const r = await bus.call(call('fs.write', { path: 'alias.ts', content: 'x' }), yes());
    expect(r.content).toMatch(/symlink/);
  });

  it('deletes files and directories (recursive only when asked), confirming each', async () => {
    const ctx = yes();
    expect((await bus.call(call('fs.delete', { path: 'src/a.ts' }), ctx)).isError).toBe(false);
    const dir = await bus.call(call('fs.delete', { path: 'src/deep' }), ctx);
    expect(dir.content).toMatch(/recursive: true/);
    const rec = await bus.call(call('fs.delete', { path: 'src/deep', recursive: true }), ctx);
    expect(rec.isError).toBe(false);
    await expect(stat(path.join(root, 'src', 'deep'))).rejects.toThrow();
    expect((await bus.call(call('fs.delete', { path: 'missing' }), ctx)).content).toMatch(
      /not found/,
    );
    expect(
      (await bus.call(call('fs.delete', { path: '.git', recursive: true }), ctx)).content,
    ).toMatch(/\.git/);
    expect(ctx.questions).toHaveLength(5);
  });
});
