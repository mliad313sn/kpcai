import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderDescriptor, StreamEvent } from '@kernelpai/core';
import { AiSdkAdapter } from './ai-sdk.js';
import type { AiSdkName } from './ai-sdk-models.js';
import { BUILTIN_DESCRIPTOR_DIR, loadDescriptors } from '../registry.js';
import { deadUrl, fakeServer, type FakeServer } from '../test-helpers/server.js';
import {
  errorBody,
  frames,
  writeSse,
  type Script,
  type Wire,
} from '../test-helpers/ai-sdk-wire.js';

const descriptors = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]);
const byId = (id: string): ProviderDescriptor => {
  const d = descriptors.find((x) => x.id === id);
  if (!d) throw new Error(`missing descriptor ${id}`);
  return d;
};

interface Case {
  sdk: AiSdkName;
  id: string;
  wire: Wire;
  /** Path prefix the descriptor's real base URL carries. */
  prefix: string;
  path: (model: string) => string;
  refusal?: string;
  length: string;
}

const chatPath = (prefix: string) => () => `${prefix}/chat/completions`;
const CASES: Case[] = [
  {
    sdk: 'openai',
    id: 'openai',
    wire: 'responses',
    prefix: '/v1',
    path: () => '/v1/responses',
    refusal: 'content_filter',
    length: 'max_output_tokens',
  },
  {
    sdk: 'xai',
    id: 'xai',
    wire: 'responses',
    prefix: '/v1',
    path: () => '/v1/responses',
    length: 'max_output_tokens',
  },
  {
    sdk: 'google',
    id: 'google',
    wire: 'gemini',
    prefix: '/v1beta',
    path: (m) => `/v1beta/models/${m}:streamGenerateContent?alt=sse`,
    refusal: 'SAFETY',
    length: 'MAX_TOKENS',
  },
  {
    sdk: 'mistral',
    id: 'mistral',
    wire: 'chat',
    prefix: '/v1',
    path: chatPath('/v1'),
    length: 'length',
  },
  {
    sdk: 'deepseek',
    id: 'deepseek',
    wire: 'chat',
    prefix: '',
    path: chatPath(''),
    refusal: 'content_filter',
    length: 'length',
  },
  {
    sdk: 'openrouter',
    id: 'openrouter',
    wire: 'chat',
    prefix: '/api/v1',
    path: chatPath('/api/v1'),
    refusal: 'content_filter',
    length: 'length',
  },
  {
    sdk: 'openai-compatible',
    id: 'llamacpp',
    wire: 'chat',
    prefix: '/v1',
    path: chatPath('/v1'),
    refusal: 'content_filter',
    length: 'length',
  },
];

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function adapterFor(c: Case, url: string, withKey = true): AiSdkAdapter {
  const d = byId(c.id);
  const env: Record<string, string> = {};
  if (d.baseUrlEnv) env[d.baseUrlEnv] = `${url}${c.prefix}`;
  if (d.auth && withKey) env[d.auth.env] = 'test-key';
  return new AiSdkAdapter(d, env, c.sdk);
}

function modelOf(c: Case): string {
  return byId(c.id).models[0]?.id ?? 'local-model';
}

async function collect(a: AiSdkAdapter, model: string, requestId?: string) {
  const out: StreamEvent[] = [];
  const req = {
    model,
    maxOutputTokens: 64,
    messages: [
      { role: 'system' as const, content: 'be brief' },
      { role: 'user' as const, content: 'hi' },
    ],
  };
  for await (const ev of a.send(req, { requestId })) out.push(ev);
  return out;
}

async function scripted(c: Case, s: Script): Promise<FakeServer> {
  return fakeServer((_q, res) => writeSse(res, frames(c.wire, s), s.hold));
}

