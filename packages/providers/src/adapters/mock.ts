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

  /**
   * `[[fail:kind]]` fails every mock before any output; `[[fail:kind@provider]]` only that
   * provider. `[[midfail:…]]` is the same but fails after streaming half the answer.
   */
  private forcedFailure(prompt: string, tag = 'fail'): string | undefined {
    const re = new RegExp(`\\[\\[${tag}:([a-z_]+)(?:@([a-z0-9-]+))?\\]\\]`, 'g');
    for (const m of prompt.matchAll(re)) {
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
    const midFail = this.forcedFailure(prompt, 'midfail');
    const words = answer.split(/(?<= )/);
    let sent = 0;
    for (const [i, word] of words.entries()) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (midFail && i === Math.floor(words.length / 2)) {
        throw new ProviderError(
          midFail as ProviderError['kind'],
          this.descriptor.id,
          `Simulated ${midFail} mid-stream`,
        );
      }
      if (delayMs) await sleep(delayMs, undefined, { signal });
      sent += word.length;
      yield { type: 'text', delta: word };
    }
    const inputTokens = req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    yield { type: 'usage', usage: { inputTokens, outputTokens: Math.ceil(sent / 4) } };
    yield { type: 'end', stopReason: 'end' };
  }
}
