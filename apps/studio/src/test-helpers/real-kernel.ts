/**
 * The real KernelPAI server (packages/server `startServer`) with offline mock providers in
 * a fresh $KPAI_HOME and a throwaway git repository as workspace. Loopback only; the mock
 * adapter never calls the network. Mirrors packages/kernel's test fixture (not exported).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type KernelServer } from '@kernelpai/server';

/** Code + tests request; the mock authors answer with these diffs. */
export const REAL_REQUEST =
  'add an OAuth state validator with tests [[diff:src/s.ts]] [[testdiff:test/s.test.ts]]';

const MOCKS = [
  { id: 'mock-alpha', price: [3, 15], code: 0.6, analysis: 0.95, test: 0.6, critique: 0.6 },
  { id: 'mock-beta', price: [2, 10], code: 0.95, analysis: 0.6, test: 0.6, critique: 0.6 },
  { id: 'mock-gamma', price: [1, 5], code: 0.6, analysis: 0.6, test: 0.95, critique: 0.6 },
  { id: 'mock-delta', price: [2, 10], code: 0.6, analysis: 0.6, test: 0.6, critique: 0.95 },
];

function writeMocks(home: string): void {
  const dir = join(home, 'providers');
  mkdirSync(dir, { recursive: true });
  for (const s of MOCKS) {
    const yaml = [
      `id: ${s.id}`,
      `name: ${s.id}`,
      'kind: test',
      'adapter: mock',
      'jurisdiction: US',
      'retention: none',
      'models:',
      '  - id: m1',
      '    contextWindow: 32000',
      '    maxOutput: 4096',
      '    modalities: [text, code]',
      `    price: { inputPerMTok: ${s.price[0]}, outputPerMTok: ${s.price[1]} }`,
      `    competence: { code_generation: ${s.code}, test: ${s.test}, writing: 0.6, critique: ${s.critique}, analysis: ${s.analysis}, research: 0.5, decision: 0.6 }`,
      '',
    ];
    writeFileSync(join(dir, `${s.id}.yaml`), yaml.join('\n'));
  }
}

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'kp-studio-repo-'));
  const git = (...a: string[]): unknown => spawnSync('git', a, { cwd: repo });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return repo;
}

export interface RealKernel {
  server: KernelServer;
  wsUrl: string;
  cwd: string;
  stop(): Promise<void>;
}

export async function startRealKernel(env: Record<string, string> = {}): Promise<RealKernel> {
  const home = mkdtempSync(join(tmpdir(), 'kp-studio-home-'));
  writeMocks(home);
  const cwd = gitRepo();
  const server = await startServer({
    kernel: { env: { KPAI_HOME: home, OLLAMA_HOST: 'http://127.0.0.1:9', ...env }, cwd },
    confirmTimeoutMs: 5000,
    serverFile: false,
  });
  return {
    server,
    cwd,
    wsUrl: `ws://127.0.0.1:${server.port}/rpc`,
    stop: async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
