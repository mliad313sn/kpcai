import { describe, expect, it } from 'vitest';
import { buildReport, digestDue, reportMarkdown, type JournalMetrics } from './report.js';
import {
  renderNotification,
  outboundLines,
  redactLine,
  safeLink,
  CHANNEL_LIMITS,
  type ChannelKind,
} from './notify.js';
import type { ProgramState } from './schemas.js';
import { NOW, run, running } from './test-helpers/fixtures.js';

const HEAD = 'a'.repeat(40);
const good: JournalMetrics = {
  headCommit: HEAD,
  ci: { commit: HEAD, status: 'success', evidence: [`ci:${HEAD}:success`] },
  tests: { passed: 120, failed: 0, evidence: ['event:9'] },
  risks: ['Printer firmware unknown'],
};

function delivered(): ProgramState {
  return { ...running(), status: 'delivered', runs: [run({ status: 'finished', costUsd: 1.25 })] };
}

describe('honest reports', () => {
  it('calls a delivery verified only with CI for the exact head commit and passing tests', () => {
    expect(buildReport(delivered(), good, { kind: 'final', now: NOW })).toMatchObject({
      verified: true,
    });
    const cases: JournalMetrics[] = [
      {},
      { ...good, ci: { ...good.ci!, commit: 'b'.repeat(40) } },
      { ...good, ci: { ...good.ci!, status: 'pending' } },
      { ...good, ci: { ...good.ci!, evidence: [] } },
      { ...good, tests: undefined },
      { ...good, tests: { passed: 1, failed: 2, evidence: ['event:1'] } },
    ];
    for (const m of cases) {
      const r = buildReport(delivered(), m, { kind: 'final', now: NOW });
      expect(r.verified).toBe(false);
      expect(r.headline).toMatch(/Not verified/);
    }
  });

  it('reports progress, budget by source, gates, decisions and what waits, in French too', () => {
    const s: ProgramState = {
      ...running({
        envelope: {
          totalCapUsd: 10,
          subscriptions: [{ provider: 'anthropic', agent: 'claude-code', runs: 5 }],
        },
      }),
      runs: [
        run({ status: 'finished', costUsd: 2 }),
        run({
          runId: 'r2',
          wpId: 'wp2',
          source: 'local',
          providers: ['ollama'],
          hours: 1.5,
          status: 'finished',
        }),
        run({
          runId: 'r3',
          source: 'subscription',
          providers: ['anthropic'],
          capUsd: 0,
          hours: 0.5,
        }),
      ],
      decisions: [
        {
          id: 'd1',
          at: NOW.toISOString(),
          actor: 'po',
          text: 'Use OpenSCAD',
          evidence: ['event:3'],
        },
      ],
      escalations: [
        { id: 'e1', at: NOW.toISOString(), rule: 'budget.phase', question: 'Raise phase 1 to $6?' },
      ],
      gates: [
        {
          phaseId: 'p0',
          verdict: 'pass',
          reviewer: 'rv',
          reviewerProvider: 'google',
          openCriticalOrHigh: 0,
          evidence: ['event:1'],
          at: NOW.toISOString(),
        },
        // P5-F6: nothing counted the findings: the Sponsor decided, and the report says so.
        {
          phaseId: 'p1',
          verdict: 'hold',
          reviewer: 'rv',
          reviewerProvider: 'mock-delta',
          evidence: ['event:2'],
          at: NOW.toISOString(),
        },
      ],
    };
    const r = buildReport(s, good, { kind: 'digest', now: NOW });
    const md = reportMarkdown(r);
    expect(md).toContain('2 of 2 work packages finished');
    expect(md).toContain('spent $2.00, committed $2.00 of $10.00 (20 %)');
    expect(md).toContain('by source: API $2.00, local compute 1.5 h');
    expect(md).toContain('subscription claude-code: 1 runs of 5, 0.5 h');
    expect(md).toContain('p0: pass (reviewer rv on google; 0 open Critical/High)');
    expect(md).toContain(
      'p1: hold (reviewer rv on mock-delta; the Sponsor decided, findings not counted by a machine)',
    );
    // P5-F7: every claim has its evidence, yet a report that is not a delivery is never
    // "verified".
    expect(r.verified).toBe(false);
    expect(md).toContain('po: "Use OpenSCAD"');
    expect(md).toContain('"Raise phase 1 to $6?"');
    expect(md).toContain(`CI green for ${HEAD.slice(0, 12)}`);
    expect(r.headline).toBe('Running. Phase 1/2: Design');
    const fr = reportMarkdown(
      buildReport({ ...s, amendment: s.charter }, {}, { kind: 'digest', now: NOW, locale: 'fr' }),
    );
    expect(fr).toContain('aucune preuve de test');
    expect(fr).toContain('relecteur rv sur mock-delta ; décision du Sponsor');
    expect(fr).toContain('relecteur rv sur google ; 0 Critique/Élevé ouverts');
    expect(fr).toContain('Charte en attente de votre approbation');
    const empty = reportMarkdown(
      buildReport(
        {
          ...running(),
          charter: {
            ...running().charter,
            envelope: { ...running().charter.envelope, totalCapUsd: 0 },
          },
        },
        { ci: { commit: 'x', status: 'failure', evidence: [] }, headCommit: 'x' },
        { kind: 'gate', now: NOW },
      ),
    );
    expect(empty).toContain('no gate closed yet');
    expect(empty).toContain('nothing waits for you');
    expect(empty).toContain('CI failure for x');
  });

  it('knows when a digest is due', () => {
    const s = running();
    expect(digestDue(s, NOW)).toBe(true);
    const later = { ...s, lastReportAt: NOW.toISOString() };
    expect(digestDue(later, new Date(NOW.getTime() + 3_600_000))).toBe(false);
    expect(digestDue(later, new Date(NOW.getTime() + 24 * 3_600_000))).toBe(true);
    expect(digestDue({ ...s, status: 'stopped' }, NOW)).toBe(false);
    expect(digestDue(running({ reports: { cadence: { every: 'gate' } } }), NOW)).toBe(false);
  });
});