describe.each(CASES)('AiSdkAdapter contract: $sdk ($id)', (c) => {
  const model = modelOf(c);

  it('streams text, usage and stop reason from the fake wire', async () => {
    server = await scripted(c, { texts: ['Hel', 'lo'], usage: { input: 11, output: 3 } });
    const events = await collect(adapterFor(c, server.url), model);
    expect(events[0]).toMatchObject({ type: 'start', model });
    const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
    expect(text).toBe('Hello');
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 11, outputTokens: 3 } });
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'end' });
    const sent = server.requests[0];
    expect(sent?.path).toBe(c.path(model));
    if (byId(c.id).auth) expect(JSON.stringify(sent?.headers)).toContain('test-key');
    expect(JSON.stringify(sent?.body)).toContain('be brief');
  });

  it('maps a length finish to max_tokens', async () => {
    server = await scripted(c, { texts: ['cut'], finish: c.length });
    const events = await collect(adapterFor(c, server.url), model);
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'max_tokens' });
  });

  it.runIf(c.refusal)('maps a content filter finish to a refusal error', async () => {
    server = await scripted(c, { texts: [], finish: c.refusal });
    await expect(collect(adapterFor(c, server.url), model)).rejects.toMatchObject({
      kind: 'refusal',
      fallbackEligible: true,
    });
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [400, 'bad_request'],
  ])('maps HTTP %i to %s without retrying', async (status, kind) => {
    server = await fakeServer((_q, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(errorBody(c.wire, status));
    });
    await expect(collect(adapterFor(c, server.url), model)).rejects.toMatchObject({
      kind,
      status,
      provider: c.id,
    });
    expect(server.requests).toHaveLength(1);
  });

  it('maps an unreachable server to unavailable', async () => {
    const url = await deadUrl();
    await expect(collect(adapterFor(c, url), model)).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('maps a garbled stream to malformed', async () => {
    server = await fakeServer((_q, res) => writeSse(res, ['data: {not json']));
    await expect(collect(adapterFor(c, server.url), model)).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('cancels a hanging stream by request id', async () => {
    server = await scripted(c, { texts: ['part'], hold: true });
    const a = adapterFor(c, server.url);
    const seen: string[] = [];
    const run = (async () => {
      const req = { model, messages: [{ role: 'user' as const, content: 'hi' }] };
      for await (const ev of a.send(req, { requestId: 'r1' })) {
        if (ev.type !== 'progress') seen.push(ev.type);
        if (ev.type === 'text') a.cancel('r1');
      }
    })();
    await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
    expect(seen).toEqual(['start', 'text']);
  });
});

describe('AiSdkAdapter credentials and detection', () => {
  const openai = CASES[0] as Case;

  it('fails with auth before any request when the key is missing', async () => {
    server = await scripted(openai, { texts: ['x'] });
    const a = adapterFor(openai, server.url, false);
    await expect(collect(a, 'gpt-6-luna')).rejects.toMatchObject({ kind: 'auth' });
    expect(server.requests).toHaveLength(0);
    expect(await a.detect()).toEqual({ available: false, reason: 'OPENAI_API_KEY is not set' });
  });

  it('detects cloud providers from the key alone, without network', async () => {
    const a = adapterFor(openai, await deadUrl());
    expect(await a.detect()).toEqual({ available: true, reason: 'OPENAI_API_KEY is set' });
  });

  it('rejects models absent from a cloud descriptor', () => {
    const a = adapterFor(openai, 'http://127.0.0.1:1');
    expect(() => a.estimate({ model: 'nope', messages: [{ role: 'user', content: 'x' }] })).toThrow(
      /Unknown model/,
    );
  });

  it('needs no credentials for a keyless provider without discovery', async () => {
    const d = { ...byId('llamacpp'), discoverModels: false };
    expect(await new AiSdkAdapter(d, {}, 'openai-compatible').detect()).toEqual({
      available: true,
      reason: 'no credentials needed',
    });
  });

  it('refuses an openai-compatible descriptor without a base URL', async () => {
    // kind cloud: a local descriptor without a base URL is refused as not local first.
    const d = {
      ...byId('llamacpp'),
      kind: 'cloud' as const,
      baseUrl: undefined,
      baseUrlEnv: undefined,
    };
    const a = new AiSdkAdapter(d, {}, 'openai-compatible');
    const req = { model: 'x', messages: [{ role: 'user' as const, content: 'hi' }] };
    await expect(collect(a, req.model)).rejects.toThrow(/needs a base URL/);
  });
});

describe('AiSdkAdapter mid-stream failures', () => {
  const chat = CASES.find((c) => c.sdk === 'openai-compatible') as Case;
  const router = CASES.find((c) => c.sdk === 'openrouter') as Case;

  it.each([chat, router])(
    'maps an error event after text to a fallback-eligible kind ($sdk)',
    async (c) => {
      server = await fakeServer((_q, res) => {
        const [first] = frames('chat', { texts: ['partial'], hold: true });
        writeSse(res, [
          first as string,
          'data: {"error":{"message":"upstream overloaded","code":502}}',
        ]);
      });
      const seen: StreamEvent[] = [];
      const a = adapterFor(c, server.url);
      const run = (async () => {
        const req = { model: modelOf(c), messages: [{ role: 'user' as const, content: 'hi' }] };
        for await (const ev of a.send(req)) seen.push(ev);
      })();
      const err = await run.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ kind: 'unavailable', fallbackEligible: true });
      expect(String((err as Error).message)).toContain('upstream overloaded');
      expect(seen).toContainEqual({ type: 'text', delta: 'partial' });
    },
  );

  it('cancels through the caller signal as well', async () => {
    server = await scripted(chat, { texts: ['part'], hold: true });
    const a = adapterFor(chat, server.url);
    const ctl = new AbortController();
    const run = (async () => {
      const req = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };
      for await (const ev of a.send(req, { signal: ctl.signal }))
        if (ev.type === 'text') ctl.abort();
    })();
    await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
  });
});

