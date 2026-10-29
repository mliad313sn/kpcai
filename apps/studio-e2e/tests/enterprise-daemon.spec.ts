/**
 * The Enterprise view against the real kernel server (no fake), with `kpai serve --headless`
 * running as a child process in the same $KPAI_HOME (ADR-0035: the console serves the
 * Enterprise methods, the daemon runs the programs, both share the store). A program is
 * drafted and approved through the CLI; the daemon runs it to its gate; the Sponsor opens
 * the evidence and approves in the browser; the daemon delivers. Offline: mock providers
 * declared `kind: cloud` with the in-process mock adapter, loopback only.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connected, expect, test } from '../fixtures/test.js';

const CLI = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
const GOAL = [
  'OAuth login in two parts:',
  '- add an OAuth state validator [[diff:src/state.ts]]',
  '- add a token parser [[diff:src/token.ts]]',
].join('\n');

interface State {
  status: string;
  escalations: Array<{ id: string; rule: string; answer?: string }>;
}

function cliEnv(home: string): NodeJS.ProcessEnv {
  const clean = Object.entries(process.env).filter(
    ([k]) => !/_API_(KEY|TOKEN)$|_BASE_URL$|^OLLAMA_|^KPAI_/.test(k),
  );
  return {
    ...Object.fromEntries(clean),
    KPAI_HOME: home,
    KPAI_LANG: 'en',
    OLLAMA_HOST: 'http://127.0.0.1:9',
    LLAMACPP_BASE_URL: 'http://127.0.0.1:9/v1',
    KPAI_CONFIRM_ABOVE_USD: '100',
  };
}

function daemon(home: string, repo: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [CLI, 'serve', '--headless'], {
    cwd: repo,
    env: cliEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr?.on('data', (c: Buffer) => (err += c.toString()));
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`no daemon URL:\n${err}`)), 30_000);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
      if (!/daemon on http:\/\/127\.0\.0\.1:\d+/.test(out)) return;
      clearTimeout(guard);
      resolve(child);
    });
    child.on('exit', (code) => reject(new Error(`kpai serve exited (${code}):\n${err}`)));
  });
}

async function until(read: () => State, ok: (s: State) => boolean, what: string): Promise<State> {
  const end = Date.now() + 45_000;
  for (;;) {
    const s = read();
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (status ${s.status})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('the Sponsor approves a gate in the view; the daemon in the same home delivers', async ({
  kernel,
  open,
  page,
}) => {
  test.setTimeout(120_000);
  expect(existsSync(CLI), `build the CLI first: ${CLI}`).toBe(true);
  const env = cliEnv(kernel.home);
  const kpai = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: kernel.repo, env, encoding: 'utf8' });
  mkdirSync(join(kernel.home, 'enterprise'), { recursive: true });
  const portfolio = join(kernel.home, 'enterprise', 'portfolio.json');
  writeFileSync(portfolio, JSON.stringify({ tickMs: 150, heartbeatSec: 5 }));
  const draft = kpai('program', 'new', GOAL, '--budget', '20');
  expect(draft.status, draft.stderr).toBe(0);
  const id = /program (prog-[0-9a-f]+)/.exec(draft.stdout)![1]!;
  const hash = /charter ([0-9a-f]{64})/.exec(draft.stdout)![1]!;
  expect(kpai('program', 'approve', id, hash).status).toBe(0);
  const read = (): State =>
    JSON.parse(readFileSync(join(kernel.home, 'programs', id, 'state.json'), 'utf8')) as State;
  const child = await daemon(kernel.home, kernel.repo);
  try {
    await until(read, (s) => s.escalations.some((e) => e.rule === 'gate.pass'), 'the gate');
    await open();
    await connected(page);
    await page.keyboard.press('Alt+e');
    await expect(page.locator('#ent-title')).toBeVisible();
    const program = page.getByRole('article', { name: id });
    await expect(program).toContainText('at the gate');
    // The ask card is the article named by its question (the program card names the program).
    const ask = page.getByRole('article', { name: /Pass the gate\?/ });
    const approve = ask.getByRole('button', { name: 'Approve' });
    await expect(approve).toHaveAttribute('aria-disabled', 'true');
    await ask.getByRole('button', { name: /Open the evidence/ }).click();
    await expect(approve).toHaveAttribute('aria-disabled', 'false');
    // A considered answer, not a rubber stamp (S10 R8: < 3 s after opening counts as one).
    await page.waitForTimeout(3_100);
    await approve.click();
    await expect(ask).toHaveCount(0);
    const done = await until(read, (s) => s.status === 'delivered', 'delivery by the daemon');
    expect(done.escalations.find((e) => e.rule === 'gate.pass')?.answer).toBe('yes');
    await page.reload();
    await connected(page);
    await page.keyboard.press('Alt+e');
    await expect(page.getByRole('article', { name: id })).toContainText('delivered');
    // The view's answer and the daemon's runs are in one journal: the north star reads both.
    const ns = kpai('stats', '--north-star');
    expect(ns.status, ns.stderr).toBe(0);
    expect(ns.stdout).toMatch(/rubber-stamped 0\/1 \(0%\)/);
  } finally {
    child.kill('SIGKILL');
  }
});