describe('notifications', () => {
  const leaky = (): ProgramState => ({
    ...running(),
    decisions: [
      {
        id: 'd1',
        at: NOW.toISOString(),
        actor: 'po',
        text: `Set api_key=${['sk', 'ant', 'abcdefghijklmnop'].join('-')} in config`,
        evidence: [],
      },
      {
        id: 'd2',
        at: NOW.toISOString(),
        actor: 'po',
        text: 'const x = require("fs");',
        evidence: [],
      },
      { id: 'd3', at: NOW.toISOString(), actor: 'po', text: '```js\nrm -rf /\n```', evidence: [] },
      {
        id: 'd4',
        at: NOW.toISOString(),
        actor: 'po',
        text: `Token ${'ghp_'}abcdefghijklmnopqrstuvwxyz0123 leaked`,
        evidence: [],
      },
      { id: 'd5', at: NOW.toISOString(), actor: 'po', text: 'x'.repeat(500), evidence: [] },
    ],
  });

  it('redacts secrets and drops code and local-only lines', () => {
    expect(redactLine('use Bearer abcdefghijk now')).toBe('use [redacted] now');
    expect(redactLine('-----BEGIN PRIVATE KEY-----')).toBeUndefined();
    expect(redactLine('+ added line')).toBeUndefined();
    expect(
      redactLine(
        'AKIAABCDEFGHIJKLMNOP and xoxb-1234567890-abc and eyJabcdefghij.abcdefghij.abcdefghij',
      ),
    ).toBe('[redacted] and [redacted] and [redacted]');
    const r = buildReport(leaky(), good, { kind: 'digest', now: NOW });
    r.sections[0]!.lines.push({ text: 'Prefers metric units', evidence: [], localOnly: true });
    const { lines, redacted } = outboundLines(r);
    const all = lines.join('\n');
    expect(all).not.toMatch(/sk-ant|ghp_|require\(|rm -rf|metric units/);
    expect(all).toContain('[redacted]');
    expect(redacted).toBe(3);
    expect(lines.find((l) => l.includes('xxxx'))!.length).toBeLessThan(220);
  });

  it('renders every channel within its limit, with no credentials and only loopback links', () => {
    const r = buildReport(leaky(), good, { kind: 'digest', now: NOW });
    for (const ch of Object.keys(CHANNEL_LIMITS) as ChannelKind[]) {
      const n = renderNotification(r, ch, 'http://127.0.0.1:4242/programs/prog-1');
      const text = Object.values(n.payload).join('\n');
      expect(text).not.toMatch(/sk-ant|ghp_/);
      for (const v of Object.values(n.payload))
        expect(v.length).toBeLessThanOrEqual(CHANNEL_LIMITS[ch] + 300);
    }
    expect(renderNotification(r, 'ntfy', 'http://127.0.0.1:1/x').payload.click).toBe(
      'http://127.0.0.1:1/x',
    );
    expect(renderNotification(r, 'pushover', 'https://evil.example/x').payload.url).toBeUndefined();
    expect(renderNotification(r, 'email').payload.subject).toBe('prog-1: digest report');
    expect(safeLink('not a url')).toBeUndefined();
    expect(safeLink('file:///etc/passwd')).toBeUndefined();
    expect(safeLink('http://localhost:3000/')).toBe('http://localhost:3000/');
  });

  it('cuts long bodies at a line boundary', () => {
    const s = {
      ...running(),
      decisions: Array.from({ length: 60 }, (_, i) => ({
        id: `d${i}`,
        at: NOW.toISOString(),
        actor: 'po' as const,
        text: `Decision number ${i} `.repeat(8),
        evidence: [],
      })),
    };
    const r = buildReport(s, good, { kind: 'digest', now: NOW, decisions: 60 });
    const n = renderNotification(r, 'pushover');
    expect(n.payload.message!.length).toBeLessThanOrEqual(CHANNEL_LIMITS.pushover);
    expect(n.payload.message).toMatch(/…$/);
    expect(renderNotification(r, 'discord').payload.content!.length).toBeLessThanOrEqual(
      CHANNEL_LIMITS.discord,
    );
  });
});
