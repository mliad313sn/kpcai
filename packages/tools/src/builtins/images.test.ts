/** S10 R6 J3: file images (SHA-256 before and after a kernel write). */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashFiles, joinImages, MAX_IMAGE_FILES } from './images.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('file images (J3)', () => {
  it('hashes files, says null for an absent one and leaves out what proves nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kp-img-'));
    writeFileSync(join(root, 'a.txt'), 'hello');
    mkdirSync(join(root, 'dir'));
    let linked = true;
    try {
      symlinkSync(join(root, 'a.txt'), join(root, 'link'));
    } catch {
      linked = false; // Windows without the privilege: nothing to check there
    }
    const files = ['a.txt', 'gone.txt', 'dir', ...(linked ? ['link'] : [])];
    expect(await hashFiles(root, files)).toEqual({ 'a.txt': sha('hello'), 'gone.txt': null });
    const many = Array.from({ length: MAX_IMAGE_FILES + 5 }, (_, i) => `f${i}`);
    expect(Object.keys(await hashFiles(root, many))).toHaveLength(MAX_IMAGE_FILES);
  });

  it('joins pre and post per file, keeping files hashed on both sides only', () => {
    expect(joinImages({ a: null, b: 'x', c: 'y' }, { a: 'h', b: null })).toEqual({
      a: { pre: null, post: 'h' },
      b: { pre: 'x', post: null },
    });
  });
});
