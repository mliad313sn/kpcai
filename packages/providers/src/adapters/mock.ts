import {
  BaseAdapter,
  ProviderError,
  estimateTokens,
  type ChatRequest,
  type DetectResult,
  type StreamEvent,
} from '@kernelpai/core';
import { setTimeout as sleep } from 'node:timers/promises';
import { scriptedReply } from './mock-script.js';

export interface MockBehaviour {
  /** Delay between streamed words, in ms. */
  delayMs?: number;
  /** Force a failure of this kind instead of answering. */
  failWith?: ProviderError['kind'];
}

/**
 * Offline adapter that answers deterministically. Used by demos and tests; it is
 * scripted only by markers in the prompt (case-sensitive), never by descriptor fields.
 *
 * Failure and timing markers, read from the LAST message:
 * - `[[fail:<kind>]]` fails every mock before any output; `[[fail:<kind>@<provider>]]`
 *   only that provider. `[[midfail:<kind>]]` / `[[midfail:<kind>@<provider>]]` fail
 *   after half the answer was streamed. `[[slow]]` streams one word per 50 ms.
 *
 * Scripting markers, read from the system message(s) and the LAST USER message
 * (the role is taken from the system messages first, then the first `Role: x` in the
 * last user message, so put it before any quoted content):
 * - `Role: planner` → a TaskGraph JSON: the JSON object of `[[plan:{...}]]` verbatim,
 *   else a default plan for the request (a `Request: <text>` line, else the whole last
 *   user message). Code requests (words like code, implement, fix, test, validator, api)
 *   → chain n1 analysis/solo → n2 code_generation/author_critic → n3 test/author_critic
 *   → n4 critique/solo; anything else → one node n1 analysis/solo. createdBy "model".
 * - `Role: critic` → Verdict JSON `{"approve":true,"issues":[],"summary":"…"}`; with
 *   `[[reject]]` (any critic) or `[[reject@<provider-id>]]` (that provider only) and no
 *   `[[revised]]` anywhere in the conversation → `{"approve":false,"issues":[{"severity":
 *   "major","text":"…"}],"summary":"…"}`.
 * - `Role: judge` → `{"winner":0,"reason":"…"}`; `[[judge:<n>]]` picks answer n.
 * - `Role: voter` → plain text: the first option of an `Options: a | b | c` line, or
 *   `<option>` from `[[vote:<option>]]` / `[[vote:<option>@<provider-id>]]`.
 * - `[[tool:<name> {json}]]` (or `[[tool:<name>]]` for `{}`) → while no `tool` message
 *   follows the last user message: one `tool_call` event (id `mock_call_1`, the given
 *   name and input; a `{…}` that is not valid JSON fails with `malformed`; a marker not
 *   shaped `[[tool:<name>]]` / `[[tool:<name> {…}]]` is ignored) and stop reason
 *   `tool_use`. Once a `tool` message follows: `[mock/<model>] tool said: <first 80
 *   chars of the last tool result>` (for any prompt without a planner/critic/judge/voter role).
 * - `[[diff:<path>]]` → a git-apply-able unified diff creating `<path>` (3 lines).
 * - `Role: author` with a prior critique in the conversation (a `"approve":` key or the
 *   word "critique" in any non-system message) → the answer contains `[[revised]]` (in a
 *   diff: an added `// [[revised]]` line).
 * Otherwise: `[mock/<model>] You asked: <last message>`.
 */
export class MockAdapter extends BaseAdapter {
  behaviour: MockBehaviour = {};

  detect(): Promise<DetectResult> {
    return Promise.resolve({ available: true, reason: 'built-in offline provider' });
  }

  private forcedFailure(prompt: string, tag = 'fail'): string | undefined {
    const re = new RegExp(`\\[\\[${tag}:([a-z_]+)(?:@([a-z0-9-]+))?\\]\\]`, 'g');
    for (const m of prompt.matchAll(re)) {
      if (!m[2] || m[2] === this.descriptor.id) return m[1];
    }
    return undefined;
  }

  private fail(kind: string, detail = ''): ProviderError {
    return new ProviderError(
      kind as ProviderError['kind'],
      this.descriptor.id,
      `Simulated ${kind}${detail}`,
    );
  }

  protected async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const prompt = req.messages.at(-1)?.content ?? '';
    const forced = this.forcedFailure(prompt) ?? this.behaviour.failWith;
    if (forced) throw this.fail(forced);
    const echo = `[mock/${req.model}] You asked: ${prompt.trim()}`;
    const reply = scriptedReply(req, this.descriptor.id, echo) ?? { kind: 'text', text: echo };
    const inputTokens = req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    if (reply.kind === 'tool') {
      yield { type: 'tool_call', call: reply.call };
      const outputTokens = Math.ceil(JSON.stringify(reply.call.input).length / 4);
      yield { type: 'usage', usage: { inputTokens, outputTokens } };
      yield { type: 'end', stopReason: 'tool_use' };
      return;
    }
    const sent = yield* this.words(reply.text, prompt, signal);
    yield { type: 'usage', usage: { inputTokens, outputTokens: Math.ceil(sent / 4) } };
    yield { type: 'end', stopReason: 'end' };
  }

  /** Streams `answer` word by word; returns the number of characters sent. */
  private async *words(
    answer: string,
    prompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent, number> {
    const delayMs = prompt.includes('[[slow]]') ? 50 : this.behaviour.delayMs;
    const midFail = this.forcedFailure(prompt, 'midfail');
    const words = answer.split(/(?<= )/);
    let sent = 0;
    for (const [i, word] of words.entries()) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (midFail && i === Math.floor(words.length / 2)) throw this.fail(midFail, ' mid-stream');
      if (delayMs) await sleep(delayMs, undefined, { signal });
      sent += word.length;
      yield { type: 'text', delta: word };
    }
    return sent;
  }
}
