import type { TaskGraph } from '@kernelpai/core';
import type { NodeDeliverable, RunResult } from '@kernelpai/orchestrator';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_KINDS, artifactProblem, collectArtifacts } from './artifacts.js';

const ref = (provider: string) => ({ provider, model: 'm' });
const node = (id: string) => ({
  id,
  title: id,
  type: 'writing',
  protocol: 'author_critic',
  criticality: 'normal',
  dependsOn: [],
  messages: [],
});
const graph = {
  id: 'g',
  request: 'r',
  createdBy: 'template',
  reason: '',
  nodes: ['reviewed', 'solo', 'rejected', 'solofile', 'failed', 'late'].map(node),
} as unknown as TaskGraph;

const art = (path: string, kind: string, content = 'same\n') => ({
  path,
  kind,
  mime: 'text/markdown',
  content,
});
const deliv = (nodeId: string, artifacts: unknown[], refused: unknown[] = []): NodeDeliverable =>
  ({ nodeId, deliverable: 'report', artifacts, refused }) as NodeDeliverable;
const res = (nodeId: string, approved: boolean | undefined, ok = true) => ({
  nodeId,
  protocol: 'author_critic',
  ok,
  ...(approved === undefined ? {} : { approved }),
  costUsd: 0,
  output: '',
  contributions: [
    { role: 'author', ref: ref('p1'), text: '', costUsd: 0 },
    { role: 'critic', ref: ref('p2'), text: '', costUsd: 0 },
    { role: 'revision', ref: ref('p3'), text: '', costUsd: 0 },
  ],
});

const result = {
  graphId: 'g',
  costUsd: 0,
  ok: true,
  states: {},
  results: {
    reviewed: res('reviewed', true),
    solo: res('solo', undefined),
    rejected: res('rejected', false),
    solofile: res('solofile', undefined),
    failed: res('failed', true, false),
    late: res('late', true),
  },
  deliverables: {
    reviewed: deliv(
      'reviewed',
      [art('r.md', 'report'), art('r.md', 'report'), art('cfg.yaml', 'config'), art('x', 'nope')],
      [{ path: '../e', reason: 'path must be relative' }],
    ),
    solo: deliv('solo', [art('s.md', 'checklist'), art('r.md', 'report')]),
    rejected: deliv('rejected', [art('no.md', 'report')]),
    solofile: deliv('solofile', [art('m.scad', 'model3d')]),
    failed: deliv('failed', [art('f.md', 'report')]),
    late: deliv('late', [art('s.md', 'checklist')]),
  },
} as unknown as RunResult;

describe('collectArtifacts (ADR-0022, D-020 ruling)', () => {
  const r = collectArtifacts(graph, result, { runId: 'run', sessionId: 's' });

  it('keeps reviewed artifacts with provenance and digest, without duplicates', () => {
    expect(r.artifacts.map((a) => [a.path, a.reviewed, a.nodeId])).toEqual([
      ['r.md', true, 'reviewed'],
      ['cfg.yaml', true, 'reviewed'],
      // The unreviewed copy was replaced by the reviewed twin of a later node.
      ['s.md', true, 'late'],
    ]);
    expect(r.artifacts[0]).toMatchObject({
      bytes: 5,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      provenance: { runId: 'run', nodeId: 'reviewed', author: ref('p3'), reviewer: ref('p2') },
    });
  });

  it('an unreviewed document has no reviewer in its provenance', () => {
    const only = collectArtifacts(
      graph,
      { ...result, deliverables: { solo: result.deliverables.solo } } as RunResult,
      {
        runId: 'run',
        sessionId: 's',
      },
    );
    expect(only.artifacts[0]).toMatchObject({ path: 's.md', reviewed: false });
    expect(only.artifacts[0]?.provenance.reviewer).toBeUndefined();
  });

  it('keeps unreviewed documents only; refuses rejected work, unreviewed files and bad blocks', () => {
    expect(r.refused).toEqual([
      { nodeId: 'reviewed', path: '../e', reason: 'path must be relative' },
      { nodeId: 'reviewed', path: 'x', reason: expect.stringMatching(/unknown kind/) },
      { nodeId: 'rejected', path: 'no.md', reason: 'the critic did not approve it' },
      { nodeId: 'solofile', path: 'm.scad', reason: expect.stringMatching(/only documents/) },
    ]);
  });
});

describe('artifactProblem', () => {
  it('re-checks kind, path, size and hidden bytes', () => {
    expect(ARTIFACT_KINDS).toContain('checklist');
    expect(ARTIFACT_KINDS).not.toContain('patch');
    const check = (p: string, k: string, c = 'x\n') => artifactProblem(p, k, c)?.split(' ')[0];
    expect(check('a.md', 'movie')).toBe('unknown');
    expect(check('', 'report')).toBe('missing');
    for (const p of ['/etc/passwd', 'a/../b', '.git/config', 'C:\\x', 'a//b'])
      expect(check(p, 'config')).toBe('path');
    expect(check('a.md', 'report', 'a'.repeat(1024 * 1024 + 1))).toBe('larger');
    expect(check('a.md', 'report', 'evil\u202e')).toBe('contains');
    expect(check('ok.md', 'report')).toBeUndefined();
  });
});
