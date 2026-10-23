import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceProblem } from './workspace.js';

describe('workspaceProblem (review P2-F10)', () => {
  it('refuses the home folder and the filesystem root', () => {
    const home = mkdtempSync(join(tmpdir(), 'kpai-home-'));
    expect(workspaceProblem(home, home)).toMatch(/home folder/);
    expect(workspaceProblem(parse(home).root, home)).toMatch(/filesystem root/);
  });

  it('needs a project marker, or an explicit opt-in file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kpai-ws-'));
    expect(workspaceProblem(dir, '/nowhere')).toMatch(/no project marker/);
    mkdirSync(join(dir, '.git'));
    expect(workspaceProblem(dir, '/nowhere')).toBeUndefined();
    const other = mkdtempSync(join(tmpdir(), 'kpai-ws-'));
    writeFileSync(join(other, '.kernelpai-workspace'), '');
    expect(workspaceProblem(other, '/nowhere')).toBeUndefined();
  });
});
