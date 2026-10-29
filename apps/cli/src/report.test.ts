/** `kpai report …` and `kpai notify …` (ADR-0036) with offline mocks and a fake SMTP server. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnterpriseRuntime } from '@kernelpai/enterprise';
import { Kernel } from '@kernelpai/kernel';
import { fakeStarter } from '../../../packages/enterprise/src/test-helpers/fake.js';
import { fakeSmtp, type FakeSmtp } from '../../../packages/enterprise/src/test-helpers/smtp.js';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';
import { writeMockProviders } from './test-helpers/mock-providers.js';

const SECRET = `https://hooks.example.com/services/${'z'.repeat(24)}`;
let smtp: FakeSmtp | undefined;
afterEach(async () => {
  await smtp?.close();
  smtp = undefined;
});

function setup(): FakeIo {
  const repo = mkdtempSync(join(tmpdir(), 'kpai-report-'));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const io = fakeIo({ KPAI_CONFIRM_ABOVE_USD: '100', KPAI_HOOK: SECRET });
  io.cwd = repo;
  writeMockProviders(io.home, [{ id: 'mock-beta', price: [2, 10], code: 0.95, writing: 0.6 }]);
  return io;
}

/** A program that reached its gate (so its archive holds a gate report). */
async function gated(io: FakeIo): Promise<string> {
  await main(['program', 'new', 'one thing', '--budget', '5', '--no-critic', '--allow-test'], io);
  const id = /program (prog-[0-9a-f]+)/.exec(io.stdout)![1]!;
  await main(['program', 'approve', id, /charter ([0-9a-f]{64})/.exec(io.stdout)![1]!], io);
  const kernel = new Kernel({ env: io.env, cwd: io.cwd });
  const rt = new EnterpriseRuntime({ kernel, env: io.env });
  const fake = fakeStarter(rt);
  await rt.daemon.tick();
  fake.runs.forEach((r) => r.finish());
  await rt.idle();
  await rt.daemon.tick();
  await rt.idle();
  await rt.close();
  await kernel.close();
  return id;
}

const channels = (io: FakeIo, cfg: unknown): void => {
  mkdirSync(join(io.home, 'enterprise'), { recursive: true });
  writeFileSync(join(io.home, 'enterprise', 'channels.json'), JSON.stringify(cfg));
};

describe('kpai report', () => {
  it('lists the archive and shows a report, asks first', async () => {
    const io = setup();
    const id = await gated(io);
    expect(await main(['report', 'list', id], io)).toBe(0);
    const repId = /(rep-[0-9a-f]+) {2}gate/.exec(io.stdout)![1]!;
    // "verified" is a delivery's word only (ADR-0031): a gate report shows none.
    expect(io.stdout).toMatch(/gate +\S+ {2}not a delivery {2}markdown/);
    // P5-F7: `kpai program show` uses the same words: never "verified", nor silent.
    expect(await main(['program', 'show', id], io)).toBe(0);
    expect(io.stdout).toMatch(new RegExp(`report ${repId} gate \\S+ \\(not a delivery\\)`));
    expect(await main(['report', 'show', id], io)).toBe(0);
    expect(io.stdout).toMatch(
      /## What needs your answer[\s\S]*## What changed[\s\S]*## Forecast[\s\S]*## Top risk/,
    );
    expect(await main(['report', 'show', id, repId], io)).toBe(0);
    expect(await main(['report', 'show', id, 'rep-none'], io)).toBe(1);
    expect(io.stderr).toMatch(/no report rep-none/);
    expect(await main(['report', 'list'], io)).toBe(2);
    expect(await main(['report', 'show'], io)).toBe(2);
    expect(await main(['report', 'nope'], io)).toBe(2);
    expect(await main(['report', 'list', 'prog-none'], io)).toBe(1);
  });
});

