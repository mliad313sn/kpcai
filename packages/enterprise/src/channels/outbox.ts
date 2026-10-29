/**
 * The outbox (R-5E9, ADR-0036): reports and alerts are queued under the store lock and sent
 * after it, in the background, so a channel never blocks a program. Each channel gets the
 * notice it may carry (content-free unless it opted in to a summary), within its limit;
 * failures worth it are retried with exponential backoff. Every outcome is journaled as a
 * typed fact (channel id, type, attempts, status), never with a secret, an endpoint or text
 * the service returned. A report's archive entry lists the channels that took it.
 */
import {
  renderAlertNotice,
  renderNotice,
  renderTestNotice,
  type AlertInput,
  type ChannelKind,
  type ExecReport,
  type Notification,
} from '@kernelpai/program';
import type { Feed } from '../feed.js';
import type { EnterpriseStore } from '../store.js';
import {
  CHANNELS_FILE,
  loadChannels,
  refusal,
  type ChannelSpec,
  type ChannelsFile,
} from './config.js';
import { buildRequest, postJson, type Env, type Outcome } from './http.js';
import { writeLocal } from './local-file.js';
import { sendMail } from './smtp.js';

export type OutItem =
  | { kind: 'report'; programId: string; reportId: string; report: ExecReport }
  | { kind: 'alert'; alert: Omit<AlertInput, 'locale'> }
  | { kind: 'test'; channelId: string };

export interface OutboxDeps {
  store: EnterpriseStore;
  feed: Feed;
  env: Env;
  clock: () => Date;
  fact(programId: string | undefined, payload: Record<string, unknown>): void;
  /** Waits between attempts (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export interface Delivery {
  channel: string;
  ok: boolean;
  status: string;
  attempts: number;
}

const KIND: Record<ChannelSpec['type'], ChannelKind> = {
  markdown: 'markdown',
  smtp: 'email',
  slack: 'slack',
  teams: 'teams',
  discord: 'discord',
  ntfy: 'ntfy',
  pushover: 'pushover',
  telegram: 'telegram',
};

export class Outbox {
  private queue: OutItem[] = [];
  private running: Promise<void> | undefined;

  constructor(private readonly d: OutboxDeps) {}

  push(item: OutItem): void {
    this.queue.push(item);
  }

  get pending(): number {
    return this.queue.length;
  }

  config(): ChannelsFile {
    return loadChannels(this.d.store.path(CHANNELS_FILE));
  }

  /** Sends everything queued; one flush at a time. Never throws. */
  flush(): Promise<void> {
    this.running ??= this.drain().finally(() => (this.running = undefined));
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const item = this.queue.shift()!;
      try {
        await this.deliver(item);
      } catch (err) {
        this.d.fact(undefined, {
          action: 'notification error',
          kind: item.kind,
          error: (err as Error).name,
        });
      }
    }
  }

  /** Sends one item to every channel that may carry it; returns what happened. */
  async deliver(item: OutItem): Promise<Delivery[]> {
    const f = this.config();
    const targets =
      item.kind === 'test' ? f.channels.filter((c) => c.id === item.channelId) : f.channels;
    const out: Delivery[] = [];
    for (const c of targets) {
      const programId = item.kind === 'report' ? item.programId : undefined;
      const why = refusal(c, f);
      if (why) {
        if (why !== 'disabled' || item.kind === 'test')
          this.record(programId, c, { ok: false, status: 'refused', attempts: 0 }, why);
        out.push({ channel: c.id, ok: false, status: 'refused', attempts: 0 });
        continue;
      }
      const r = await this.attempt(c, f, this.render(item, c, f));
      this.record(programId, c, r);
      out.push({ channel: c.id, ...r });
    }
    if (item.kind === 'report') await this.archive(item, out);
    return out;
  }

  private render(item: OutItem, c: ChannelSpec, f: ChannelsFile): Notification {
    const kind = KIND[c.type];
    if (item.kind === 'report')
      return renderNotice(item.report, kind, {
        summary: c.summary,
        ...(f.link ? { link: f.link } : {}),
      });
    if (item.kind === 'alert')
      return renderAlertNotice({ ...item.alert, locale: f.locale }, kind, f.link);
    return renderTestNotice(f.locale, kind, f.link);
  }

  private async attempt(
    c: ChannelSpec,
    f: ChannelsFile,
    n: Notification,
  ): Promise<Omit<Delivery, 'channel'>> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last: Outcome = { ok: false, retry: false, status: 'not-sent' };
    for (let i = 1; i <= f.retry.attempts; i++) {
      last = await this.once(c, f, n);
      if (last.ok || !last.retry || i === f.retry.attempts)
        return { ok: last.ok, status: last.status, attempts: i };
      await sleep(f.retry.baseMs * 2 ** (i - 1));
    }
    return { ok: last.ok, status: last.status, attempts: f.retry.attempts };
  }

  private once(c: ChannelSpec, f: ChannelsFile, n: Notification): Promise<Outcome> {
    if (c.type === 'markdown')
      return Promise.resolve(writeLocal(this.d.store.dir, n, this.d.clock()));
    if (c.type === 'smtp') return this.mail(c, f, n);
    const req = buildRequest(c, n, this.d.env);
    if (typeof req === 'string') return Promise.resolve({ ok: false, retry: false, status: req });
    return postJson(req, f.timeoutMs);
  }

  private mail(
    c: Extract<ChannelSpec, { type: 'smtp' }>,
    f: ChannelsFile,
    n: Notification,
  ): Promise<Outcome> {
    const user = c.userEnv ? this.d.env[c.userEnv] : undefined;
    const pass = c.secretEnv ? this.d.env[c.secretEnv] : undefined;
    if ((c.userEnv && !user) || (c.secretEnv && !pass))
      return Promise.resolve({ ok: false, retry: false, status: 'no-secret' });
    return sendMail({
      host: c.host,
      port: c.port,
      secure: c.secure,
      from: c.from,
      to: c.to,
      subject: n.payload['subject'] ?? '',
      text: n.payload['text'] ?? '',
      ...(user && pass ? { auth: { user, pass } } : {}),
      timeoutMs: f.timeoutMs,
      now: this.d.clock(),
    });
  }

  /** Journal and feed: channel id, type, attempts and a status word. Nothing else. */
  private record(
    programId: string | undefined,
    c: ChannelSpec,
    r: Omit<Delivery, 'channel'>,
    why?: string,
  ): void {
    const action = r.ok
      ? 'notification sent'
      : r.status === 'refused'
        ? 'notification refused'
        : 'notification failed';
    this.d.fact(programId, {
      action,
      channel: c.id,
      type: c.type,
      attempts: r.attempts,
      status: r.status,
      ...(why ? { reason: why } : {}),
    });
    if (r.ok) return;
    const tail = why ?? `${r.status}, ${r.attempts} attempt(s)`;
    this.d.feed.line(
      `notification to ${c.id} ${r.status === 'refused' ? 'refused' : 'failed'}: ${tail}`,
      programId,
      [],
      this.d.clock(),
    );
  }

  private async archive(
    item: Extract<OutItem, { kind: 'report' }>,
    out: Delivery[],
  ): Promise<void> {
    const sent = out.filter((x) => x.ok).map((x) => x.channel);
    await this.d.store.locked(() =>
      this.d.store.updateMeta(item.programId, (m) => {
        const e = m.reports.find((r) => r.reportId === item.reportId);
        if (e) e.channels = [...new Set([...e.channels, ...sent])].slice(0, 20);
      }),
    );
  }
}
