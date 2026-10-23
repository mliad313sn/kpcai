import { describe, expect, it } from 'vitest';
import { BaseAdapter, type DetectResult } from './adapter.js';
import { ProviderError } from './errors.js';
import { ProviderDescriptorSchema, type ChatRequest, type StreamEvent } from './schemas.js';

const descriptor = ProviderDescriptorSchema.parse({
  id: 'fake',
  name: 'Fake',
  kind: 'test',
  adapter: 'fake',
  jurisdiction: 'local',
  retention: 'none',
  models: [
    {
      id: 'm1',
      contextWindow: 1000,
      maxOutput: 100,
      modalities: ['text'],
      price: { inputPerMTok: 1, outputPerMTok: 1 },
    },
  ],
});

class SlowAdapter extends BaseAdapter {
  detect(): Promise<DetectResult> {
    return Promise.resolve({ available: true, reason: 'test' });
  }
  protected async *stream(_req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    yield { type: 'text', delta: 'a' };
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 5_000);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
    yield { type: 'end', stopReason: 'end' };
  }
}

const req: ChatRequest = { model: 'm1', messages: [{ role: 'user', content: 'hi' }] };

async function drain(it: AsyncIterable<StreamEvent>, onFirst?: () => void): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) {
    out.push(ev);
    if (ev.type === 'text') onFirst?.();
  }
  return out;
}

describe('BaseAdapter', () => {
  it('rejects invalid requests before any network work', async () => {
    const a = new SlowAdapter(descriptor);
    await expect(drain(a.send({ model: '', messages: [] }))).rejects.toThrow();
  });

  it('cancels an in-flight request by id and reports kind=cancelled', async () => {
    const a = new SlowAdapter(descriptor);
    const run = drain(a.send(req, { requestId: 'r1' }), () => a.cancel('r1'));
    await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
    expect(a.cancel('r1')).toBe(false);
  });

  it('honours an outer AbortSignal, including one already aborted', async () => {
    const a = new SlowAdapter(descriptor);
    const ctl = new AbortController();
    ctl.abort();
    await expect(drain(a.send(req, { signal: ctl.signal }))).rejects.toBeInstanceOf(ProviderError);
  });

  it('looks up model cards and estimates cost', () => {
    const a = new SlowAdapter(descriptor);
    expect(a.card('m1').id).toBe('m1');
    expect(() => a.card('nope')).toThrow(/Unknown model/);
    expect(a.estimate(req).maxOutputTokens).toBe(100);
  });
});
