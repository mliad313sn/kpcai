import { z } from 'zod';
import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  JSONParseError,
  InvalidStreamPartError,
  LoadAPIKeyError,
  NoContentGeneratedError,
  NoSuchModelError,
  StreamProviderError,
  TypeValidationError,
  streamText,
  type FinishReason,
  type ModelMessage,
} from 'ai';
import {
  BaseAdapter,
  ProviderError,
  isAbortError,
  kindFromStatus,
  type ChatRequest,
  type DetectResult,
  type ModelCard,
  type ProviderDescriptor,
  type StopReason,
  type StreamEvent,
} from '@kernelpai/core';
import {
  localHostProblem,
  mayCarryCredentials,
  resolveApiKey,
  resolveBaseUrl,
  type Env,
} from '../env.js';
import { localCard } from '../local-card.js';
import { modelFactory, type AiSdkName, type ModelFactory } from './ai-sdk-models.js';

const DETECT_TIMEOUT_MS = 1500;

/** OpenAI-style `GET /models` listing (llama.cpp, LM Studio, vLLM...). */
const ModelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).loose()),
});

const STOP_REASONS: Readonly<Record<FinishReason, StopReason>> = {
  stop: 'end',
  length: 'max_tokens',
  'content-filter': 'refusal',
  'tool-calls': 'other',
  error: 'other',
  interrupted: 'other',
  other: 'other',
};

/** AI SDK errors meaning "the provider answered, but not in a shape we can use". */
const MALFORMED = [
  JSONParseError,
  TypeValidationError,
  InvalidResponseDataError,
  EmptyResponseBodyError,
  NoContentGeneratedError,
  InvalidStreamPartError,
] as const;

/**
 * Generic adapter over the Vercel AI SDK v7 (ADR-0002): one class serving every
 * descriptor whose `adapter` is `ai-sdk:<sdk>`. The SDK only does transport and
 * protocol; retries are off and every failure becomes a ProviderError kind.
 */
export class AiSdkAdapter extends BaseAdapter {
  readonly sdk: AiSdkName;
  private readonly env: Env;
  private readonly fetchImpl: typeof fetch;
  private factory: ModelFactory | undefined;

