import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderDescriptor, StreamEvent } from '@kernelpai/core';
import { OllamaAdapter } from './ollama.js';
import { BUILTIN_DESCRIPTOR_DIR, loadDescriptors } from '../registry.js';
import { deadUrl, fakeServer, type FakeServer } from '../test-helpers/server.js';

const descriptor = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]).find(
  (d) => d.id === 'ollama',
) as ProviderDescriptor;
const req = {
  model: 'llama3.2:3b',
  maxOutputTokens: 64,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function ndjson(lines: unknown[], hold = false) {
  return (_q: unknown, res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const l of lines) res.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
    if (!hold) res.end();
  };
}

const at = (url: string) => new OllamaAdapter(descriptor, { OLLAMA_HOST: url });

async function collect(a: OllamaAdapter, requestId?: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of a.send(req, { requestId })) out.push(ev);
  return out;
}

describe('OllamaAdapter', () => {
  it('discovers local models as free, local capability cards', async () => {
    server = await fakeServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b', size: 1 }, { name: 'qwen3:8b' }] }));
    });
    const a = at(server.url);
    const det = await a.detect();
    expect(det).toMatchObject({ available: true });
    expect(a.capabilities().map((m) => m.id)).toEqual(['llama3.2:3b', 'qwen3:8b']);
    expect(a.estimate(req).maxCostUsd).toBe(0);
  });

  it('reports detection failures without throwing', async () => {
    expect(await at(await deadUrl()).detect()).toMatchObject({ available: false });
    server = await fakeServer((_q, res) => {
      res.writeHead(500);
      res.end();
    });
    expect(await at(server.url).detect()).toMatchObject({
      available: false,
      reason: expect.stringMatching(/HTTP 500/),
    });
  });

  it('streams NDJSON chunks with usage and stop reason', async () => {
    server = await fakeServer(
      ndjson([
        { message: { role: 'assistant', content: 'Hel' }, done: false },
        { message: { role: 'assistant', content: 'lo' }, done: false },
        {
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'length',
          prompt_eval_count: 7,
          eval_count: 2,
        },
      ]),
    );
    const events = await collect(at(server.url));
    expect(events.filter((e) => e.type === 'text')).toHaveLength(2);
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 7, outputTokens: 2 } });
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'max_tokens' });
    expect(server.requests[0]).toMatchObject({
      path: '/api/chat',
      body: { model: 'llama3.2:3b', stream: true, options: { num_predict: 64 } },
    });
  });

  it.each([
    ['not json', 'malformed'],
    [{ unexpected: true }, 'malformed'],
    [{ error: 'model not found', done: false }, 'unavailable'],
  ])('maps a bad chunk %j to kind %s', async (line, kind) => {
    server = await fakeServer(ndjson([line]));
    await expect(collect(at(server.url))).rejects.toMatchObject({ kind });
  });

  it('treats a stream that never says done as malformed', async () => {
    server = await fakeServer(ndjson([{ message: { content: 'x' }, done: false }]));
    await expect(collect(at(server.url))).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('maps HTTP errors and connection failures', async () => {
    server = await fakeServer((_q, res) => {
      res.writeHead(404);
      res.end('{"error":"model \\"x\\" not found"}');
    });
    await expect(collect(at(server.url))).rejects.toMatchObject({
      kind: 'unavailable',
      status: 404,
    });
    await expect(collect(at(await deadUrl()))).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('cancels a hanging stream', async () => {
    server = await fakeServer(ndjson([{ message: { content: 'part' }, done: false }], true));
    const a = at(server.url);
    const run = (async () => {
      for await (const ev of a.send(req, { requestId: 'r' })) if (ev.type === 'text') a.cancel('r');
    })();
    await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('accepts host:port without scheme in OLLAMA_HOST', () => {
    expect(() => at('127.0.0.1:11434')).not.toThrow();
  });
});
