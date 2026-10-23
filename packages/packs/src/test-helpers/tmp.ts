import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A disposable directory tree for tests. Files are written from a path→content map. */
export async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kppacks-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return root;
}

export async function addSymlink(root: string, link: string, target: string): Promise<void> {
  const abs = path.join(root, link);
  await mkdir(path.dirname(abs), { recursive: true });
  await symlink(target, abs);
}

export async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** A minimal valid pack YAML with the given id and extra lines. */
export function packYaml(id: string, extra = ''): string {
  return `id: ${id}\nname: ${id}\ndescription: pack ${id} for tests\nprofiles: [tester]\n${extra}`;
}
