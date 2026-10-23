/**
 * Enterprise view end to end (R-5E10, R-5E11) without a daemon: the built console is served
 * from apps/studio/dist through Playwright routes, and its WebSocket is answered in the page
 * by a fake kernel (`page.routeWebSocket`). Nothing listens on the port and no request
 * leaves the browser: every byte comes from these routes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import type { Page, WebSocketRoute } from '@playwright/test';
import { STUDIO_DIST } from './kernel.js';
import { activity, enterpriseSnapshot, type Snap, type SnapOptions } from './enterprise-data.js';

/** A loopback origin nothing listens on: the routes below answer for it. */
export const ORIGIN = 'http://127.0.0.1:47999';
const TOKEN = 'e2e-enterprise-token-0001';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export interface Call {
  method: string;
  params: unknown;
}

export interface FakeEnterprise {
  calls: Call[];
  /** Sends `enterprise.*` notifications with the next sequence numbers. */
  notify(name: string, params: Record<string, unknown>): void;
  notifyMany(items: Array<[string, Record<string, unknown>]>): void;
  snap: Snap;
}

async function serveDist(page: Page): Promise<void> {
  if (!existsSync(join(STUDIO_DIST, 'index.html')))
    throw new Error(`KP Studio is not built (${STUDIO_DIST}); run pnpm e2e, which builds it.`);
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = normalize(join(STUDIO_DIST, path === '/' ? 'index.html' : path));
    if (!file.startsWith(STUDIO_DIST + sep) || !existsSync(file))
      return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({
      status: 200,
      contentType: TYPES[extname(file)] ?? 'application/octet-stream',
      body: readFileSync(file),
    });
  });
}

const PROVIDERS = {
  providers: [
    {
      id: 'mock-alpha',
      name: 'mock-alpha',
      kind: 'cloud',
      available: true,
      models: [{ id: 'm1' }],
    },
  ],
};

const TOOLS = {
  tools: [
    { name: 'fs.read', risk: 'read', source: 'builtin', description: 'Read a file' },
    {
      name: 'mcp.gh.issue',
      risk: 'destructive',
      source: 'mcp:gh',
      description:
        '[blocked] MCP server gh is not approved in its current form; calls are refused.',
    },
  ],
  errors: [{ server: 'gh', message: 'MCP server "gh" is blocked: tool list changed' }],
};

function handlers(fake: FakeEnterprise): Record<string, (p: unknown) => unknown> {
  const ok = () => ({ ok: true });
  return {
    'kernel.hello': () => ({ protocol: 1, server: 'e2e-fake-enterprise' }),
    'providers.list': () => PROVIDERS,
    'sessions.list': () => ({ sessions: [] }),
    'memory.pending': () => ({ pending: [] }),
    'tools.list': () => TOOLS,
    'extensions.list': () => ({ skills: [], agents: [], hooks: [], problems: [] }),
    'tickets.list': () => ({ tickets: [], problems: [] }),
    'enterprise.snapshot': () => fake.snap,
    'enterprise.activity': () => ({ items: activity(), cursor: fake.snap.cursor }),
    'enterprise.kill': () => ({ cancelled: ['run-1'] }),
    'enterprise.unkill': () => ({ cancelled: [] }),
    'program.pause': ok,
    'program.resume': ok,
    'program.stop': ok,
    'program.viewed': ok,
    'program.answer': ok,
    'program.answerBatch': (p) => ({
      answered: (p as { escalationIds: string[] }).escalationIds,
      refused: [],
    }),
  };
}

function answer(ws: WebSocketRoute, fake: FakeEnterprise, text: string): void {
  const msg = JSON.parse(text) as { id?: number; method?: string; params?: unknown };
  if (!msg.method || msg.id === undefined) return;
  fake.calls.push({ method: msg.method, params: msg.params });
  const h = handlers(fake)[msg.method];
  const reply = h
    ? { result: h(msg.params) }
    : { error: { code: -32601, message: `unknown method ${msg.method}` } };
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }));
}

export interface OpenOptions extends SnapOptions {
  theme?: 'dark' | 'light';
  locale?: 'en' | 'fr';
}

/** Opens the console on the fake; the Enterprise view is one Alt+E away. */
export async function openFake(page: Page, o: OpenOptions = {}): Promise<FakeEnterprise> {
  let seq = 0;
  let socket: WebSocketRoute | undefined;
  const fake: FakeEnterprise = {
    calls: [],
    snap: enterpriseSnapshot(o),
    notify: (name, params) => fake.notifyMany([[name, params]]),
    notifyMany: (items) => {
      for (const [name, params] of items)
        socket?.send(
          JSON.stringify({ jsonrpc: '2.0', method: name, params: { ...params, seq: ++seq } }),
        );
    },
  };
  seq = fake.snap.cursor;
  await serveDist(page);
  await page.routeWebSocket(`ws://127.0.0.1:47999/rpc`, (ws) => {
    socket = ws;
    ws.onMessage((m) => answer(ws, fake, String(m)));
  });
  const prefs = { onboarded: true, locale: o.locale ?? 'en', theme: o.theme ?? 'dark' };
  await page.addInitScript((p) => {
    if (!sessionStorage.getItem('kp-e2e.seeded')) {
      localStorage.setItem('kp-studio.prefs', JSON.stringify(p));
      sessionStorage.setItem('kp-e2e.seeded', '1');
    }
  }, prefs);
  await page.goto(`${ORIGIN}/#token=${TOKEN}`);
  await page.locator('.conn-open').waitFor();
  return fake;
}

/** Shows the Enterprise view and waits for its gauges. */
export async function showEnterprise(page: Page): Promise<void> {
  await page.keyboard.press('Alt+e');
  await page.locator('#ent-title').waitFor();
  await page.locator('.gauges').waitFor();
}

/** Writes a screenshot when KP_E2E_SHOTS names a folder (evidence for the phase report). */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['KP_E2E_SHOTS'];
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
}
