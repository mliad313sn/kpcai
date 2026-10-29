/**
 * R-5E9 / Q-11 / S10 R4 c (ADR-0036): every channel against local fake servers. Notices are
 * content-free by default; a secret goes only to the place the service expects it and
 * never into a message, the journal, the activity feed, a file or the console; third-party
 * channels are refused until the Sponsor allows them; failures are retried and journaled.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExecutiveReport, CHANNEL_LIMITS, type ProgramState } from '@kernelpai/program';
import { fakeServer, type FakeServer } from '../../../providers/src/test-helpers/server.js';
import { NOW, run, running } from '../../../program/src/test-helpers/fixtures.js';
import { Feed } from '../feed.js';
import { newMeta } from '../meta.js';
import { EnterpriseStore } from '../store.js';
import { fakeSmtp, type FakeSmtp } from '../test-helpers/smtp.js';
import { CHANNELS_FILE } from './config.js';
import { Outbox, type OutItem } from './outbox.js';

const SECRET = `s3cr3t-${'q'.repeat(20)}`;
const HOOK_PATH = `/hook/${SECRET}`;
const PROJECT = /Falcon|Acme|bracket|Ship it|wp1|Design/;

interface Rig {
  home: string;
  store: EnterpriseStore;
  facts: Array<Record<string, unknown>>;
  outbox: Outbox;
  servers: FakeServer[];
  env: Record<string, string>;
  write(cfg: Record<string, unknown>): void;
}

let rig: Rig;
let smtp: FakeSmtp | undefined;
const logs: string[] = [];

function program(): ProgramState {
  return {
    ...running({ goal: 'Acme merger: confidential bracket for Project Falcon' }),
    runs: [run({ status: 'finished', costUsd: 2 })],
    escalations: [
      { id: 'e1', at: NOW.toISOString(), rule: 'confirm.write', question: 'Ship it to Falcon?' },
    ],
  };
}

function reportItem(): OutItem {
  const s = program();
  const report = buildExecutiveReport(s, { events: [] }, { kind: 'digest', now: NOW });
  return { kind: 'report', programId: 'prog-1', reportId: 'rep-1', report };
}

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'kpai-outbox-'));
  const store = new EnterpriseStore(home);
  const meta = newMeta(NOW);
  meta.reports.push({
    reportId: 'rep-1',
    kind: 'digest',
    title: 't',
    at: NOW.toISOString(),
    verified: true,
    channels: ['markdown'],
  });
  store.create('prog-1', { state: program(), meta });
  const facts: Rig['facts'] = [];
  const env: Record<string, string> = {
    KPAI_SECRET: SECRET,
    KPAI_USER: 'user-key-1',
    KPAI_SMTP_USER: 'me',
  };
  const outbox = new Outbox({
    store,
    feed: new Feed(store.path('activity.jsonl')),
    env,
    clock: () => NOW,
    fact: (programId, payload) => void facts.push({ programId, ...payload }),
    sleep: () => Promise.resolve(),
  });
  rig = {
    home,
    store,
    facts,
    outbox,
    servers: [],
    env,
    write: (cfg) => writeFileSync(store.path(CHANNELS_FILE), JSON.stringify(cfg)),
  };
  logs.length = 0;
  for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, k).mockImplementation(
      (...a: unknown[]) => void logs.push(a.map(String).join(' ')),
    );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(rig.servers.map((s) => s.close()));
  await smtp?.close();
  smtp = undefined;
});

async function server(status: (n: number) => number = () => 200): Promise<FakeServer> {
  let n = 0;
  const s = await fakeServer((_req, res) => {
    res.writeHead(status(++n), { 'content-type': 'application/json' });
    res.end('{"echo":"' + SECRET + '"}');
  });
  rig.servers.push(s);
  return s;
}

/** Every file under the home (journal-like files, feed, archive), as text. */
function everyFile(dir: string): string {
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .map((p) => (statSync(p).isDirectory() ? everyFile(p) : readFileSync(p, 'latin1')))
    .join('\n');
}

