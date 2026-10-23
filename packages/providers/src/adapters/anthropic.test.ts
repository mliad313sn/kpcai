import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderDescriptor, StreamEvent } from '@kernelpai/core';
import { AnthropicAdapter } from './anthropic.js';
import { loadDescriptors, BUILTIN_DESCRIPTOR_DIR } from '../registry.js';
import { deadUrl, fakeServer, sse, type FakeServer } from '../test-helpers/server.js';

const descriptor = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]).find(
  (d) => d.id === 'anthropic',
) as ProviderDescriptor;
const MODEL = descriptor.models[0]!.id;
const req = {
  model: MODEL,
  messages: [
    { role: 'system' as const, content: 'Be brief.' },
    { role: 'user' as const, content: 'Say hello' },
  ],
};

const start = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 },
  },
};
const block = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const delta = (text: string) => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text },
});
const finish = (stop: string) => [
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: 'message_stop' },
];

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function adapter(baseUrl: string, key: string | null = 'test-key'): AnthropicAdapter {
  return new AnthropicAdapter(descriptor, {
    ANTHROPIC_API_KEY: key ?? undefined,
    ANTHROPIC_BASE_URL: baseUrl,
  });
}

async function collect(a: AnthropicAdapter, requestId?: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of a.send(req, { requestId })) out.push(ev);
  return out;
}

describe('AnthropicAdapter', () => {
  it('streams text, usage and a normalised stop reason', async () => {
    server = await fakeServer((_q, res) =>
      sse(res, [start, block, delta('Hel'), delta('lo'), ...finish('end_turn')]),
    );
    const events = await collect(adapter(server.url));
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { delta: string }).delta)
        .join(''),
    ).toBe('Hello');
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 5 } });
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'end' });
    const sent = server.requests[0]!;
    expect(sent.path).toBe('/v1/messages');
    expect(sent.headers['authorization']).toBe('Bearer test-key');
    expect(sent.body).toMatchObject({
      model: MODEL,
      system: 'Be brief.',
      stream: true,
      messages: [{ role: 'user', content: 'Say hello' }],
    });
    expect(sent.body).not.toHaveProperty('temperature');
  });

  it('maps max_tokens and refusal stop reasons', async () => {
    server = await fakeServer((_q, res) =>
      sse(res, [start, block, delta('x'), ...finish('max_tokens')]),
    );
    expect((await collect(adapter(server.url))).at(-1)).toEqual({
      type: 'end',
      stopReason: 'max_tokens',
    });
    await server.close();
    server = await fakeServer((_q, res) => sse(res, [start, block, ...finish('refusal')]));
    await expect(collect(adapter(server.url))).rejects.toMatchObject({
      kind: 'refusal',
      fallbackEligible: true,
    });
  });

  it.each([
    [401, 'authentication_error', 'auth'],
    [429, 'rate_limit_error', 'rate_limit'],
    [529, 'overloaded_error', 'unavailable'],
    [400, 'invalid_request_error', 'bad_request'],
  ])('maps HTTP %i to kind %s→%s without SDK retries', async (status, type, kind) => {
    server = await fakeServer((_q, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type, message: 'nope' } }));
    });
    await expect(collect(adapter(server.url))).rejects.toMatchObject({ kind, status });
    expect(server.requests).toHaveLength(1);
  });

  it('reports an unreachable endpoint as unavailable (fallback-eligible)', async () => {
    await expect(collect(adapter(await deadUrl()))).rejects.toMatchObject({
      kind: 'unavailable',
      fallbackEligible: true,
    });
  });

  it('fails fast with kind=auth when no key is configured', async () => {
    const a = adapter('http://127.0.0.1:9', null);
    expect(await a.detect()).toMatchObject({ available: false });
    await expect(collect(a)).rejects.toMatchObject({ kind: 'auth' });
    expect(await adapter('http://x').detect()).toMatchObject({ available: true });
  });

  it('cancels mid-stream and keeps the text already received', async () => {
    server = await fakeServer((_q, res) => sse(res, [start, block, delta('partial')], true));
    const a = adapter(server.url);
    const seen: string[] = [];
    const run = (async () => {
      for await (const ev of a.send(req, { requestId: 'r1' })) {
        if (ev.type === 'text') {
          seen.push(ev.delta);
          a.cancel('r1');
        }
      }
    })();
    await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
    expect(seen).toEqual(['partial']);
  });

  it('refuses a kind: local override that points at a remote host', async () => {
    const d = { ...descriptor, kind: 'local' as const };
    const env = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://api.example.com' };
    const a = new AnthropicAdapter(d, env);
    expect(await a.detect()).toMatchObject({ available: false, reason: /host is not local/ });
    await expect(collect(a)).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
