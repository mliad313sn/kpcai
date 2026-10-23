import { execFileSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsTools } from './builtins/fs.js';
import { LocalToolBus } from './bus.js';
import { KEYNOTE_SNIFF_BYTES, keynoteProbe, zipNames } from './keynote.js';
import { call, makeCtx, tempDir } from './test-helpers/ctx.js';

/** A stored (uncompressed) zip with local headers and a central directory. */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'latin1');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, e.data);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  return Buffer.concat([...locals, ...centrals]);
}

const PEM =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
const isWin = process.platform === 'win32';

describe('Keynote documents named *.key (WI-S7-01)', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  const bus = new LocalToolBus({ tools: fsTools });
  const read = (p: string) => bus.call(call('fs.read', { path: p }), makeCtx(root));

  beforeEach(async () => {
    ({ dir: root, cleanup } = await tempDir());
    await mkdir(path.join(root, 'slides'));
    const iwa = { name: 'Index/Document.iwa', data: Buffer.from('iwa') };
    await writeFile(path.join(root, 'slides', 'Pitch.key'), zip([iwa]));
    // First entry larger than the sniff window: only the central directory names Keynote.
    const big = { name: 'preview.jpg', data: Buffer.alloc(KEYNOTE_SNIFF_BYTES * 2, 1) };
    await writeFile(path.join(root, 'slides', 'Big.key'), zip([big, iwa]));
    await mkdir(path.join(root, 'slides', 'Old.key'));
    await writeFile(path.join(root, 'slides', 'Old.key', 'Index.zip'), 'zip');
    await mkdir(path.join(root, 'certs.key'));
    await writeFile(path.join(root, 'server.key'), PEM);
    await writeFile(path.join(root, 'other.key'), zip([{ name: 'a.txt', data: Buffer.from(PEM) }]));
    await writeFile(path.join(root, 'tiny.key'), 'PK');
  });
  afterEach(() => cleanup());

  it('reads a Keynote archive or package, refuses key material', async () => {
    for (const p of ['slides/Pitch.key', 'slides/Big.key', 'slides/Old.key/Index.zip']) {
      const r = await read(p);
      expect(r.content, p).not.toMatch(/forbidden zone/);
    }
    for (const p of ['server.key', 'other.key', 'tiny.key', 'missing.key']) {
      expect((await read(p)).content, p).toMatch(/forbidden zone: .*credential/);
    }
    const list = await bus.call(call('fs.list', { path: 'certs.key' }), makeCtx(root));
    expect(list.content).toMatch(/forbidden zone/);
  });

  it('never looks outside the root and fails closed', () => {
    const probe = keynoteProbe(root);
    expect(probe('slides/Pitch.key')).toBe(true);
    expect(probe('.')).toBe(false);
    expect(keynoteProbe(path.join(root, 'slides'))('../server.key')).toBe(false);
    expect(keynoteProbe(path.join(root, 'nope'))('Pitch.key')).toBe(false);
    expect(zipNames(Buffer.from('PK\x03\x04short'))).toEqual([]);
  });

  it.skipIf(isWin)(
    'follows a symlink to judge its target, and never blocks on a FIFO',
    async () => {
      await symlink(path.join(root, 'server.key'), path.join(root, 'deck.key'));
      expect((await read('deck.key')).content).toMatch(/forbidden zone/);
      await symlink(path.join(root, 'slides', 'Pitch.key'), path.join(root, 'link.key'));
      expect((await read('link.key')).content).not.toMatch(/forbidden zone/);
      execFileSync('mkfifo', [path.join(root, 'pipe.key')]);
      expect(keynoteProbe(root)('pipe.key')).toBe(false);
    },
  );
});
