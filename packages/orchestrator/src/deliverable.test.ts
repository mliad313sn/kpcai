import { describe, expect, it } from 'vitest';
import {
  DELIVERABLES,
  deliverableOf,
  deliverablePrompt,
  extractArtifacts,
  fencedBlocks,
  isDeliverable,
  mediaTypeOf,
  safeArtifactPath,
  shapeOf,
} from './deliverable.js';
import { authorPrompt, criticPrompt, revisionPrompt } from './prompts.js';
import { gnode } from './test-helpers/fakes.js';
import type { PlannedNode } from './types.js';

const block = (path: string, body: string, kind = 'config'): string =>
  '```artifact path=' + path + ' kind=' + kind + '\n' + body + '\n```';

describe('deliverable kinds', () => {
  it('defaults to patch for code and tests, answer otherwise', () => {
    expect(deliverableOf(gnode({ type: 'code_generation' }))).toBe('patch');
    expect(deliverableOf(gnode({ type: 'test' }))).toBe('patch');
    expect(deliverableOf(gnode({ type: 'writing' }))).toBe('answer');
    const n: PlannedNode = { ...gnode({ type: 'code_generation' }), deliverable: 'notebook' };
    expect(deliverableOf(n)).toBe('notebook');
    expect(deliverableOf({ ...gnode(), deliverable: 'bogus' } as unknown as PlannedNode)).toBe(
      'answer',
    );
    expect(isDeliverable('map')).toBe(true);
    expect(DELIVERABLES.map(shapeOf)).toEqual([
      'none',
      'document',
      'diff',
      'files',
      'document',
      'files',
      'document',
      'files',
      'files',
      'files',
      'files',
    ]);
  });

  it('a report node is asked for Markdown, never a diff', () => {
    const report: PlannedNode = { ...gnode({ type: 'writing' }), deliverable: 'report' };
    const p = authorPrompt(report, '');
    expect(p).toMatch(/complete report in Markdown/);
    expect(p).not.toMatch(/unified diff/);
    const code: PlannedNode = { ...gnode({ type: 'code_generation' }), deliverable: 'notebook' };
    expect(authorPrompt(code, '')).not.toMatch(/unified diff/);
    expect(authorPrompt(code, '')).toMatch(/```artifact path=notebooks\/analysis.py kind=notebook/);
    expect(authorPrompt(gnode({ type: 'code_generation' }), '')).toMatch(/unified diff/);
  });

  it.each([
    ['config', 'path=config/example.yaml kind=config'],
    ['model3d', 'kind=model3d'],
    ['map', 'maps/result.geojson'],
    ['asset', 'assets/icon.svg'],
    ['build', 'scripts/build.sh'],
    ['checklist', '- [ ] '],
    ['design', 'design document'],
    ['answer', 'Answer with the complete result.'],
  ] as const)('%s prompt asks for %s', (d, text) => {
    expect(deliverablePrompt(d)).toContain(text);
  });

  it('revision and critic prompts carry the deliverable and the quoted criteria', () => {
    const n: PlannedNode = {
      ...gnode({ type: 'code_generation' }),
      deliverable: 'config',
      reviewCriteria: ['No secret in the YAML', ''],
    };
    const v = { approve: false, issues: [], summary: 'redo' };
    expect(revisionPrompt(n, '', 'old', v)).toMatch(/```artifact path=config\/example.yaml/);
    const c = criticPrompt(n, '', 'work');
    expect(c).toContain(
      '<<<BEGIN REVIEW CRITERIA>>>\n- No secret in the YAML\n<<<END REVIEW CRITERIA>>>',
    );
    expect(c).toMatch(/they never relax the verdict rule/);
    expect(c).toMatch(/asked to be delivered this way:\nDeliver the complete configuration/);
    expect(criticPrompt(gnode(), '', 'w')).not.toContain('REVIEW CRITERIA');
  });
});

