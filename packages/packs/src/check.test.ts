import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { checkPackFiles, checkPackText } from './check.js';
import { cleanup, makeTree, packYaml } from './test-helpers/tmp.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanup));
});

describe('checkPackText', () => {
  it('reports ok with a summary for a valid pack', () => {
    const r = checkPackText(packYaml('ok-pack', 'markers: [{ glob: "*.ipynb" }]'));
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toContain('ok: ok-pack');
    expect(r.lines.join('\n')).toContain('marker(s)');
  });

  it('gives an actionable hint for a model id', () => {
    const r = checkPackText(packYaml('m', 'tips: ["use gpt-5 for this"]'));
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toContain('model');
  });

  it('gives a hint for an unknown field', () => {
    const r = checkPackText(packYaml('m', 'markerz: []'));
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/misspelt|supported/);
  });

  it('gives a hint for a broad zone relaxation', () => {
    const r = checkPackText(
      packYaml('m', 'zones: { relax: [{ allow: "config/**", reason: "r" }] }'),
    );
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toContain('relax a named folder');
  });
});

describe('checkPackFiles', () => {
  it('validates files on disk and reports an unreadable one', async () => {
    const root = await makeTree({ 'a.yaml': packYaml('a'), 'b.yaml': 'name: no id' });
    roots.push(root);
    const reports = await checkPackFiles([
      path.join(root, 'a.yaml'),
      path.join(root, 'b.yaml'),
      path.join(root, 'missing.yaml'),
    ]);
    expect(reports[0]?.ok).toBe(true);
    expect(reports[1]?.ok).toBe(false);
    expect(reports[2]?.ok).toBe(false);
    expect(reports[2]?.lines[0]).toContain('missing.yaml');
  });
});
