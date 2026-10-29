/**
 * `kpai stats --north-star` through the real kernel and the B-28 journal fields it reads:
 * J1 (`run intent` of a typed request), J2 (`confirmation answered` with its times) and J3
 * (file hashes before and after a kernel write). Offline mock providers in a temp git repo.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '@kernelpai/journal';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from './i18n/core.js';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';
import { writeMockProviders } from './test-helpers/mock-providers.js';

const REQ = 'add an OAuth state validator with tests [[diff:src/s.ts]] [[testdiff:test/s.test.ts]]';

afterEach(() => setLocale('en'));

function setup(env: Record<string, string> = {}): FakeIo {
  const repo = mkdtempSync(join(tmpdir(), 'kpai-ns-cli-'));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const io = fakeIo({ KPAI_CONFIRM_ABOVE_USD: '100', ...env });
  io.cwd = repo;
  writeMockProviders(io.home, [
    { id: 'mock-alpha', price: [3, 15], code: 0.6, writing: 0.6, analysis: 0.95 },
    { id: 'mock-beta', price: [2, 10], code: 0.95, writing: 0.6 },
    { id: 'mock-gamma', price: [1, 5], code: 0.6, writing: 0.6, test: 0.95 },
    { id: 'mock-delta', price: [2, 10], code: 0.6, writing: 0.6, critique: 0.95 },
  ]);
  return io;
}

async function kpai(io: FakeIo, ...args: string[]): Promise<number> {
  io.stdout = '';
  io.stderr = '';
  return main(args, io);
}

/** Every journaled payload of the workspace, read from the journal file itself. */
function payloads(io: FakeIo): Array<Record<string, unknown>> {
  const j = Journal.open(join(io.home, 'journal.db'));
  try {
    return j.events({ limit: 100_000 }).map((e) => e.payload);
  } finally {
    j.close();
  }
}

describe('kpai stats --north-star', () => {
  it('journals J1–J3 for a typed request and reads them back as the north star', async () => {
    const io = setup();
    io.confirmAnswers = [true, true];
    expect(await kpai(io, 'do', '--allow-test', '--yes', '--apply', REQ)).toBe(0);
    const p = payloads(io);
    // J1: the typed request is the run's human intent.
    const intent = p.find((x) => x['action'] === 'run intent');
    expect(intent).toMatchObject({ intent: { origin: 'human-request' }, unattended: false });
    expect((intent!['intent'] as { id: string }).id).toBe(intent!['runId']);
    // J2: both patch questions, with their times and the diff shown; never the text.
    const asks = p.filter((x) => x['action'] === 'confirmation answered');
    expect(asks).toHaveLength(2);
    for (const a of asks) {
      expect(a).toMatchObject({
        kind: 'patch',
        consequential: true,
        answer: 'yes',
        viewed: 'diff',
      });
      expect(Date.parse(String(a['answeredAt']))).toBeGreaterThanOrEqual(
        Date.parse(String(a['askedAt'])),
      );
      expect(JSON.stringify(a)).not.toMatch(/OAuth|diff --git/);
    }
    // J3: the created file had no pre-image; its post-image is the file's SHA-256.
    const write = p.find(
      (x) => x['tool'] === 'git.apply' && JSON.stringify(x['meta']).includes('src/s.ts'),
    );
    const sha = createHash('sha256')
      .update(readFileSync(join(io.cwd, 'src/s.ts')))
      .digest('hex');
    expect((write!['meta'] as { images: unknown }).images).toEqual({
      'src/s.ts': { pre: null, post: sha },
    });

    expect(await kpai(io, 'stats', '--north-star')).toBe(0);
    const out = io.stdout;
    expect(out.indexOf('estimate accuracy here')).toBeLessThan(out.indexOf('north star here'));
    expect(out).not.toMatch(/productivity here/);
    // Reviewed by another provider, but no test ran: V1, which is not enough for code.
    expect(out).toMatch(
      /0 DVO \(code, ≥ V2\) · 0 DVO-doc \(documents, ≥ V1\) · 0 still provisional · 1 intent\(s\)/,
    );
    expect(out).toMatch(/durability: rollback and revert/);
    // Two consequential yes answered within 3 s of being asked: both rubber-stamped.
    expect(out).toMatch(
      /G2 2 question\(s\), – per DVO · median answer time 0s · rubber-stamped 2\/2 \(100%\)/,
    );
    expect(out).toMatch(/G4 escapes 0\/2 \(0%\)/);
    expect(out).toMatch(/G5 safety invariants: 0 \(ok\)/);
    expect(out).toMatch(/G6 energy per DVO: not measured/);
    expect(out).toMatch(/breached: G2 rubber-stamp/);
    expect(out).toMatch(/not measured: G6 energy: no energyWh journaled \(J4\)/);
  });

  it('speaks French, combines with --productivity and refuses a bad date', async () => {
    const io = setup({ KPAI_LANG: 'fr' });
    expect(await kpai(io, 'stats', '--north-star', '--productivity')).toBe(0);
    expect(io.stdout).toMatch(/productivité ici/);
    expect(io.stdout).toMatch(/étoile polaire ici : résultats vérifiés et durables/);
    expect(io.stdout).toMatch(/G5 invariants de sûreté : 0 \(ok\)/);
    expect(io.stdout).toMatch(/aucun garde-fou dépassé/);
    expect(await kpai(io, 'stats', '--north-star', '--since', '2026-01-01T00:00:00Z')).toBe(0);
    expect(io.stdout).toMatch(/résultats depuis 2026-01-01T00:00:00.000Z/);
    expect(io.stdout).not.toMatch(/productivité ici/);
    expect(await kpai(io, 'stats', '--north-star', '--since', 'bientôt')).toBe(2);
    expect(io.stderr).toMatch(/kpai stats --north-star : since is not a date/);
  });
});