describe('AiSdkAdapter local discovery (llama.cpp)', () => {
  const llama = CASES.find((c) => c.id === 'llamacpp') as Case;

  it('discovers models from GET /v1/models as free local cards with priors', async () => {
    server = await fakeServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ object: 'list', data: [{ id: 'qwen3-8b-q4.gguf', object: 'model' }] }),
      );
    });
    const a = adapterFor(llama, server.url);
    const det = await a.detect();
    expect(det).toMatchObject({ available: true, reason: expect.stringMatching(/1 model/) });
    expect(server.requests[0]?.path).toBe('/v1/models');
    const [card] = a.capabilities();
    expect(card).toMatchObject({ id: 'qwen3-8b-q4.gguf', price: { inputPerMTok: 0 } });
    expect(card?.competence?.analysis).toBeLessThanOrEqual(0.5);
    expect(
      a.estimate({ model: 'loaded-later', messages: [{ role: 'user', content: 'x' }] }).maxCostUsd,
    ).toBe(0);
  });

  it('reports an unreachable or failing local server without throwing', async () => {
    expect(await adapterFor(llama, await deadUrl()).detect()).toMatchObject({ available: false });
    server = await fakeServer((_q, res) => {
      res.writeHead(503);
      res.end();
    });
    expect(await adapterFor(llama, server.url).detect()).toMatchObject({
      available: false,
      reason: expect.stringMatching(/HTTP 503/),
    });
  });

  it('sends a bearer token on discovery when the descriptor names one', async () => {
    server = await fakeServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    });
    const d = { ...byId('llamacpp'), auth: { env: 'LOCAL_KEY' } };
    const a = new AiSdkAdapter(
      d,
      { LLAMACPP_BASE_URL: `${server.url}/v1`, LOCAL_KEY: 'k1' },
      'openai-compatible',
    );
    expect(await a.detect()).toMatchObject({ available: true });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer k1');
  });
});

describe('AiSdkAdapter error mapping edge cases', () => {
  const map = (err: unknown): unknown =>
    (
      new AiSdkAdapter(byId('openai'), {}, 'openai') as unknown as {
        mapError(e: unknown): unknown;
      }
    ).mapError(err);

  it('treats opaque error payloads as an unavailable provider', () => {
    expect(map({ code: 'overloaded' })).toMatchObject({
      kind: 'unavailable',
      message: 'Provider error: {"code":"overloaded"}',
    });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(map(cyclic)).toMatchObject({
      kind: 'unavailable',
      message: expect.stringMatching(/object/),
    });
  });

  it('passes abort errors through for BaseAdapter to report as cancelled', () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    expect(map(abort)).toBe(abort);
  });
});
