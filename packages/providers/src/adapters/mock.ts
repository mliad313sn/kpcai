import {
  BaseAdapter,
  ProviderError,
  estimateTokens,
  type ChatRequest,
  type DetectResult,
  type StreamEvent,
} from '@kernelpai/core';
import { setTimeout as sleep } from 'node:timers/promises';

export interface MockBehaviour {
  /** Delay between streamed words, in ms. */
  delayMs?: number;
  /** Force a failure of this kind instead of answering. */
  failWith?: ProviderError['kind'];
}

/**
 * Offline adapter that answers deterministically. Used by the demo and by tests;
 * prompt triggers `[[fail:<kind>]]` / `[[fail:<kind>@<provider>]]` simulate provider failures and `[[slow]]` slows streaming.
 */
export class MockAdapter extends BaseAdapter {
  behaviour: MockBehaviour = {};

  detect(): Promise<DetectResult> {
    return Promise.resolve({ available: true, reason: 'built-in offline provider' });
  }

  /** `[[fail:kind]]` fails every mock; `[[fail:kind@provider]]` only that provider. */
  private forcedFailure(prompt: string): string | undefined {
    for (const m of prompt.matchAll(/\[\[fail:([a-z_]+)(?:@([a-z0-9-]+))?\]\]/g)) {
      if (!m[2] || m[2] === this.descriptor.id) return m[1];
    }
    return undefined;
  }

  protected async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const prompt = req.messages.at(-1)?.content ?? '';
    const forced = this.forcedFailure(prompt) ?? this.behaviour.failWith;
    if (forced) {
      throw new ProviderError(
        forced as ProviderError['kind'],
        this.descriptor.id,
        `Simulated ${forced}`,
      );
    }
    const answer = `[mock/${req.model}] You asked: ${prompt.trim()}`;
    const delayMs = prompt.includes('[[slow]]') ? 50 : this.behaviour.delayMs;
    let sent = 0;
    for (const word of answer.split(/(?<= )/)) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (delayMs) await sleep(delayMs, undefined, { signal });
      sent += word.length;
      yield { type: 'text', delta: word };
    }
    const inputTokens = req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    yield { type: 'usage', usage: { inputTokens, outputTokens: Math.ceil(sent / 4) } };
    yield { type: 'end', stopReason: 'end' };
  }
}