  constructor(descriptor: ProviderDescriptor, env: Env, sdk: AiSdkName, fetchImpl = fetch) {
    super(descriptor);
    this.sdk = sdk;
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  async detect(): Promise<DetectResult> {
    const auth = this.descriptor.auth;
    if (auth && !resolveApiKey(this.descriptor, this.env)) {
      return { available: false, reason: `${auth.env} is not set` };
    }
    const notLocal = localHostProblem(this.descriptor, this.baseUrl());
    if (notLocal) return { available: false, reason: notLocal };
    if (this.descriptor.discoverModels) return this.discover();
    return { available: true, reason: auth ? `${auth.env} is set` : 'no credentials needed' };
  }

  override card(modelId: string): ModelCard {
    // Local servers may load a model after detection; accept it with default limits.
    if (this.descriptor.discoverModels && !this.capabilities().some((m) => m.id === modelId)) {
      this.discovered.push(localCard(this.descriptor, modelId));
    }
    return super.card(modelId);
  }

  protected async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const messages: ModelMessage[] = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const result = streamText({
      model: this.getFactory()(req.model),
      ...(system.length > 0 ? { instructions: system.join('\n\n') } : {}),
      messages,
      ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
      // Retry and fallback belong to the kernel (ADR-0002), never to the SDK.
      maxRetries: 0,
      abortSignal: signal,
      // Errors surface as `error` parts below; the default handler would log them.
      onError: () => undefined,
    });
    let finished = false;
    try {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          if (part.text) yield { type: 'text', delta: part.text };
        } else if (part.type === 'error') {
          throw part.error;
        } else if (part.type === 'abort') {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        } else if (part.type === 'finish') {
          finished = true;
          yield* this.finish(part.finishReason, part.totalUsage);
        }
      }
    } catch (err) {
      throw this.mapError(err);
    }
    if (!finished) {
      throw new ProviderError('malformed', this.descriptor.id, 'Stream ended without finish');
    }
  }

  private *finish(
    reason: FinishReason,
    usage: { inputTokens: number | undefined; outputTokens: number | undefined },
  ): Iterable<StreamEvent> {
    yield {
      type: 'usage',
      usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
    };
    const stopReason = STOP_REASONS[reason] ?? 'other';
    if (stopReason === 'refusal') {
      throw new ProviderError('refusal', this.descriptor.id, 'The model declined the request');
    }
    yield { type: 'end', stopReason };
  }

  private async discover(): Promise<DetectResult> {
    const base = this.baseUrl();
    if (!base) return { available: false, reason: 'model discovery needs a base URL' };
    const key = resolveApiKey(this.descriptor, this.env);
    if (key && !mayCarryCredentials(base)) {
      return { available: false, reason: `refusing to send credentials to ${base}: not https` };
    }
    try {
      const res = await this.fetchImpl(`${base}/models`, {
        // Only a descriptor with `auth` ever gets an Authorization header.
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
      });
      if (!res.ok) return { available: false, reason: `HTTP ${res.status} from ${base}` };
      const list = ModelListSchema.parse(await res.json());
      this.discovered = list.data.map((m) => localCard(this.descriptor, m.id));
      return {
        available: true,
        reason: `${list.data.length} model(s) at ${base}`,
        models: this.discovered,
      };
    } catch (err) {
      return { available: false, reason: `not reachable at ${base} (${String(err)})` };
    }
  }

  private baseUrl(): string | undefined {
    return resolveBaseUrl(this.descriptor, this.env);
  }

  private getFactory(): ModelFactory {
    const auth = this.descriptor.auth;
    const apiKey = resolveApiKey(this.descriptor, this.env);
    if (auth && !apiKey) {
      throw new ProviderError('auth', this.descriptor.id, `${auth.env} is not set`);
    }
    const baseURL = this.baseUrl();
    const notLocal = localHostProblem(this.descriptor, baseURL);
    if (notLocal) throw new ProviderError('unavailable', this.descriptor.id, notLocal);
    if (apiKey && baseURL && !mayCarryCredentials(baseURL)) {
      throw new ProviderError(
        'bad_request',
        this.descriptor.id,
        `refusing to send credentials to ${baseURL}: not https`,
      );
    }
    this.factory ??= modelFactory(this.sdk, {
      name: this.descriptor.id,
      apiKey,
      baseURL,
      fetch: this.fetchImpl,
    });
    return this.factory;
  }

  private mapError(err: unknown): unknown {
    if (err instanceof ProviderError || isAbortError(err)) return err;
    const id = this.descriptor.id;
    if (APICallError.isInstance(err)) {
      const status = err.statusCode;
      if (status === undefined) {
        return new ProviderError('unavailable', id, `Cannot reach ${id}: ${err.message}`, {
          cause: err,
        });
      }
      const detail = err.message || err.responseBody?.slice(0, 200) || '';
      return new ProviderError(kindFromStatus(status), id, `HTTP ${status}: ${detail}`, {
        status,
        cause: err,
      });
    }
    if (StreamProviderError.isInstance(err)) {
      // An error event inside an open stream (overload, upstream failure...).
      const kind = err.statusCode ? kindFromStatus(err.statusCode) : 'unavailable';
      return new ProviderError(kind, id, `Provider error mid-stream: ${err.message}`, {
        status: err.statusCode,
        cause: err,
      });
    }
    if (LoadAPIKeyError.isInstance(err)) {
      return new ProviderError('auth', id, err.message, { cause: err });
    }
    return this.mapOtherError(err);
  }

  /**
   * Review F13: only known parse/validation classes are `malformed`. A retired or
   * unknown model is `unavailable` (another model may work). Any other Error is a
   * programming or configuration fault: `bad_request`, never hidden by a fallback.
   */
  private mapOtherError(err: unknown): ProviderError {
    const id = this.descriptor.id;
    if (MALFORMED.some((cls) => cls.isInstance(err))) {
      return new ProviderError('malformed', id, (err as Error).message, { cause: err });
    }
    if (NoSuchModelError.isInstance(err)) {
      return new ProviderError('unavailable', id, err.message, { cause: err });
    }
    if (err instanceof Error) {
      return new ProviderError('bad_request', id, `${err.name}: ${err.message}`, { cause: err });
    }
    // Anything else is opaque provider data: treat the provider as unavailable.
    return new ProviderError('unavailable', id, `Provider error: ${describe(err)}`, {
      cause: err,
    });
  }
}

function describe(err: unknown): string {
  try {
    return JSON.stringify(err).slice(0, 200);
  } catch {
    return String(err);
  }
}
