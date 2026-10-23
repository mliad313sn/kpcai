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

const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  end_turn: 'end',
  stop_sequence: 'end',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

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
    const notLocal = localHostProblem(this.descriptor, resolveBaseUrl(this.descriptor, this.env));
    return Promise.resolve(
      notLocal
        ? { available: false, reason: notLocal }
        : key
          ? { available: true, reason: `${this.descriptor.auth?.env} is set` }
          : { available: false, reason: `${this.descriptor.auth?.env} is not set` },
    );
  }

  protected async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const turns = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    let inputTokens = 0;
    let stop: string | null = null;
    try {
      const stream = this.getClient().messages.stream(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
          messages: turns,
        },
        { signal },
      );
      for await (const ev of stream) {
        if (ev.type === 'message_start') inputTokens = ev.message.usage.input_tokens;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          yield { type: 'text', delta: ev.delta.text };
        }
        if (ev.type === 'message_delta') {
          stop = ev.delta.stop_reason;
          const usage = { inputTokens, outputTokens: ev.usage.output_tokens };
          yield { type: 'usage', usage };
        }
      }
    } catch (err) {
      throw this.mapError(err);
    }
    const stopReason = STOP_REASONS[stop ?? ''] ?? 'other';
    if (stopReason === 'refusal') {
      throw new ProviderError('refusal', this.descriptor.id, 'The model declined the request');
    }
    yield { type: 'end', stopReason };
  }

  private getClient(): Anthropic {
    const apiKey = resolveApiKey(this.descriptor, this.env);
    const base = resolveBaseUrl(this.descriptor, this.env);
    const notLocal = localHostProblem(this.descriptor, base);
    if (notLocal) throw new ProviderError('unavailable', this.descriptor.id, notLocal);
    if (base && !mayCarryCredentials(base)) {
      throw new ProviderError(
        'bad_request',
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