function noSecretAnywhere(): void {
  expect(JSON.stringify(rig.facts)).not.toContain(SECRET);
  expect(everyFile(rig.home)).not.toContain(SECRET);
  expect(logs.join('\n')).not.toContain(SECRET);
}

describe('Q-11 default: local channels only', () => {
  it('refuses every third-party channel until the Sponsor allows it', async () => {
    const hook = await server();
    rig.env['KPAI_HOOK'] = `${hook.url}${HOOK_PATH}`;
    const types = ['slack', 'teams', 'discord'].map((type) => ({
      id: type,
      type,
      secretEnv: 'KPAI_HOOK',
    }));
    rig.write({
      channels: [
        ...types,
        { id: 'push', type: 'ntfy', endpoint: hook.url, topic: 'kp' },
        {
          id: 'remote-mail',
          type: 'smtp',
          host: 'smtp.example.com',
          secure: true,
          from: 'a@b.c',
          to: ['d@e.f'],
        },
      ],
    });
    const out = await rig.outbox.deliver(reportItem());
    expect(hook.requests).toHaveLength(0);
    expect(out.filter((d) => d.status === 'refused').map((d) => d.channel)).toEqual([
      'slack',
      'teams',
      'discord',
      'push',
      'remote-mail',
    ]);
    expect(out.find((d) => d.channel === 'markdown')).toMatchObject({ ok: true });
    expect(rig.facts.filter((f) => f['action'] === 'notification refused')).toHaveLength(5);
    expect(readFileSync(rig.store.path('notifications.xml'), 'utf8')).toContain(
      '<rss version="2.0">',
    );
    expect(readFileSync(rig.store.path('notifications.md'), 'utf8')).toContain(
      '1 decision waiting',
    );
  });

  it('sends to SMTP on this machine without any opt-in, content-free, password only in AUTH', async () => {
    smtp = await fakeSmtp();
    rig.env['KPAI_SMTP_PASS'] = SECRET;
    rig.write({
      channels: [
        {
          id: 'mail',
          type: 'smtp',
          host: smtp.host,
          port: smtp.port,
          from: 'kp@localhost',
          to: ['me@localhost'],
          userEnv: 'KPAI_SMTP_USER',
          secretEnv: 'KPAI_SMTP_PASS',
        },
      ],
    });
    const out = await rig.outbox.deliver(reportItem());
    expect(out.find((d) => d.channel === 'mail')).toMatchObject({ ok: true, attempts: 1 });
    const m = smtp.messages[0]!;
    expect(m.to).toEqual(['me@localhost']);
    expect(m.headers).toContain('Subject: prog-1: digest report');
    expect(m.text).toContain('1 decision waiting, 20 % of budget used');
    expect(m.text).not.toMatch(PROJECT);
    expect(m.text + m.headers).not.toContain(SECRET);
    const auth = smtp.commands.find((c) => c.startsWith('AUTH PLAIN '))!;
    expect(Buffer.from(auth.slice(11), 'base64').toString()).toBe(`\0me\0${SECRET}`);
    noSecretAnywhere();
  });
});

