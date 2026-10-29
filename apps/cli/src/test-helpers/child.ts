/**
 * The built `kpai` binary as a real child process, in a throwaway $KPAI_HOME and git
 * repository with offline mock providers. No key or base URL from the developer's shell
 * reaches it; local-model probes go to a closed loopback port. Stdin is not a terminal, so
 * every confirmation the CLI would ask is a no (fail closed).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '@kernelpai/journal';
import { writeMockProviders } from './mock-providers.js';

export const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));

export interface ChildWorld {
  base: string;
  home: string;
  repo: string;
  env: NodeJS.ProcessEnv;
}

/** Throws when the CLI was not built: these tests exercise the shipped binary. */
export function requireBuild(): void {
  if (!existsSync(BIN)) throw new Error(`build the CLI first (pnpm build): ${BIN} is missing`);
}

export function childWorld(): ChildWorld {
  const base = mkdtempSync(join(tmpdir(), 'kpai-child-'));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(join(home, 'enterprise'), { recursive: true });
  mkdirSync(repo);
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  writeMockProviders(home, [
    { id: 'mock-alpha', price: [3, 15], code: 0.6, writing: 0.6, analysis: 0.95 },
    { id: 'mock-beta', price: [2, 10], code: 0.95, writing: 0.6 },
    { id: 'mock-gamma', price: [1, 5], code: 0.6, writing: 0.6, test: 0.95 },
    { id: 'mock-delta', price: [2, 10], code: 0.6, writing: 0.6, critique: 0.95 },
  ]);
  const clean = Object.entries(process.env).filter(
    ([k]) => !/_API_(KEY|TOKEN)$|_BASE_URL$|^OLLAMA_|^KPAI_/.test(k),
  );
  const env = {
    ...Object.fromEntries(clean),
    KPAI_HOME: home,
    KPAI_LANG: 'en',
    OLLAMA_HOST: 'http://127.0.0.1:9',
    LLAMACPP_BASE_URL: 'http://127.0.0.1:9/v1',
    KPAI_CONFIRM_ABOVE_USD: '100',
  };
  return { base, home, repo, env };
}

export function removeWorld(w: ChildWorld): void {
  rmSync(w.base, { recursive: true, force: true, maxRetries: 3 });
}

/** Runs `kpai …` to completion; stdin is closed (not a terminal). */
export function kpaiChild(w: ChildWorld, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: w.repo,
    env: w.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

/** Reads the journal the child processes left. */
export function readJournal<T>(w: ChildWorld, read: (j: Journal) => T): T {
  const j = Journal.open(join(w.home, 'journal.db'));
  try {
    return read(j);
  } finally {
    j.close();
  }
}
