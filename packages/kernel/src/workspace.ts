import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  '.kernelpai-workspace',
];

/**
 * Tools act inside the working directory, so it must be a project, not the home folder
 * or a drive root where `.ssh`, `.aws` and the like live (review P2-F10). Undefined when fine.
 */
export function workspaceProblem(cwd: string, home: string = homedir()): string | undefined {
  const dir = resolve(cwd);
  if (dir === resolve(home))
    return 'the working directory is your home folder; run kpai inside a project';
  if (dir === parse(dir).root)
    return 'the working directory is a filesystem root; run kpai inside a project';
  if (!PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) {
    return `no project marker here (${PROJECT_MARKERS.join(', ')}); create .kernelpai-workspace to allow this folder`;
  }
  return undefined;
}
