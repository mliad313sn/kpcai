/** Offline fixtures for kernel and server tests: a git repo and mock providers. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfirmRequest } from '../confirm.js';
import type { KernelEvent } from '../routing-info.js';
import type { KernelHost, RunState } from '../types.js';

/** Code + tests request; the mock authors answer with these diffs. */
export const REQ =
  'add an OAuth state validator with tests [[diff:src/s.ts]] [[testdiff:test/s.test.ts]]';

const MOCKS = [
  { id: 'mock-alpha', price: [3, 15], code: 0.6, analysis: 0.95, test: 0.6, critique: 0.6 },
  { id: 'mock-beta', price: [2, 10], code: 0.95, analysis: 0.6, test: 0.6, critique: 0.6 },
  { id: 'mock-gamma', price: [1, 5], code: 0.6, analysis: 0.6, test: 0.95, critique: 0.6 },
  { id: 'mock-delta', price: [2, 10], code: 0.6, analysis: 0.6, test: 0.6, critique: 0.95 },
];

export function writeMocks(home: string): void {
  const dir = join(home, 'providers');
  mkdirSync(dir, { recursive: true });
  for (const s of MOCKS) {
    writeFileSync(
      join(dir, `${s.id}.yaml`),
      [
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
      ].join('\n'),
    );
  }
}

export function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'kpai-kernel-repo-'));
  const git = (...a: string[]): unknown => spawnSync('git', a, { cwd: repo });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return repo;
}

export interface RecordingHost extends KernelHost {
  home: string;
  said: string[];
  asked: ConfirmRequest[];
  events: Array<{ runId: string; event: KernelEvent }>;
  states: RunState[];
  /** Answers to confirmations, in order; then `fallback`. */
  answers: boolean[];
  fallback: boolean;
}

/** A host with mock providers in a fresh $KPAI_HOME and a git repo as workspace. */
export function recordingHost(env: Record<string, string> = {}): RecordingHost {
  const home = mkdtempSync(join(tmpdir(), 'kpai-kernel-home-'));
  writeMocks(home);
  const h: RecordingHost = {
    home,
    env: { KPAI_HOME: home, OLLAMA_HOST: 'http://127.0.0.1:9', ...env },
    cwd: gitRepo(),
    said: [],
    asked: [],
    events: [],
    states: [],
    answers: [],
    fallback: false,
    say: (t) => void h.said.push(t),
    confirm: (req) => {
      h.asked.push(req);
      return Promise.resolve(h.answers.shift() ?? h.fallback);
    },
    onEvent: (runId, event) => void h.events.push({ runId, event }),
    onRunState: (_runId, state) => void h.states.push(state),
  };
  return h;
}

export const TEST_OPTIONS = { allowTest: true } as const;