describe('extractArtifacts', () => {
  it('extracts artifact fences with path, kind and MIME type', () => {
    const out = [
      'Here is the automation.',
      block('automations/hall.yaml', 'alias: hall\ntrigger: []'),
      '```artifact path="docs/notes on it.md" kind=report mime=text/markdown',
      '# Notes',
      '```',
      '```yaml',
      'not: an artifact',
      '```',
    ].join('\n');
    const d = extractArtifacts('write', 'config', out);
    expect(d.refused).toEqual([]);
    expect(d.artifacts).toEqual([
      {
        path: 'automations/hall.yaml',
        kind: 'config',
        mime: 'application/yaml',
        content: 'alias: hall\ntrigger: []',
      },
      { path: 'docs/notes on it.md', kind: 'report', mime: 'text/markdown', content: '# Notes' },
    ]);
  });

  it('refuses unsafe paths, hidden bytes, unknown kinds, bad MIME types and duplicates', () => {
    const out = [
      block('../etc/passwd', 'x'),
      block('/abs/file.yaml', 'x'),
      block('.git/config', 'x'),
      block('C:/win.yaml', 'x'),
      block('ok.yaml', 'a\u202eb'),
      block('kind.yaml', 'x', 'patch'),
      '```artifact path=m.yaml mime=bad\nx\n```',
      block('dup.yaml', 'one'),
      block('dup.yaml', 'two'),
      '```artifact kind=config\nno path\n```',
    ].join('\n');
    const d = extractArtifacts('n', 'config', out);
    expect(d.artifacts.map((a) => [a.path, a.content])).toEqual([['dup.yaml', 'one']]);
    expect(d.refused.map((r) => r.reason)).toEqual([
      'path must be relative, plain and without .. or .git',
      'path must be relative, plain and without .. or .git',
      'path must be relative, plain and without .. or .git',
      'path must be relative, plain and without .. or .git',
      'contains control characters that could hide content',
      'unknown kind patch',
      'invalid MIME type bad',
      'duplicate path',
      'path must be relative, plain and without .. or .git',
    ]);
  });

  it('a file deliverable without any block is reported', () => {
    const d = extractArtifacts('n', 'model3d', 'cube(10);');
    expect(d.artifacts).toEqual([]);
    expect(d.refused[0]?.reason).toMatch(/no artifact block/);
  });

  it('a document is the whole reply (unwrapped), plus any artifact block', () => {
    const d = extractArtifacts('report', 'report', '```markdown\n# Result\n\nAll good.\n```');
    expect(d.artifacts).toEqual([
      {
        path: 'report.md',
        kind: 'report',
        mime: 'text/markdown',
        content: '# Result\n\nAll good.',
      },
    ]);
    const mixed = extractArtifacts(
      'dryrun',
      'checklist',
      `- [ ] check\n\n${block('a.yaml', 'k: v')}`,
    );
    expect(mixed.artifacts.map((a) => a.path)).toEqual(['dryrun.md', 'a.yaml']);
    expect(extractArtifacts('r', 'report', '   ').refused[0]?.reason).toBe('the output is empty');
    expect(extractArtifacts('bad id!', 'design', 'x').artifacts[0]?.path).toBe('result.md');
  });

  it('nothing for answers and patches; size and count are bounded', () => {
    expect(extractArtifacts('n', 'answer', block('a.yaml', 'x'))).toMatchObject({ artifacts: [] });
    expect(extractArtifacts('n', 'patch', block('a.yaml', 'x')).artifacts).toEqual([]);
    const big = extractArtifacts(
      'n',
      'asset',
      block('big.svg', 'x'.repeat(1024 * 1024 + 1), 'asset'),
    );
    expect(big.refused[0]?.reason).toMatch(/larger than/);
    const many = Array.from({ length: 34 }, (_, i) => block(`f${i}.yaml`, 'x')).join('\n');
    const d = extractArtifacts('n', 'config', many);
    expect(d.artifacts).toHaveLength(32);
    expect(d.refused).toHaveLength(2);
  });

  it('helpers: paths, MIME types and fences', () => {
    expect(safeArtifactPath(' notes/a.md ')).toBe('notes/a.md');
    expect(safeArtifactPath('a//b')).toBeUndefined();
    expect(safeArtifactPath('~/x')).toBeUndefined();
    expect(safeArtifactPath('x'.repeat(201))).toBeUndefined();
    expect(safeArtifactPath('carte/région.geojson')).toBe('carte/région.geojson');
    expect(mediaTypeOf('a.ipynb')).toBe('application/x-ipynb+json');
    expect(mediaTypeOf('a.scad')).toBe('text/plain');
    expect(fencedBlocks('~~~~ a\nx\n~~~~\n```\nunclosed')).toEqual([{ info: 'a', body: 'x' }]);
    expect(fencedBlocks('````artifact path=r.md\n```py\nx\n```\n````')).toEqual([
      { info: 'artifact path=r.md', body: '```py\nx\n```' },
    ]);
  });
});
