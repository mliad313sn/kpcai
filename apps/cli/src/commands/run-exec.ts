import { refToString, type Attempt, type ExecutionResult } from '@kernelpai/core';
import type { BudgetGate } from '@kernelpai/kernel';
import { FallbackExecutor, outputCalibration } from '@kernelpai/executor';
import type { Journal } from '@kernelpai/journal';
import { formatMoney, type Money } from '../config.js';
import { buildRegistry } from '../context.js';
import type { Io } from '../io.js';
import { sanitizeForTerminal } from '../sanitize.js';
import type { Planned } from './run.js';

/**
 * Prints the answer. On a terminal it streams live and marks discarded partial output;
 * when piped, only the final attempt's text reaches stdout (review F2).
 */
class AnswerSink {
  private buffer = '';
  private printed = 0;

  constructor(private readonly io: Io) {}

  start(): void {
    this.buffer = '';
    this.printed = 0;
  }

  text(delta: string): void {
    this.buffer += delta;
    if (this.io.stdoutIsTTY) {
      this.io.out(sanitizeForTerminal(delta));
      this.printed += delta.length;
    }
  }

  failed(a: Attempt): void {
    const discarded = this.printed > 0 ? ` — ${this.printed} chars above discarded` : '';
    this.io.err(
      `\n↷ ${refToString(a.ref)} failed (${a.errorKind ?? 'error'}): ${sanitizeForTerminal(a.message ?? '')}${discarded}\n`,
    );
  }

  finish(r: ExecutionResult): void {
    if (!this.io.stdoutIsTTY && r.servedBy) this.io.out(this.buffer);
    this.io.out('\n');
  }
}

export interface ExecContext {
  io: Io;
  journal: Journal;
  sessionId: string;
  p: Planned;
  gate: BudgetGate;
}

export async function execute(c: ExecContext): Promise<number> {
  const { io, journal, sessionId, p } = c;
  const registry = buildRegistry(io.env, io.err);
  const executor = new FallbackExecutor((ref) => registry.get(ref.provider), journal, {
    expectedOutput: outputCalibration(journal),
    ...stallTimeouts(io),
  });
  const ctl = new AbortController();
  const unregister = io.onInterrupt(() => {
    journal.append({
      sessionId,
      type: 'intervention',
      nodeId: p.node.id,
      payload: { action: 'cancel' },
    });
    ctl.abort();
  });
  const sink = new AnswerSink(io);
  const started = Date.now();
  try {
    const r = await executor.execute(p.node, p.decision, {
      sessionId,
      signal: ctl.signal,
      hooks: {
        onAttemptStart: () => sink.start(),
        onText: (delta) => sink.text(delta),
        onAttemptFailed: (a) => sink.failed(a),
        beforeFallback: (next) => c.gate.allow(next, 'fallback'),
      },
    });
    sink.finish(r);
    io.err(footer(r, (Date.now() - started) / 1000, sessionId, p.m));
    if (r.stopReason === 'cancelled') return 130;
    return r.servedBy ? 0 : 1;
  } finally {
    unregister();
  }
}

/** KPAI_FIRST_CHUNK_TIMEOUT_MS / KPAI_IDLE_TIMEOUT_MS (0 disables); defaults 30 s / 60 s. */
function stallTimeouts(io: Io): { firstChunkTimeoutMs?: number; idleTimeoutMs?: number } {
  const read = (name: string): number | undefined => {
    const raw = io.env[name]?.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0)
      throw new Error(`${name} must be a whole number of ms >= 0, got "${raw}"`);
    return n;
  };
  const first = read('KPAI_FIRST_CHUNK_TIMEOUT_MS');
  const idle = read('KPAI_IDLE_TIMEOUT_MS');
  return {
    ...(first !== undefined ? { firstChunkTimeoutMs: first } : {}),
    ...(idle !== undefined ? { idleTimeoutMs: idle } : {}),
  };
}

function footer(r: ExecutionResult, secs: number, sessionId: string, m: Money): string {
  const by = r.servedBy ? refToString(r.servedBy) : 'nobody';
  return `— ${by}${r.fellBack ? ' (fallback)' : ''} · ${secs.toFixed(1)}s · ${r.usage.inputTokens} in / ${r.usage.outputTokens} out · ${formatMoney(r.costUsd, m)} · ${r.stopReason} · ${r.attempts.length} attempt(s) · session ${sessionId.slice(0, 8)}\n`;
}
