import { describe, expect, it } from 'vitest';
import { buildExecutiveReport } from './exec-report.js';
import { renderAlertNotice, renderNotice, renderTestNotice } from './notice.js';
import { CHANNEL_LIMITS, type ChannelKind } from './notify.js';
import type { ProgramState } from './schemas.js';
import { NOW, run, running } from './test-helpers/fixtures.js';

const SECRET = ['sk', 'live', 'abcdefghijklmnopqrst'].join('-');
const CHANNELS = Object.keys(CHANNEL_LIMITS) as ChannelKind[];

/** A program full of project text: goal, questions, decisions, a key and code. */
function wordy(): ProgramState {
  return {
    ...running({ goal: 'Acme merger: confidential bracket for Project Falcon' }),
    runs: [run({ status: 'finished', costUsd: 2 })],
    escalations: [
      {
        id: 'e1',
        at: NOW.toISOString(),
        rule: 'confirm.write',
        question: `Ship Project Falcon now? key api_key=${SECRET}`,
      },
      {
        id: 'e2',
        at: NOW.toISOString(),
        rule: 'confirm.write',
        question: 'const x = require("fs");',
      },
    ],
  };
}

const text = (p: Record<string, string>): string => Object.values(p).join('\n');

describe('notices (S10 R4 c, Q-11)', () => {
  const r = buildExecutiveReport(wordy(), { events: [] }, { kind: 'digest', now: NOW });

  it('carry no project text by default: counts and a loopback link only', () => {
    for (const ch of CHANNELS) {
      const n = renderNotice(r, ch, { link: 'http://127.0.0.1:7420/' });
      const all = text(n.payload);
      expect(all).not.toMatch(/Falcon|Acme|bracket|Ship|require|sk-live|wp1|Design/);
      expect(all).toContain('2 decisions waiting, 20 % of budget used, 0 alerts, 0 changes.');
      expect(all).toContain('http://127.0.0.1:7420/');
      for (const v of Object.values(n.payload))
        expect(v.length).toBeLessThanOrEqual(CHANNEL_LIMITS[ch]);
    }
    expect(text(renderNotice(r, 'slack', { link: 'https://evil.example/' }).payload)).not.toContain(
      'evil',
    );
  });

  it('give a short redacted summary only when the channel opts in', () => {
    const n = renderNotice(r, 'email', { summary: true });
    const all = text(n.payload);
    expect(all).toContain('Ship Project Falcon now?');
    expect(all).not.toContain(SECRET);
    expect(all).toContain('[redacted]');
    expect(all).not.toMatch(/require\(/);
    expect(n.redacted).toBe(1);
    expect(all).not.toMatch(/Forecast|What changed/);
  });

  it('say whether a delivery is verified, without the evidence text', () => {
    const done = buildExecutiveReport(
      { ...running(), status: 'delivered' },
      { events: [] },
      { kind: 'final', now: NOW },
    );
    expect(text(renderNotice(done, 'ntfy').payload)).toContain('Delivered, not verified.');
    const fr = buildExecutiveReport(
      { ...running({ locale: 'fr' }), status: 'delivered' },
      { events: [] },
      { kind: 'final', now: NOW },
    );
    expect(text(renderNotice(fr, 'ntfy').payload)).toContain('Livré, non vérifié.');
  });

  it('alert with rule ids and times only, and test a channel with no project data', () => {
    const a = renderAlertNotice(
      { locale: 'en', rules: ['run.stalled', 'ask.old'], staleSince: '2026-10-23T09:00:00.000Z' },
      'telegram',
    );
    expect(a.payload.text).toContain('silent since 2026-10-23T09:00:00.000Z');
    expect(a.payload.text).toContain('2 alerts: run.stalled, ask.old.');
    const fr = renderAlertNotice({ locale: 'fr', rules: ['ask.old'] }, 'discord');
    expect(fr.payload.content).toContain('1 alerte : ask.old.');
    expect(renderTestNotice('en', 'email').payload.subject).toBe('KP Studio: test notification');
  });
});
