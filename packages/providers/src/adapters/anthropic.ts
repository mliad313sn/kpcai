import Anthropic from '@anthropic-ai/sdk';
import {
  BaseAdapter,
  ProviderError,
  kindFromStatus,
  type ChatRequest,
  type DetectResult,
  type ProviderDescriptor,
  type StopReason,
  type StreamEvent,
} from '@kernelpai/core';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '@kernelpai/core';
import {
  localHostProblem,
  mayCarryCredentials,
  resolveApiKey,
  resolveBaseUrl,
  type Env,
} from '../env.js';
import { parseToolInput, toolNameCodec, type ToolNameCodec } from '../tool-calls.js';
import { toAnthropicMessages, toAnthropicTools } from './anthropic-messages.js';

const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  end_turn: 'end',
  stop_sequence: 'end',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  tool_use: 'tool_use',
};

interface StreamState {
  inputTokens: number;
  stop: string | null;
  /** Tool use blocks being streamed, by content block index. */
  pending: Map<number, { id: string; name: string; json: string }>;
}

/** Anthropic Messages API adapter, built on the official SDK (ADR-0003). */
export class AnthropicAdapter extends BaseAdapter {
  private readonly env: Env;
  private client: Anthropic | undefined;

  constructor(descriptor: ProviderDescriptor, env: Env) {
    super(descriptor);
    this.env = env;
  }

  detect(): Promise<DetectResult> {
    const key = resolveApiKey(this.descriptor, this.env);
    const base = resolveBaseUrl(this.descriptor, this.env);
    const notLocal =
      localHostProblem(this.descriptor, base) ??
      (key && base && !mayCarryCredentials(base)
        ? `refusing to send credentials to ${base}: not https`
        : undefined);
    return Promise.resolve(
      notLocal
        ? { available: false, reason: notLocal }
        : key
          ? { available: true, reason: `${this.descriptor.auth?.env} is set` }
          : { available: false, reason: `${this.descriptor.auth?.env} is not set` },
    );
  }

  protected async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const codec = toolNameCodec(req);
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const tools = toAnthropicTools(req, codec);
    const state: StreamState = { inputTokens: 0, stop: null, pending: new Map() };
    try {
      const stream = await this.getClient().messages.create(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
          messages: toAnthropicMessages(this.descriptor.id, req.messages, codec),
          // Tool choice stays `auto` (the API default): the model decides.
          ...(tools.length > 0 ? { tools } : {}),
          stream: true,
        },
        { signal },
      );
      for await (const ev of stream) yield* this.onEvent(ev, state, codec);
    } catch (err) {
      throw this.mapError(err);
    }
    if (state.stop === null) {
      throw new ProviderError(
        'malformed',
        this.descriptor.id,
        'Stream ended without a stop reason',
      );
    }
    const stopReason = STOP_REASONS[state.stop] ?? 'other';
    if (stopReason === 'refusal') {
      throw new ProviderError('refusal', this.descriptor.id, 'The model declined the request');
    }
    yield { type: 'end', stopReason };
  }

  private *onEvent(
    ev: Anthropic.RawMessageStreamEvent,
    state: StreamState,
    codec: ToolNameCodec,
  ): Iterable<StreamEvent> {
    if (ev.type === 'message_start') state.inputTokens = ev.message.usage.input_tokens;
    if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
      const { id, name } = ev.content_block;
      state.pending.set(ev.index, { id, name: codec.decode(name), json: '' });
    }
    if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') {
      const call = state.pending.get(ev.index);
      if (call) call.json += ev.delta.partial_json;
    }
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      yield { type: 'text', delta: ev.delta.text };
    } else if (ev.type === 'content_block_delta' || ev.type === 'content_block_start') {
      // Thinking, tool input and other non-text blocks: alive, nothing to show (review R1).
      yield { type: 'progress', kind: 'reasoning' };
    }
    if (ev.type === 'content_block_stop') {
      const call = state.pending.get(ev.index);
      state.pending.delete(ev.index);
      if (call) {
        const input = parseToolInput(this.descriptor.id, call.name, call.json);
        yield { type: 'tool_call', call: { id: call.id, name: call.name, input } };
      }
    }
    if (ev.type === 'message_delta') {
      state.stop = ev.delta.stop_reason;
      yield {
        type: 'usage',
        usage: { inputTokens: state.inputTokens, outputTokens: ev.usage.output_tokens },
      };
    }
  }

  private getClient(): Anthropic {
    const apiKey = resolveApiKey(this.descriptor, this.env);
    const base = resolveBaseUrl(this.descriptor, this.env);
    const notLocal = localHostProblem(this.descriptor, base);
    if (notLocal) throw new ProviderError('unavailable', this.descriptor.id, notLocal);
    if (base && !mayCarryCredentials(base)) {
      throw new ProviderError(
        'unavailable',
        this.descriptor.id,
        `refusing to send credentials to ${base}: not https`,
      );
    }
    if (!apiKey) {
      throw new ProviderError(
        'auth',
        this.descriptor.id,
        `${this.descriptor.auth?.env} is not set`,
      );
    }
    this.client ??= new Anthropic({
      apiKey,
      baseURL: resolveBaseUrl(this.descriptor, this.env) ?? null,
      // Fallback is the kernel's job (phase 1 router), not the SDK's.
      maxRetries: 0,
    });
    return this.client;
  }

  private mapError(err: unknown): unknown {
    if (err instanceof ProviderError || err instanceof Anthropic.APIUserAbortError) return err;
    const id = this.descriptor.id;
    if (err instanceof Anthropic.APIConnectionError) {
      return new ProviderError('unavailable', id, `Cannot reach Anthropic: ${err.message}`, {
        cause: err,
      });
    }
    if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
      return new ProviderError(kindFromStatus(err.status), id, err.message, {
        status: err.status,
        cause: err,
      });
    }
    if (err instanceof Anthropic.AnthropicError) {
      return new ProviderError('malformed', id, err.message, { cause: err });
    }
    return err;
  }
}