describe('third-party channels, once allowed', () => {
  it('reach every service with a content-free notice in its limit; the secret only where the service wants it', async () => {
    const s = await server();
    const hook = `${s.url}${HOOK_PATH}`;
    rig.env['KPAI_HOOK'] = hook;
    rig.write({
      allowThirdParty: true,
      link: 'http://127.0.0.1:7420/',
      channels: [
        { id: 'slack', type: 'slack', secretEnv: 'KPAI_HOOK' },
        { id: 'teams', type: 'teams', secretEnv: 'KPAI_HOOK' },
        { id: 'discord', type: 'discord', secretEnv: 'KPAI_HOOK' },
        { id: 'ntfy', type: 'ntfy', endpoint: s.url, topic: 'kp', secretEnv: 'KPAI_SECRET' },
        {
          id: 'pushover',
          type: 'pushover',
          endpoint: `${s.url}/1/messages.json`,
          secretEnv: 'KPAI_SECRET',
          userEnv: 'KPAI_USER',
        },
        {
          id: 'telegram',
          type: 'telegram',
          endpoint: s.url,
          secretEnv: 'KPAI_SECRET',
          chatId: '42',
        },
      ],
    });
    const out = await rig.outbox.deliver(reportItem());
    expect(out.every((d) => d.ok)).toBe(true);
    expect(s.requests).toHaveLength(6);
    const [slack, teams, discord, ntfy, pushover, telegram] = s.requests as Array<{
      path: string;
      body: Record<string, string>;
      headers: Record<string, string>;
    }>;
    expect(slack!.path).toBe(HOOK_PATH);
    expect(ntfy!.headers['authorization']).toBe(`Bearer ${SECRET}`);
    expect(pushover!.body).toMatchObject({ token: SECRET, user: 'user-key-1' });
    expect(telegram!.path).toBe(`/bot${SECRET}/sendMessage`);
    expect(telegram!.body['chat_id']).toBe('42');
    const limits = [
      CHANNEL_LIMITS.slack,
      CHANNEL_LIMITS.teams,
      CHANNEL_LIMITS.discord,
      CHANNEL_LIMITS.ntfy,
      CHANNEL_LIMITS.pushover,
      CHANNEL_LIMITS.telegram,
    ];
    [slack, teams, discord, ntfy, pushover, telegram].forEach((r, i) => {
      const message = Object.fromEntries(
        // Only Pushover takes its credentials in the body, in its own fields.
        Object.entries(r!.body).filter(([k]) => i !== 4 || (k !== 'token' && k !== 'user')),
      );
      const text = Object.values(message).join('\n');
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(PROJECT);
      expect(text).toContain('http://127.0.0.1:7420/');
      for (const v of Object.values(message))
        expect(String(v).length).toBeLessThanOrEqual(limits[i]!);
    });
    const meta = rig.store.read('prog-1').meta;
    expect(meta.reports[0]!.channels).toEqual([
      'markdown',
      'slack',
      'teams',
      'discord',
      'ntfy',
      'pushover',
      'telegram',
    ]);
    noSecretAnywhere();
  });

  it('gives a redacted summary only to a channel that opted in', async () => {
    const s = await server();
    rig.env['KPAI_HOOK'] = `${s.url}${HOOK_PATH}`;
    rig.write({
      allowThirdParty: true,
      channels: [{ id: 'slack', type: 'slack', secretEnv: 'KPAI_HOOK', summary: true }],
    });
    await rig.outbox.deliver(reportItem());
    const text = (s.requests[0]!.body as { text: string }).text;
    expect(text).toContain('Ship it to Falcon?');
    expect(text).not.toContain('Acme merger');
  });
});