describe('kpai notify', () => {
  it('lists channels with env var names only, and refuses third-party ones by default', async () => {
    const io = setup();
    smtp = await fakeSmtp();
    channels(io, {
      channels: [
        {
          id: 'mail',
          type: 'smtp',
          host: smtp.host,
          port: smtp.port,
          from: 'kp@localhost',
          to: ['me@localhost'],
        },
        { id: 'chat', type: 'slack', secretEnv: 'KPAI_HOOK', summary: true },
        { id: 'push', type: 'pushover', secretEnv: 'KPAI_PO_TOKEN', userEnv: 'KPAI_PO_USER' },
      ],
    });
    expect(await main(['notify', 'list'], io)).toBe(0);
    expect(io.stdout).toMatch(/third-party channels refused \(Q-11 default\)/);
    expect(io.stdout).toMatch(/markdown +markdown +local +on, counts only/);
    expect(io.stdout).toMatch(/mail +smtp +local +on/);
    expect(io.stdout).toMatch(
      /chat +slack +third-party refused: third-party channel not allowed \(Q-11\), summary {2}\[KPAI_HOOK set\]/,
    );
    expect(io.stdout).toMatch(/\[KPAI_PO_USER missing, KPAI_PO_TOKEN missing\]/);
    expect(io.stdout).not.toContain(SECRET);
    // A third-party channel is refused even when you confirm.
    io.confirmAnswers.push(true);
    expect(await main(['notify', 'test', 'chat'], io)).toBe(1);
    expect(io.stderr).toMatch(/chat: not sent \(refused, 0 attempt\(s\)\)/);
    expect(await main(['notify', 'test', 'nope', '--yes'], io)).toBe(1);
    expect(await main(['notify', 'test'], io)).toBe(2);
    expect(io.stdout + io.stderr).not.toContain(SECRET);
  });

  it('sends a test notice only after you confirm', async () => {
    const io = setup();
    smtp = await fakeSmtp();
    channels(io, {
      channels: [
        {
          id: 'mail',
          type: 'smtp',
          host: smtp.host,
          port: smtp.port,
          from: 'kp@localhost',
          to: ['me@localhost'],
        },
      ],
    });
    io.confirmAnswers.push(false);
    expect(await main(['notify', 'test', 'mail'], io)).toBe(1);
    expect(io.questions.at(-1)).toBe('Send a test notice (no project data) to mail (smtp)?');
    expect(smtp.messages).toHaveLength(0);
    io.confirmAnswers.push(true);
    expect(await main(['notify', 'test', 'mail'], io)).toBe(0);
    expect(await main(['notify', 'test', 'mail', '--yes'], io)).toBe(0);
    expect(smtp.messages).toHaveLength(2);
    expect(smtp.messages[0]!.text).toContain('No project data is included.');
    expect(io.stdout).toMatch(/mail: sent \(smtp-250\)/);
  });

  it('checks the dead-man file for cron and tells the channels once per silence', async () => {
    const io = setup();
    expect(await main(['notify', 'check'], io)).toBe(0);
    expect(io.stdout).toMatch(/never run here/);
    const at = new Date(Date.now() - 3_600_000).toISOString();
    writeFileSync(
      join(io.home, 'enterprise', 'heartbeat.json'),
      JSON.stringify({
        at,
        pid: 1,
        intervalSec: 60,
        staleAfterSec: 180,
        status: 'ok',
        alerts: [],
        programs: 0,
        running: 0,
      }),
    );
    expect(await main(['notify', 'check'], io)).toBe(1);
    expect(await main(['notify', 'check'], io)).toBe(1);
    const md = readFileSync(join(io.home, 'enterprise', 'notifications.md'), 'utf8');
    expect(md.match(/silent since/g)).toHaveLength(1);
    writeFileSync(
      join(io.home, 'enterprise', 'heartbeat.json'),
      JSON.stringify({
        at: new Date().toISOString(),
        pid: 1,
        intervalSec: 60,
        staleAfterSec: 180,
        status: 'ok',
        alerts: [],
        programs: 0,
        running: 0,
      }),
    );
    expect(await main(['notify', 'check'], io)).toBe(0);
    expect(io.stdout).toMatch(/daemon ok/);
  });
});
