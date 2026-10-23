/**
 * Phase 4 end to end over the protocol only (WP5): a real kernel server on loopback with
 * offline mock providers, driven as a console client would drive it, without the browser
 * (S6 owns the screens). Each test gets a fresh $KPAI_HOME, a fresh git repository and a
 * short confirmation timeout, so "no human answer" is observable in a test.
 *
 * The mocks are `kind: cloud` with `adapter: mock` (as in kernel.ts): the router treats them
 * as cloud providers, and every call still goes to the in-process mock adapter. A
 * `kind: local` mock can be added for the local-only memory checks.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { startServer, type KernelServer } from '@kernelpai/server';

/** A two-node analysis plan (`look`, `propose`, both solo): small and cheap. */
export const ASK = 'what does the README say?';
/** Code and tests: architecture → implementation (author+critic) → tests → review. */
export const CODE =
  'add an OAuth state validator with tests [[diff:src/s.ts]] [[testdiff:test/s.test.ts]]';

const MOCKS = [
  { id: 'mock-alpha', price: [3, 15], code: 0.6, analysis: 0.95, test: 0.6, critique: 0.6 },
  { id: 'mock-beta', price: [2, 10], code: 0.95, analysis: 0.6, test: 0.6, critique: 0.6 },
  { id: 'mock-gamma', price: [1, 5], code: 0.6, analysis: 0.6, test: 0.95, critique: 0.6 },
  { id: 'mock-delta', price: [2, 10], code: 0.6, analysis: 0.6, test: 0.6, critique: 0.95 },
] as const;

function descriptor(id: string, kind: 'cloud' | 'local', price: readonly number[], c: string) {
  return [
    `id: ${id}`,
    `name: ${id}`,
    `kind: ${kind}`,
    'adapter: mock',
    ...(kind === 'local' ? ['baseUrl: http://127.0.0.1:9'] : []),
    `jurisdiction: ${kind === 'local' ? 'local' : 'US'}`,
    'retention: none',
    'models:',
    '  - id: m1',
    '    contextWindow: 32000',
    '    maxOutput: 4096',
    '    modalities: [text, code]',
    `    price: { inputPerMTok: ${price[0]}, outputPerMTok: ${price[1]} }`,
    `    competence: { ${c} }`,
    '',
  ].join('\n');
}

const competence = (m: (typeof MOCKS)[number]): string =>
  `code_generation: ${m.code}, test: ${m.test}, writing: 0.6, critique: ${m.critique}, analysis: ${m.analysis}, research: 0.5, decision: 0.6`;

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'kp-e2e4-repo-'));
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

export interface Phase4Kernel {
  server: KernelServer;
  home: string;
  repo: string;
  /** Adds a `kind: local` mock provider (read at the next plan). */
  addLocalMock(): void;
  stop(): Promise<void>;
}

/** Confirmations left unanswered fail closed after this long (the console default is 60 s). */
export const CONFIRM_TIMEOUT_MS = 1_500;

export async function startPhase4Kernel(): Promise<Phase4Kernel> {
  const home = mkdtempSync(join(tmpdir(), 'kp-e2e4-home-'));
  const providers = join(home, 'providers');
  mkdirSync(providers, { recursive: true });
  for (const m of MOCKS)
    writeFileSync(
      join(providers, `${m.id}.yaml`),
      descriptor(m.id, 'cloud', m.price, competence(m)),
    );
  const repo = gitRepo();
  const server = await startServer({
    kernel: {
      env: {
        KPAI_HOME: home,
        OLLAMA_HOST: 'http://127.0.0.1:9',
        LLAMACPP_BASE_URL: 'http://127.0.0.1:9/v1',
        KPAI_CONFIRM_ABOVE_USD: '100',
      },
      cwd: repo,
    },
    confirmTimeoutMs: CONFIRM_TIMEOUT_MS,
    serverFile: false,
  });
  return {
    server,
    home,
    repo,
    addLocalMock: () => {
      const c = MOCKS.map((m) => competence(m))[0] as string;
      writeFileSync(
        join(providers, 'mock-local.yaml'),
        descriptor('mock-local', 'local', [0, 0], c),
      );
    },
    stop: async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

export interface Note {
  method: string;
  params: Record<string, unknown>;
}

/** What a human answers to a `confirm.request`; `undefined` stays silent. */
export type Answer = boolean | { ok: boolean; choice?: string } | undefined;

export interface Client {
  call<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T>;
  /** The first notification, past or future, that matches. */
  waitFor(pred: (n: Note) => boolean, timeoutMs?: number): Promise<Note>;
  notes: Note[];
  confirms: Array<Record<string, unknown>>;
  /** The human at this console; the default stays silent. */
  answer: (req: Record<string, unknown>) => Answer;
  close(): void;
}

type Reply = { result?: unknown; error?: { message: string; code: number } };

/** A JSON-RPC client over Node's WebSocket that also sees notifications and confirmations. */
export function connect(port: number, token: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, [
    'kernelpai.v1',
    `kernelpai.bearer.${token}`,
  ]);
  const waiting = new Map<number, (m: Reply) => void>();
  const watchers = new Set<(n: Note) => void>();
  let next = 1;
  const c: Client = {
    notes: [],
    confirms: [],
    answer: () => undefined,
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, (m) => {
          waiting.delete(id);
          if (m.error) reject(Object.assign(new Error(`${method}: ${m.error.message}`), m.error));
          else resolve(m.result as never);
        });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
      }),
    waitFor: (pred, timeoutMs = 45_000) => {
      const hit = c.notes.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          watchers.delete(w);
          reject(new Error(`no matching notification within ${timeoutMs} ms`));
        }, timeoutMs);
        const w = (n: Note): void => {
          if (!pred(n)) return;
          clearTimeout(timer);
          watchers.delete(w);
          resolve(n);
        };
        watchers.add(w);
      });
    },
    close: () => ws.close(),
  };
  ws.addEventListener('message', (ev) => onMessage(c, waiting, watchers, String(ev.data)));
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(c), { once: true });
    ws.addEventListener('close', (e) => reject(new Error(`close ${e.code}`)), { once: true });
  });
}