describe('failures', () => {
  it('retries 5xx and 429 with backoff, stops on 4xx, journals the status without the secret', async () => {
    const flaky = await server((n) => (n < 3 ? (n === 1 ? 503 : 429) : 200));
    const bad = await server(() => 403);
    rig.env['KPAI_HOOK'] = `${flaky.url}${HOOK_PATH}`;
    rig.env['KPAI_BAD'] = `${bad.url}${HOOK_PATH}`;
    const waits: number[] = [];
    const outbox = new Outbox({
      store: rig.store,
      feed: new Feed(rig.store.path('activity.jsonl')),
      env: rig.env,
      clock: () => NOW,
      fact: (programId, payload) => void rig.facts.push({ programId, ...payload }),
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    rig.write({
      allowThirdParty: true,
      retry: { attempts: 3, baseMs: 100 },
      channels: [
        { id: 'flaky', type: 'slack', secretEnv: 'KPAI_HOOK' },
        { id: 'bad', type: 'discord', secretEnv: 'KPAI_BAD' },
        { id: 'unset', type: 'teams', secretEnv: 'KPAI_NOT_SET' },
      ],
    });
    const out = await outbox.deliver(reportItem());
    expect(out.find((d) => d.channel === 'flaky')).toMatchObject({ ok: true, attempts: 3 });
    expect(waits).toEqual([100, 200]);
    expect(out.find((d) => d.channel === 'bad')).toMatchObject({
      ok: false,
      attempts: 1,
      status: '403',
    });
    expect(out.find((d) => d.channel === 'unset')).toMatchObject({
      ok: false,
      status: 'no-secret',
    });
    const failed = rig.facts.filter((f) => f['action'] === 'notification failed');
    expect(failed.map((f) => f['channel'])).toEqual(['bad', 'unset']);
    const feed = readFileSync(rig.store.path('activity.jsonl'), 'utf8');
    expect(feed).toContain('notification to bad failed: 403, 1 attempt(s)');
    noSecretAnywhere();
  });

  it('gives up on a dead endpoint and on SMTP refusals after the last attempt', async () => {
    const dead = await server();
    await dead.close();
    rig.servers = [];
    smtp = await fakeSmtp({ reject: { code: 451, times: 5 } });
    rig.env['KPAI_HOOK'] = `${dead.url}${HOOK_PATH}`;
    rig.write({
      allowThirdParty: true,
      retry: { attempts: 2, baseMs: 1 },
      channels: [
        { id: 'gone', type: 'slack', secretEnv: 'KPAI_HOOK' },
        {
          id: 'mail',
          type: 'smtp',
          host: smtp.host,
          port: smtp.port,
          from: 'a@localhost',
          to: ['b@localhost'],
        },
        { id: 'plain-remote', type: 'ntfy', endpoint: 'http://ntfy.invalid', topic: 'kp' },
        { id: 'off', type: 'slack', secretEnv: 'KPAI_HOOK', enabled: false },
      ],
    });
    await rig.outbox.flush();
    rig.outbox.push(reportItem());
    rig.outbox.push({ kind: 'alert', alert: { rules: ['run.stalled'] } });
    expect(rig.outbox.pending).toBe(2);
    await rig.outbox.flush();
    const failed = rig.facts.filter((f) => f['action'] === 'notification failed');
    expect(failed.map((f) => [f['channel'], f['status'], f['attempts']])).toEqual([
      ['gone', 'network', 2],
      ['mail', 'smtp-451', 2],
      ['plain-remote', 'endpoint-refused', 1],
      ['gone', 'network', 2],
      ['mail', 'smtp-451', 2],
      ['plain-remote', 'endpoint-refused', 1],
    ]);
    expect(rig.facts.some((f) => f['channel'] === 'off')).toBe(false);
    noSecretAnywhere();
  });

  it('tests one channel on demand, and reports an unreadable config as an error fact', async () => {
    smtp = await fakeSmtp();
    rig.write({
      channels: [
        {
          id: 'mail',
          type: 'smtp',
          host: smtp.host,
          port: smtp.port,
          from: 'a@localhost',
          to: ['b@localhost'],
        },
      ],
    });
    const out = await rig.outbox.deliver({ kind: 'test', channelId: 'mail' });
    expect(out).toEqual([{ channel: 'mail', ok: true, status: 'smtp-250', attempts: 1 }]);
    expect(smtp.messages[0]!.text).toContain('This channel works. No project data is included.');
    writeFileSync(rig.store.path(CHANNELS_FILE), '{"channels":[{"id":"x","type":"fax"}]}');
    rig.outbox.push({ kind: 'test', channelId: 'x' });
    await rig.outbox.flush();
    expect(rig.facts.at(-1)).toMatchObject({ action: 'notification error', kind: 'test' });
  });
});
