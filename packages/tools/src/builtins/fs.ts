import { lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '@kernelpai/core';
import { resolveInRoot, toPosixRel, touchesGitDir, type JailedPath } from '../paths.js';
import { ok, ToolError, type LocalTool } from '../types.js';

/** Bytes read by `fs.read` at most (the bus also caps what reaches the model). */
export const FS_READ_MAX_BYTES = 256 * 1024;
const LIST_MAX_ENTRIES = 2000;
const SKIP_RECURSION = new Set(['.git', 'node_modules']);

const str = { type: 'string' } as const;

async function jailWrite(ctx: ToolContext, p: unknown): Promise<JailedPath> {
  const j = await resolveInRoot(ctx.root, p, { noFinalSymlink: true });
  if (j.rel === '.') throw new ToolError('refusing to act on the workspace root itself');
  if (touchesGitDir(j.rel)) throw new ToolError(`refusing to modify the .git directory: ${j.rel}`);
  return j;
}

async function listDir(abs: string, rel: string, recursive: boolean, out: string[]): Promise<void> {
  const entries = await readdir(abs, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= LIST_MAX_ENTRIES) return;
    const child = rel === '.' ? e.name : `${rel}/${e.name}`;
    const suffix = e.isDirectory() ? '/' : e.isSymbolicLink() ? '@' : '';
    out.push(child + suffix);
    if (recursive && e.isDirectory() && !SKIP_RECURSION.has(e.name)) {
      await listDir(path.join(abs, e.name), child, true, out);
    }
  }
}

const fsList: LocalTool = {
  def: {
    name: 'fs.list',
    description:
      'List files under a workspace directory. Directories end with "/", symlinks with "@".',
    inputSchema: {
      type: 'object',
      properties: { path: str, recursive: { type: 'boolean' } },
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
  async run(input, ctx) {
    const j = await resolveInRoot(ctx.root, input.path ?? '.', { mustExist: true });
    const out: string[] = [];
    await listDir(j.abs, j.rel, input.recursive === true, out);
    const more = out.length >= LIST_MAX_ENTRIES ? `\n[listing stopped at ${LIST_MAX_ENTRIES}]` : '';
    return ok(out.join('\n') + more, { path: j.rel, entries: out.length });
  },
};

const fsRead: LocalTool = {
  def: {
    name: 'fs.read',
    description: 'Read a UTF-8 text file in the workspace (up to 256 kB from `offset`).',
    inputSchema: {
      type: 'object',
      properties: { path: str, offset: { type: 'integer', minimum: 0 } },
      required: ['path'],
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
  async run(input, ctx) {
    const j = await resolveInRoot(ctx.root, input.path, { mustExist: true });
    const st = await lstat(j.abs);
    if (!st.isFile()) throw new ToolError(`not a regular file: ${j.rel}`);
    const offset = typeof input.offset === 'number' ? input.offset : 0;
    const fh = await open(j.abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(FS_READ_MAX_BYTES, Math.max(0, st.size - offset)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      const more = offset + bytesRead < st.size ? `\n[file continues: ${st.size} bytes total]` : '';
      return ok(buf.subarray(0, bytesRead).toString('utf8') + more, {
        path: j.rel,
        bytes: bytesRead,
        size: st.size,
      });
    } finally {
      await fh.close();
    }
  },
};

const fsWrite: LocalTool = {
  def: {
    name: 'fs.write',
    description: 'Create or overwrite a text file in the workspace (parent folders are created).',
    inputSchema: {
      type: 'object',
      properties: { path: str, content: str },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    risk: 'write',
    source: 'builtin',
  },
  async run(input, ctx) {
    const j = await jailWrite(ctx, input.path);
    const content = String(input.content);
    await mkdir(path.dirname(j.abs), { recursive: true });
    // Re-check after creating parents: a racing symlink must not redirect the write.
    const again = await jailWrite(ctx, j.rel);
    await writeFile(again.abs, content, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    return ok(`wrote ${bytes} bytes to ${j.rel}`, { path: j.rel, bytes, created: !j.exists });
  },
};

const fsDelete: LocalTool = {
  def: {
    name: 'fs.delete',
    description: 'Delete a file, or a directory when `recursive` is true.',
    inputSchema: {
      type: 'object',
      properties: { path: str, recursive: { type: 'boolean' } },
      required: ['path'],
      additionalProperties: false,
    },
    risk: 'destructive',
    source: 'builtin',
  },
  async run(input, ctx) {
    const j = await jailWrite(ctx, input.path);
    if (!j.exists) throw new ToolError(`not found: ${j.rel}`);
    const st = await lstat(j.abs);
    if (st.isDirectory() && input.recursive !== true) {
      throw new ToolError(`${j.rel} is a directory; pass recursive: true to delete it`);
    }
    await rm(j.abs, { recursive: input.recursive === true, force: false });
    return ok(`deleted ${toPosixRel(j.rel)}`, { path: j.rel });
  },
};

export const fsTools: readonly LocalTool[] = [fsList, fsRead, fsWrite, fsDelete];
