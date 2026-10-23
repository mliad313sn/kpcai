/**
 * What `kpai plan` / `kpai do` print: the plan before anything runs (D-021 figures), the live
 * event lines, the outputs, rules, packs and scope. Model and file text is untrusted and is
 * sanitised for the terminal on every path.
 */
import { describe, expect, it } from 'vitest';
import type { GraphEvent, GraphResult, TaskGraph } from '@kernelpai/core';
import type { PackContext, RulesSummary, ScopeCheck } from '@kernelpai/kernel';
import { money } from './config.js';
import {
  renderEvent,
  renderGraphPlan,
  renderOutputs,
  renderPacks,
  renderRules,
  renderScope,
  type PlanEstimate,
} from './graph/render.js';

const m = money({});
const ref = { provider: 'p', model: 'm' };
const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  type: 'code_generation',
  protocol: 'solo',
  criticality: 'normal',
  dependsOn: [],
  messages: [],
  ...extra,
});
const graph = (nodes: unknown[]): TaskGraph =>
  ({ id: 'g', request: 'r', createdBy: 'template', reason: 'why', nodes }) as TaskGraph;

describe('renderGraphPlan', () => {
  it('shows who does what, tools, unroutable nodes and the likely and cap figures', () => {
    const g = graph([
      node('a', { tools: ['fs.read', 'git.diff'] }),
      node('b', { dependsOn: ['a'] }),
      node('c'),
    ]);
    const est = {
      nodes: [
        { nodeId: 'a', protocol: 'solo', ref, minUsd: 0.01, expectedUsd: 0.02 },
        { nodeId: 'b', protocol: 'vote', ref: null, error: 'vote: only 1 distinct provider(s)' },
      ],
      minUsd: 0.01,
      totalUsd: 0.02,
      expectedUsd: 0.02,
      capUsd: 0.05,
      complete: false,
      problems: ['b: vote: only 1 distinct provider(s)'],
      band: { lowUsd: 0.01, highUsd: 0.05, basis: 'heuristic' },
    } as unknown as PlanEstimate;
    const out = renderGraphPlan(g, est, m);
    expect(out).toMatch(/^ {2}a .* p\/m .* tools fs\.read git\.diff$/m);
    expect(out).toMatch(/^ {2}b .*unroutable \(vote: only 1 distinct provider\(s\)\).* ← a$/m);
    expect(out).toMatch(/^ {2}c .*unroutable \(no candidate\)\s+\?$/m);
    expect(out).toMatch(
      /^total {2}likely \$0\.02 · at most \$0\.05 \(cap\) before running \(cannot run as planned: b: vote/m,
    );
  });
});

describe('renderEvent', () => {
  const ev = (e: unknown) => renderEvent(e as GraphEvent, m);

  it('names the reviewer, the end states and the verdicts', () => {
    expect(ev({ type: 'node_state', nodeId: 'n', state: 'review', ref, role: 'critic' })).toBe(
      '  ▸ n review by p/m (critic)\n',
    );
    expect(ev({ type: 'node_state', nodeId: 'n', state: 'running', ref })).toMatch(
      /work by p\/m \(step\)/,
    );
    expect(ev({ type: 'node_state', nodeId: 'n', state: 'skipped' })).toBe('  ■ n skipped\n');
    expect(ev({ type: 'node_state', nodeId: 'n', state: 'running' })).toBeUndefined();
    const verdict = { approve: false, issues: [{ severity: 'major', text: 'x' }], summary: '' };
    const contribution = { role: 'critic', ref, text: '', costUsd: 0.001, verdict };
    expect(ev({ type: 'contribution', nodeId: 'n', contribution })).toMatch(
      /critic .*p\/m.* · changes requested \(1\)\n$/,
    );
    expect(ev({ type: 'graph_done', ok: false, costUsd: 0.5 })).toMatch(
      /graph finished with failures · \$0\.50/,
    );
    expect(ev({ type: 'text', nodeId: 'n', delta: 'x' })).toBeUndefined();
  });
});

describe('renderOutputs', () => {
  it('shows each node state, approval and failure reason, sanitised', () => {
    const g = graph([node('a'), node('b'), node('c')]);
    const r = {
      ok: false,
      costUsd: 0,
      states: { a: 'done', b: 'failed' },
      results: {
        a: { output: 'ok\u001b[31m', approved: false },
        b: { output: '', error: 'boom\u0007' },
      },
    } as unknown as GraphResult;
    const out = renderOutputs(g, r);
    expect(out).toContain('## a — Title a [done · NOT approved]');
    expect(out).toContain('## b — Title b [failed]\nreason: boom');
    expect(out).toContain('## c — Title c [pending]\n(no output)');
    expect(out).not.toContain('\u0007');
    expect(out).not.toContain('\u001b');
  });
});

describe('renderRules, renderPacks, renderScope', () => {
  it('names rule files with their flags, never their content', () => {
    const rules: RulesSummary = {
      trust: 'untrusted',
      files: [
        { path: 'CLAUDE.md', kind: 'claude', scope: '.', applies: true, bytes: 9, truncated: true },
        {
          path: 'sub/AGENTS.md',
          kind: 'agents',
          scope: 'sub',
          applies: false,
          bytes: 9,
          truncated: false,
        },
      ] as RulesSummary['files'],
      truncated: true,
      omitted: ['big.md'],
      skippedForbidden: 2,
    };
    expect(renderRules(rules)).toBe(
      'rules  CLAUDE.md (claude, cut) · sub/AGENTS.md (agents, other folder) — untrusted context for every node · 1 left out (size cap) · 2 in forbidden zones skipped\n',
    );
    const none = { ...rules, files: [], omitted: [] };
    expect(renderRules(none)).toBe('rules  none read · 2 in forbidden zones skipped\n');
    expect(renderRules({ ...none, skippedForbidden: 0 })).toBe('');
  });

  it('shows pack flags, zones by origin, relaxations and pack problems', () => {
    const pack = { id: 'iot', name: 'IoT', reason: 'platformio.ini', preferLocal: true };
    const c = {
      packs: [
        { ...pack, personalData: true, physicalEffects: true },
        { ...pack, id: 'doc', preferLocal: false, personalData: false, physicalEffects: false },
      ],
      zones: [
        { glob: '**/*.key', tier: 'credential', origin: 'builtin' },
        { glob: '.env', tier: 'credential', origin: 'builtin' },
      ],
      lines: ['relaxed: build/**'],
      problems: ['bad.yaml: not a pack'],
    } as unknown as PackContext;
    const out = renderPacks(c);
    expect(out).toContain('packs  iot (platformio.ini) · doc (platformio.ini)');
    expect(out).toContain(
      'iot: prefers local models · personal data: keep local · physical effects: confirm and simulate first',
    );
    expect(out).not.toMatch(/doc: /);
    expect(out).toContain('zones  2 forbidden · builtin (credential): **/*.key .env');
    expect(out).toContain('       relaxed: build/**\n       pack problem: bad.yaml: not a pack\n');
  });

  it('prints a required scope, where it came from and why a run would be refused', () => {
    const none: ScopeCheck = { required: [], lines: [], problems: [] };
    expect(renderScope(none)).toBe('');
    const file: ScopeCheck = {
      required: ['infosec'],
      source: 'file',
      lines: ['targets: 10.0.0.0/24'],
      problems: ['expired'],
    };
    expect(renderScope(file)).toBe(
      'scope  required by infosec · from .kpstudio/scope.yaml (asked before running)\n       targets: 10.0.0.0/24\n       ✗ expired\n',
    );
    expect(renderScope({ ...file, source: 'request', problems: [] })).toMatch(/· from --scope\n/);
    expect(renderScope({ ...file, source: undefined })).toMatch(/^scope {2}required by infosec\n/);
  });
});
