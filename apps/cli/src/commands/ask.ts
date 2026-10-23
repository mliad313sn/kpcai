import { randomUUID } from 'node:crypto';
import {
  ProviderError,
  costUsd,
  estimateTokens,
  formatUsd,
  type ChatRequest,
  type ProviderAdapter,
  type StopReason,
  type Usage,
} from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import { buildRegistry, confirmThreshold, openJournal } from '../context.js';
import type { Io } from '../io.js';
import { sanitizeForTerminal } from '../sanitize.js';

export interface AskOptions {
  model?: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
  yes?: boolean;
  db?: string;
}

interface Call {
  io: Io;
  journal: Journal;
  sessionId: string;
  adapter: ProviderAdapter;
  req: ChatRequest;
}

const ROUTING_REASON = 'explicit user choice (-m); the competence router arrives in phase 1';

/** `kpai ask -m provider/model "prompt"`: one streamed, budget-checked, journaled call. */
export async function askCommand(io: Io, opts: AskOptions): Promise<number> {
  if (!opts.model) {
    io.err('Choose a model with -m provider/model (see `kpai providers`).\n');
    io.err('Phase 0 never picks a model by default; competence routing comes in phase 1.\n');
    return 2;
  }
  const { adapter, model } = buildRegistry(io.env).resolve(opts.model);
  const req: ChatRequest = {
    model,
    messages: [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      { role: 'user' as const, content: opts.prompt },
    ],
    ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
  };
  const journal = openJournal(io.env, opts.db);
  try {
    const sessionId = journal.startSession(opts.prompt.slice(0, 80), io.cwd);
    const call: Call = { io, journal, sessionId, adapter, req };
    journal.append({
      ...who(call),
      sessionId,
      type: 'routing',
      payload: { reason: ROUTING_REASON },
    });
    if (!(await budgetGate(call, opts.yes ?? false))) return 4;
    return await run(call);
  } finally {
    journal.close();
  }
}

function who(c: Pick<Call, 'adapter' | 'req'>): {
  provider: string;
  model: string;
  nodeId: string;
} {
  return { provider: c.adapter.descriptor.id, model: c.req.model, nodeId: 'n1' };
}

/** Principle 6: show the estimate, ask before spending above the threshold. */
async function budgetGate(c: Call, yes: boolean): Promise<boolean> {
  const est = c.adapter.estimate(c.req);
  const threshold = confirmThreshold(c.io.env);
  c.io.err(
    `estimate: ~${est.inputTokens} in, ≤${est.maxOutputTokens} out · expected ${formatUsd(est.expectedCostUsd)} (max ${formatUsd(est.maxCostUsd)})\n`,
  );
  if (est.expectedCostUsd <= threshold || yes) return true;
  const ok = await c.io.confirm(
    `Expected cost ${formatUsd(est.expectedCostUsd)} is above your threshold ${formatUsd(threshold)}. Continue?`,
  );
  if (!ok) {
    c.journal.append({
      ...who(c),
      sessionId: c.sessionId,
      type: 'intervention',
      payload: { action: 'declined: estimate above threshold', estimate: est, threshold },
    });
    c.io.err('cancelled before sending (budget)\n');
  }
  return ok;
}

async function run(c: Call): Promise<number> {
  const requestId = randomUUID();
  const started = Date.now();
  const est = c.adapter.estimate(c.req);
  c.journal.append({
    ...who(c),
    sessionId: c.sessionId,
    type: 'call',
    payload: { requestId, estimatedInputTokens: est.inputTokens, request: c.req },
  });
  let text = '';
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = 'other';
  const unregister = c.io.onInterrupt(() => {
    if (c.adapter.cancel(requestId)) {
      c.journal.append({
        ...who(c),
        sessionId: c.sessionId,
        type: 'intervention',
        payload: { action: 'cancel' },
      });
    }
  });
  try {
    for await (const ev of c.adapter.send(c.req, { requestId })) {
      if (ev.type === 'text') {
        text += ev.delta;
        c.io.out(c.io.stdoutIsTTY ? sanitizeForTerminal(ev.delta) : ev.delta);
      } else if (ev.type === 'usage') usage = ev.usage;
      else if (ev.type === 'end') stopReason = ev.stopReason;
    }
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'cancelled') stopReason = 'cancelled';
    else return failed(c, err, text);
  } finally {
    unregister();
  }
  // A cancelled call may never report usage; bill it from estimates rather than as free.
  const estimated = stopReason === 'cancelled' && usage.inputTokens === 0;
  if (estimated) usage = { inputTokens: est.inputTokens, outputTokens: estimateTokens(text) };
  return finished(c, { text, usage, stopReason, ms: Date.now() - started, estimated });
}

function finished(
  c: Call,
  r: { text: string; usage: Usage; stopReason: StopReason; ms: number; estimated: boolean },
): number {
  const card = c.adapter.capabilities().find((m) => m.id === c.req.model);
  const cost = card ? costUsd(card.price, r.usage) : 0;
  c.journal.append({
    ...who(c),
    sessionId: c.sessionId,
    type: 'response',
    costUsd: cost,
    payload: {
      text: r.text,
      ...r.usage,
      usageBasis: r.estimated ? 'estimated' : 'reported',
      stopReason: r.stopReason,
      durationMs: r.ms,
    },
  });
  const secs = (r.ms / 1000).toFixed(1);
  c.io.out('\n');
  c.io.err(
    `— ${c.adapter.descriptor.id}/${c.req.model} · ${secs}s · ${r.usage.inputTokens} in / ${r.usage.outputTokens} out · ${formatUsd(cost)} · ${r.stopReason} · session ${c.sessionId.slice(0, 8)}\n`,
  );
  return r.stopReason === 'cancelled' ? 130 : 0;
}

function failed(c: Call, err: unknown, partial: string): number {
  const kind = err instanceof ProviderError ? err.kind : 'internal';
  const message = err instanceof Error ? err.message : String(err);
  c.journal.append({
    ...who(c),
    sessionId: c.sessionId,
    type: 'error',
    payload: { kind, message, partialText: partial },
  });
  c.io.err(
    `\nerror (${kind}): ${sanitizeForTerminal(message)} · session ${c.sessionId.slice(0, 8)}\n`,
  );
  return 1;
}
