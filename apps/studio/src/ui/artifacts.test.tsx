// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Artifact } from '../store/types';
import { ArtifactBody } from './ArtifactsView';
import { PlanBar } from './PlanBar';
import { initialState, studio } from '../store/store';
import { GRAPH, ESTIMATE, PATCH } from '../test-helpers/fixtures';

afterEach(() => cleanup());

const art = (over: Partial<Artifact>): Artifact => ({
  path: 'a.txt',
  kind: 'report',
  text: 'hello',
  provenance: [],
  ...over,
});

describe('artifact bodies by deliverable (WI-S6-01)', () => {
  it('shows a patch as a diff, a notebook as cells, a report as text', () => {
    render(<ArtifactBody a={art({ kind: 'patch', text: PATCH })} />);
    expect(document.querySelector('pre.diff')).toBeTruthy();
    cleanup();
    const nb = {
      cells: [
        { cell_type: 'markdown', source: ['# T', 'itle'] },
        { cell_type: 'code', source: 'print(1)' },
        {},
      ],
    };
    render(<ArtifactBody a={art({ kind: 'notebook', text: JSON.stringify(nb) })} />);
    expect(screen.getByText('Cell 1 (markdown)')).toBeTruthy();
    expect(screen.getByText('# Title')).toBeTruthy();
    expect(screen.getByText('Cell 3 (?)')).toBeTruthy();
    cleanup();
    render(<ArtifactBody a={art({ kind: 'notebook', text: 'not json' })} />);
    expect(screen.getByText('not json')).toBeTruthy();
    cleanup();
    render(<ArtifactBody a={art({ kind: 'notebook', text: '{"x":1}' })} />);
    expect(screen.getByText('{"x":1}')).toBeTruthy();
    cleanup();
    render(<ArtifactBody a={art({ kind: 'model3d', text: '' })} />);
    expect(screen.getByText(/No text preview/)).toBeTruthy();
  });
});

describe('plan bar extras (R-306, D-020)', () => {
  it('lists rule files, packs, limits and scope problems', async () => {
    studio.setState(initialState(), true);
    const plan = {
      planId: 'p1',
      request: 'r',
      graph: GRAPH,
      original: GRAPH,
      estimate: ESTIMATE,
      checking: false,
      rules: {
        trust: 'untrusted' as const,
        files: [
          {
            path: 'AGENTS.md',
            kind: 'agents',
            scope: '.',
            applies: true,
            bytes: 10,
            truncated: false,
          },
          {
            path: 'x/CLAUDE.md',
            kind: 'claude',
            scope: 'x',
            applies: false,
            bytes: 1,
            truncated: false,
          },
        ],
        truncated: false,
        omitted: [],
        skippedForbidden: 2,
      },
      packs: {
        packs: [
          {
            id: 're',
            name: 'Reverse engineering',
            reason: 'found firmware',
            evidence: [],
            requiresScope: true,
            preferLocal: true,
            physicalEffects: false,
            personalData: false,
            limits: ['own devices only'],
          },
        ],
        zones: [],
        relaxed: [],
        pending: [],
        refused: [],
        lines: ['zone *.bin relaxed by re'],
        problems: [],
      },
      scope: { required: ['re'], lines: ['scope: lab'], problems: ['expired'] },
    };
    render(<PlanBar plan={plan as never} />);
    expect(
      screen.getByText(/Repository rules given to every node as untrusted context: AGENTS\.md/),
    ).toBeTruthy();
    expect(screen.getByText(/2 rule files in forbidden zones were not read/)).toBeTruthy();
    expect(
      screen.getByText(/Pack Reverse engineering: found firmware Limits: own devices only/),
    ).toBeTruthy();
    expect(screen.getByText('zone *.bin relaxed by re')).toBeTruthy();
    expect(screen.getByText('Authorised scope: expired')).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Plan' })).getByRole('button', { name: /^Run/ }),
    ).toHaveProperty('disabled', true);
  });
});
