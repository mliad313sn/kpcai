import { z } from 'zod';
import {
  BaseAdapter,
  ProviderError,
  kindFromStatus,
  type ChatRequest,
  type DetectResult,
  type ModelCard,
  type ProviderDescriptor,
  type StopReason,
  type StreamEvent,
} from '@kernelpai/core';
import { readLines } from '../lines.js';
import { localHostProblem, resolveBaseUrl, type Env } from '../env.js';
import { localCard } from '../local-card.js';

const TagsSchema = z.object({
  models: z.array(z.object({ name: z.string().min(1) }).loose()),
});

const ChunkSchema = z
  .object({
    message: z.object({ content: z.string() }).loose().optional(),
    done: z.boolean(),
    done_reason: z.string().optional(),
    prompt_eval_count: z.number().optional(),
    eval_count: z.number().optional(),
    error: z.string().optional(),
  })
  .loose();

const DETECT_TIMEOUT_MS = 1500;

/** Local Ollama server via its native REST API (/api/chat, /api/tags). */
export class OllamaAdapter extends BaseAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(descriptor: ProviderDescriptor, env: Env, fetchImpl: typeof fetch = fetch) {
    super(descriptor);
    this.baseUrl = resolveBaseUrl(descriptor, env) ?? 'http://127.0.0.1:11434';
    this.fetchImpl = fetchImpl;
  }

  async detect(): Promise<DetectResult> {
    const notLocal = localHostProblem(this.descriptor, this.baseUrl);
    if (notLocal) return { available: false, reason: notLocal };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
      });
      if (!res.ok) return { available: false, reason: `HTTP ${res.status} from ${this.baseUrl}` };
      const tags = TagsSchema.parse(await res.json());
      this.discovered = tags.models.map((m) => this.localCard(m.name));
      return {
        available: true,
        reason: `${tags.models.length} model(s) at ${this.baseUrl}`,
        models: this.discovered,
      };
    } catch (err) {
      return { available: false, reason: `not reachable at ${this.baseUrl} (${String(err)})` };
    }
  }

  override card(modelId: string): ModelCard {
    // Local models may be pulled after detection; accept them with default limits.
    if (!this.capabilities().some((m) => m.id === modelId))
      this.discovered.push(this.localCard(modelId));
    return super.card(modelId);
  }

  protected async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const res = await this.post(req, signal);
    let sawDone = false;
    for await (const line of readLines(res.body as ReadableStream<Uint8Array>)) {
      const chunk = this.parseChunk(line);
      if (chunk.message?.content) yield { type: 'text', delta: chunk.message.content };
      if (chunk.done) {
        sawDone = true;
        const usage = {
          inputTokens: chunk.prompt_eval_count ?? 0,
          outputTokens: chunk.eval_count ?? 0,
        };
        yield { type: 'usage', usage };
        yield { type: 'end', stopReason: stopReasonOf(chunk.done_reason) };
      }
    }
    if (!sawDone)
      throw new ProviderError('malformed', this.descriptor.id, 'Stream ended without done');
  }

  private async post(req: ChatRequest, signal: AbortSignal): Promise<Response> {
    const notLocal = localHostProblem(this.descriptor, this.baseUrl);
    if (notLocal) throw new ProviderError('unavailable', this.descriptor.id, notLocal);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          ...(req.maxOutputTokens ? { options: { num_predict: req.maxOutputTokens } } : {}),
        }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ProviderError(
        'unavailable',
        this.descriptor.id,
        `Ollama not reachable at ${this.baseUrl}`,
        {
          cause: err,
        },
      );
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        kindFromStatus(res.status),
        this.descriptor.id,
        `HTTP ${res.status}: ${text.slice(0, 200)}`,
        {
          status: res.status,
        },
      );
    }
    return res;
  }

  private parseChunk(line: string): z.infer<typeof ChunkSchema> {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (cause) {
      throw new ProviderError('malformed', this.descriptor.id, 'Invalid JSON line from Ollama', {
        cause,
      });
    }
    const parsed = ChunkSchema.safeParse(json);
    if (!parsed.success)
      throw new ProviderError('malformed', this.descriptor.id, 'Unexpected Ollama chunk');
    if (parsed.data.error)
      throw new ProviderError('unavailable', this.descriptor.id, parsed.data.error);
    return parsed.data;
  }

  private localCard(id: string): ModelCard {
    return localCard(this.descriptor, id);
  }
}

function stopReasonOf(reason: string | undefined): StopReason {
  if (reason === 'stop' || reason === undefined) return 'end';
  if (reason === 'length') return 'max_tokens';
  return 'other';
}