function onMessage(
  c: Client,
  waiting: Map<number, (m: Reply) => void>,
  watchers: Set<(n: Note) => void>,
  data: string,
): void {
  const m = JSON.parse(data) as Reply & { id?: number; method?: string; params?: Note['params'] };
  if (typeof m.id === 'number' && !m.method) return void waiting.get(m.id)?.(m);
  if (!m.method) return;
  const note: Note = { method: m.method, params: m.params ?? {} };
  c.notes.push(note);
  if (note.method === 'confirm.request') {
    c.confirms.push(note.params);
    const a = c.answer(note.params);
    if (a !== undefined) {
      const body = typeof a === 'boolean' ? { ok: a } : a;
      void c.call('confirm.answer', { confirmId: note.params.confirmId, ...body });
    }
  }
  for (const w of [...watchers]) w(note);
}

export interface JournalEvent {
  seq: number;
  type: string;
  nodeId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  payload: Record<string, unknown>;
}

export interface Done {
  runId: string;
  result: {
    ok: boolean;
    costUsd: number;
    states: Record<string, string>;
    results: Record<string, { output: string; ok: boolean; costUsd: number; error?: string }>;
    deliverables?: Record<string, unknown>;
    disputes?: Record<string, { choice: string | null; by: string }>;
  };
  patches: unknown[];
  verification?: Record<string, unknown>;
}

/** Plans `request` (in place), runs exactly that plan and waits for `run.done`. */
export async function planAndRun(
  c: Client,
  request: string,
  o: { graph?: { nodes: unknown[] }; options?: Record<string, unknown> } = {},
) {
  const options = { isolated: false, ...o.options };
  const plan = await c.call<Plan>('plan', { request, options });
  const graph = o.graph ? { graph: o.graph } : {};
  const { runId } = await c.call<{ runId: string }>('run.start', {
    request,
    planId: plan.planId,
    options,
    ...graph,
  });
  const done = await c.waitFor((n) => n.method === 'run.done' && n.params.runId === runId);
  return { plan, runId, done: done.params as unknown as Done };
}

export interface Plan {
  planId: string;
  graph: { nodes: Array<Record<string, unknown> & { id: string }> };
  estimate: {
    expectedUsd: number;
    capUsd: number;
    band: { lowUsd: number; highUsd: number; basis: string };
    nodes: Array<{ nodeId: string; ref: { provider: string } | null; reason?: string }>;
    accuracy?: string;
  };
  memory?: {
    included: Array<{ id: string; source: string; trust: string; localOnly: boolean }>;
    localOnly: number;
  };
}

/** Every journal event of the workspace's sessions, oldest first. */
export async function journal(c: Client): Promise<JournalEvent[]> {
  const { sessions } = await c.call<{ sessions: Array<{ id: string }> }>('sessions.list', {
    limit: 1000,
  });
  const all: JournalEvent[] = [];
  for (const s of sessions) {
    const r = await c.call<{ events: JournalEvent[] }>('sessions.events', {
      sessionId: s.id,
      limit: 100_000,
    });
    all.push(...r.events);
  }
  return all.sort((a, b) => a.seq - b.seq);
}

export const test = base.extend<{ k: Phase4Kernel; c: Client }>({
  k: async ({}, use) => {
    const k = await startPhase4Kernel();
    await use(k);
    await k.stop();
  },
  c: async ({ k }, use) => {
    const c = await connect(k.server.port, k.server.token);
    await use(c);
    c.close();
  },
});

export { expect };
