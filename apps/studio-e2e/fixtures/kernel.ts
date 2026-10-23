/**
 * A real KernelPAI console server (packages/server `startServer`) serving the built KP Studio
 * (apps/studio/dist), with offline mock providers in a fresh $KPAI_HOME and a throwaway git
 * repository as the workspace. Loopback only: the mock adapter never calls the network and
 * the kernel gets a clean environment (no API key from the developer's shell can leak in).
 *
 * The browser console has no "allow test providers" switch (the CLI's `--allow-test`), so
 * the mocks are declared `kind: cloud` with `adapter: mock`: the router treats them as real
 * cloud providers, and every call still goes to the in-process mock adapter.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type KernelServer } from '@kernelpai/server';

export const STUDIO_DIST = fileURLToPath(new URL('../../studio/dist', import.meta.url));

/** Code + tests request: the mock authors answer with these two diffs. */
export const CODE_REQUEST =
  'add an OAuth state validator with tests [[diff:src/s.ts]] [[testdiff:test/s.test.ts]]';

/** A document request: the "Sourced document" pack plan, with an unreviewed solo report. */
export const REPORT_REQUEST = [
  'write a short report about the release',
  '```artifact path="docs/report.md" kind="report" mime="text/markdown"',
  '# Findings',
  'all good',
  '```',
].join('\n');

/** Each mock is best at one task type, so the router hands each role to another provider. */
const MOCKS = [
  { id: 'mock-alpha', price: [3, 15], code: 0.6, analysis: 0.95, test: 0.6, critique: 0.6 },
  { id: 'mock-beta', price: [2, 10], code: 0.95, analysis: 0.6, test: 0.6, critique: 0.6 },
  { id: 'mock-gamma', price: [1, 5], code: 0.6, analysis: 0.6, test: 0.95, critique: 0.6 },
  { id: 'mock-delta', price: [2, 10], code: 0.6, analysis: 0.6, test: 0.6, critique: 0.95 },
];

function descriptor(s: (typeof MOCKS)[number]): string {
  const competence = [
    `code_generation: ${s.code}`,
    `test: ${s.test}`,
    'writing: 0.6',
    `critique: ${s.critique}`,
    `analysis: ${s.analysis}`,
    'research: 0.5',
    'decision: 0.6',
  ].join(', ');
  return [
    `id: ${s.id}`,
    `name: ${s.id}`,
    'kind: cloud',
    'adapter: mock',
    'jurisdiction: US',
    'retention: none',
    'models:',
    '  - id: m1',
    '    contextWindow: 32000',
    '    maxOutput: 4096',
    '    modalities: [text, code]',
    `    price: { inputPerMTok: ${s.price[0]}, outputPerMTok: ${s.price[1]} }`,
    `    competence: { ${competence} }`,
    '',
  ].join('\n');
}

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'kp-e2e-repo-'));
  const git = (...a: string[]): void => {
    const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  git('config', 'user.email', 'e2e@kernelpai.local');
  git('config', 'user.name', 'e2e');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# e2e\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return repo;
}

export interface E2eKernel {
  server: KernelServer;
  home: string;
  repo: string;
  /** The console URL with the token in the fragment. */
  url: string;
  stop(): Promise<void>;
}

export async function startKernel(env: Record<string, string> = {}): Promise<E2eKernel> {
  if (!existsSync(join(STUDIO_DIST, 'index.html')))
    throw new Error(`KP Studio is not built (${STUDIO_DIST}); run pnpm e2e, which builds it.`);
  const home = mkdtempSync(join(tmpdir(), 'kp-e2e-home-'));
  mkdirSync(join(home, 'providers'), { recursive: true });
  for (const m of MOCKS) writeFileSync(join(home, 'providers', `${m.id}.yaml`), descriptor(m));
  const repo = gitRepo();
  const server = await startServer({
    kernel: {
      env: {
        KPAI_HOME: home,
        // Unreachable loopback port: the local-model probes fail fast and offline, even on a
        // machine that runs Ollama or llama.cpp.
        OLLAMA_HOST: 'http://127.0.0.1:9',
        LLAMACPP_BASE_URL: 'http://127.0.0.1:9/v1',
        KPAI_CONFIRM_ABOVE_USD: '100',
        ...env,
      },
      cwd: repo,
    },
    staticDir: STUDIO_DIST,
    confirmTimeoutMs: 60_000,
    serverFile: false,
  });
  return {
    server,
    home,
    repo,
    url: server.studioUrl,
    stop: async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}
