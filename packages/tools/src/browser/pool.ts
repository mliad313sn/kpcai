/**
 * The driven browser's process and pages (spec phase 5, ADR-0032): one headless Chromium
 * from Playwright, launched on first use from the preinstalled binary (never downloaded);
 * one isolated context and page per session + node. Every request of a page goes through
 * the URL policy: anything else is aborted and reported.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '@kernelpai/core';
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import type { Env } from '../env.js';
import { stripControls } from '../text.js';
import { ToolError } from '../types.js';
import type { ZoneSet } from '../zones.js';
import { fileProblem, isLoopbackHost } from './url-policy.js';

export const BROWSER_ACTION_TIMEOUT_MS = 15_000;

/**
 * The Chromium binary: `KPAI_CHROMIUM`, else `$PLAYWRIGHT_BROWSERS_PATH/chromium` when it
 * exists, else Playwright's own lookup (which never installs anything by itself).
 */
export function chromiumExecutable(env: Env): string | undefined {
  const explicit = env['KPAI_CHROMIUM']?.trim();
  if (explicit) return explicit;
  const base = env['PLAYWRIGHT_BROWSERS_PATH']?.trim();
  if (base && existsSync(path.join(base, 'chromium'))) return path.join(base, 'chromium');
  return undefined;
}

export interface Tab {
  root: string;
  context: BrowserContext;
  page: Page;
  /** Non-local origins a person confirmed for this tab (allow-listed ones only). */
  confirmed: Set<string>;
  /** Requests refused since the last report. */
  blocked: Set<string>;
  shots: number;
}

export interface BrowserPoolOptions {
  env?: Env;
  zones?: ZoneSet;
  timeoutMs?: number;
  /** Extra Chromium switches (tests map a test host to loopback with `--host-resolver-rules`). */
  launchArgs?: readonly string[];
}

const tabKey = (ctx: ToolContext): string => `${ctx.sessionId}\u0000${ctx.nodeId}`;

/** True when a page may load `raw` (http(s) loopback, confirmed origin, workspace file, inline). */
export function requestAllowed(
  tab: Pick<Tab, 'root' | 'confirmed'>,
  raw: string,
  zones?: ZoneSet,
): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || raw === 'about:blank') return true;
  if (u.protocol === 'file:') return fileProblem(u, tab.root, zones) === undefined;
  if (
    u.protocol !== 'http:' &&
    u.protocol !== 'https:' &&
    u.protocol !== 'ws:' &&
    u.protocol !== 'wss:'
  ) {
    return false;
  }
  const origin = `${u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol}//${u.host}`;
  return isLoopbackHost(u.hostname) || tab.confirmed.has(origin);
}

function shortOrigin(raw: string): string {
  try {
    const u = new URL(raw);
    return stripControls(u.protocol === 'file:' ? `file:${u.pathname}` : u.origin).slice(0, 200);
  } catch {
    return 'invalid URL';
  }
}

export class BrowserPool {
  private browser: Promise<Browser> | undefined;
  private readonly tabs = new Map<string, Promise<Tab>>();
  readonly timeoutMs: number;

  constructor(private readonly o: BrowserPoolOptions = {}) {
    this.timeoutMs = o.timeoutMs ?? BROWSER_ACTION_TIMEOUT_MS;
  }

  /** The tab of this session + node; created (at `root`) when `create` is set. */
  async tab(ctx: ToolContext, create = false): Promise<Tab> {
    const key = tabKey(ctx);
    let t = this.tabs.get(key);
    if (!t) {
      if (!create)
        throw new ToolError('browser: no page is open for this node; call browser.open first');
      t = this.newTab(ctx.root);
      this.tabs.set(key, t);
      t.catch(() => this.tabs.delete(key));
    }
    return t;
  }

  /** Requests refused since the last call, as a sentence (empty when none). */
  takeBlocked(tab: Tab): string {
    if (tab.blocked.size === 0) return '';
    const list = [...tab.blocked].slice(0, 10).join(', ');
    tab.blocked.clear();
    return `blocked requests (not local, not confirmed): ${list}`;
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    this.tabs.clear();
    if (b) await (await b.catch(() => undefined))?.close().catch(() => undefined);
  }

  private launch(): Promise<Browser> {
    this.browser ??= (async () => {
      const { chromium } = await import('playwright-core');
      const executablePath = chromiumExecutable(this.o.env ?? process.env);
      try {
        return await chromium.launch({
          headless: true,
          timeout: 30_000,
          args: [...(this.o.launchArgs ?? [])],
          ...(executablePath ? { executablePath } : {}),
        });
      } catch (err) {
        this.browser = undefined;
        const why = stripControls((err as Error).message.split('\n')[0] ?? '').slice(0, 300);
        throw new ToolError(
          `browser: Chromium could not start (${why}); point KPAI_CHROMIUM at a Chromium binary`,
        );
      }
    })();
    return this.browser;
  }

  private async newTab(root: string): Promise<Tab> {
    const browser = await this.launch();
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(this.timeoutMs);
    const tab: Tab = { root, context, page, confirmed: new Set(), blocked: new Set(), shots: 0 };
    await context.route('**/*', (route) => this.gate(tab, route));
    await context.routeWebSocket(/.*/, (ws) => {
      if (requestAllowed(tab, ws.url(), this.o.zones)) ws.connectToServer();
      else {
        tab.blocked.add(shortOrigin(ws.url()));
        void ws.close();
      }
    });
    return tab;
  }

  private gate(tab: Tab, route: Route): Promise<void> {
    const url = route.request().url();
    if (requestAllowed(tab, url, this.o.zones)) return route.continue();
    tab.blocked.add(shortOrigin(url));
    return route.abort('blockedbyclient');
  }
}
