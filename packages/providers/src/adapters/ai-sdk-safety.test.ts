import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidArgumentError,
  InvalidStreamPartError,
  JSONParseError,
  NoSuchModelError,
  TypeValidationError,
} from 'ai';
import { ProviderError, type ProviderDescriptor } from '@kernelpai/core';
import { AiSdkAdapter } from './ai-sdk.js';
import { BUILTIN_DESCRIPTOR_DIR, loadDescriptors } from '../registry.js';
import { fakeServer, type FakeServer } from '../test-helpers/server.js';

const descriptors = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]);
const byId = (id: string): ProviderDescriptor => {
  const d = descriptors.find((x) => x.id === id);
  if (!d) throw new Error(`missing descriptor ${id}`);
  return d;
};
const req = { model: 'm', messages: [{ role: 'user' as const, content: 'secret prompt' }] };

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A fetch that fails the test if anything reaches the network layer. */
function noFetch() {
  return vi.fn<typeof fetch>(() => Promise.reject(new Error('network must not be touched')));
}

async function drain(a: AiSdkAdapter): Promise<unknown> {
  try {
    for await (const ev of a.send(req)) void ev;
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('AiSdkAdapter local-first guard (F8a)', () => {
  it('refuses LLAMACPP_BASE_URL pointing at a non-loopback host, without any request', async () => {
    const f = noFetch();
    const a = new AiSdkAdapter(
      byId('llamacpp'),
      { LLAMACPP_BASE_URL: 'http://192.168.1.20:8080/v1' },
      'openai-compatible',
      f,
    );
    expect(await a.detect()).toEqual({
      available: false,
      reason: expect.stringMatching(/host is not local: http:\/\/192\.168\.1\.20:8080\/v1/),
    });
    expect(await drain(a)).toMatchObject({ kind: 'unavailable', message: /host is not local/ });
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses an override descriptor with kind local and a remote baseUrl', async () => {
    const f = noFetch();
    const d = { ...byId('llamacpp'), baseUrl: 'https://llm.example.com/v1' };
    const a = new AiSdkAdapter(d, {}, 'openai-compatible', f);
    expect(await a.detect()).toMatchObject({ available: false, reason: /host is not local/ });
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a local descriptor that would use the SDK default (public) endpoint', async () => {
    const d = { ...byId('openai'), kind: 'local' as const, baseUrl: undefined };
    const a = new AiSdkAdapter(d, { OPENAI_API_KEY: 'k' }, 'openai', noFetch());
    expect(await a.detect()).toMatchObject({ available: false, reason: /default endpoint/ });
  });

  it('accepts a localhost base URL as local', async () => {
    server = await fakeServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[{"id":"m"}]}');
    });
    const port = new URL(server.url).port;
    const a = new AiSdkAdapter(
      byId('llamacpp'),
      { LLAMACPP_BASE_URL: `http://localhost:${port}/v1` },
      'openai-compatible',
    );
    expect(await a.detect()).toMatchObject({ available: true });
  });
});

describe('AiSdkAdapter discovery credentials (F8b)', () => {
  const remote = (base: string): ProviderDescriptor => ({
    ...byId('llamacpp'),
    kind: 'aggregator',
    baseUrl: base,
    baseUrlEnv: undefined,
    auth: { env: 'REMOTE_API_KEY' },
  });

  it('never sends a key over plain http to a non-loopback host', async () => {
    const f = noFetch();
    const a = new AiSdkAdapter(
      remote('http://10.0.0.5:8080/v1'),
      { REMOTE_API_KEY: 'k' },
      'openai-compatible',
      f,
    );
    expect(await a.detect()).toMatchObject({ available: false, reason: /not https/ });
    expect(f).not.toHaveBeenCalled();
  });

  it('sends the key to an https host', async () => {
    const f = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"data":[]}', { status: 200 })),
    );
    const a = new AiSdkAdapter(
      remote('https://llm.example.com/v1'),
      { REMOTE_API_KEY: 'k' },
      'openai-compatible',
      f,
    );
    expect(await a.detect()).toMatchObject({ available: true });
    const init = f.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({ authorization: 'Bearer k' });
  });

  it('sends no Authorization header when the descriptor has no auth', async () => {
    server = await fakeServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    });
    const env = { LLAMACPP_BASE_URL: `${server.url}/v1`, OPENAI_API_KEY: 'sk-other' };
    const a = new AiSdkAdapter(byId('llamacpp'), env, 'openai-compatible');
    expect(await a.detect()).toMatchObject({ available: true });
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('reports discovery without a base URL as unavailable', async () => {
    const d = {
      ...remote('http://x'),
      kind: 'cloud' as const,
      baseUrl: undefined,
      auth: undefined,
    };
    expect(await new AiSdkAdapter(d, {}, 'openai-compatible', noFetch()).detect()).toEqual({
      available: false,
      reason: 'model discovery needs a base URL',
    });
  });
});

describe('AiSdkAdapter error classes (F13)', () => {
  const map = (err: unknown): unknown =>
    (
      new AiSdkAdapter(byId('openai'), {}, 'openai') as unknown as {
        mapError(e: unknown): unknown;
      }
    ).mapError(err);

  it.each([
    ['JSONParseError', new JSONParseError({ text: '{', cause: new Error('x') })],
    ['TypeValidationError', new TypeValidationError({ value: 1, cause: new Error('x') })],
    [
      'InvalidStreamPartError',
      new InvalidStreamPartError({ chunk: { type: 'error', error: 'x' }, message: 'bad part' }),
    ],
  ])('maps %s to malformed', (_name, err) => {
    expect(map(err)).toMatchObject({ kind: 'malformed', cause: err });
  });

  it('maps NoSuchModelError to a fallback-eligible unavailable', () => {
    const err = new NoSuchModelError({ modelId: 'gone', modelType: 'languageModel' });
    expect(map(err)).toMatchObject({ kind: 'unavailable', fallbackEligible: true, cause: err });
  });

  it.each([
    [
      'InvalidArgumentError',
      new InvalidArgumentError({ parameter: 'p', value: 1, message: 'bad' }),
    ],
    ['TypeError', new TypeError('x is not a function')],
    ['plain Error', new Error('misconfigured')],
  ])('maps %s to a non-fallback bad_request keeping the cause', (_name, err) => {
    const mapped = map(err);
    expect(mapped).toBeInstanceOf(ProviderError);
    expect(mapped).toMatchObject({ kind: 'bad_request', fallbackEligible: false, cause: err });
    expect((mapped as Error).message).toContain(err.message);
  });
});

describe('AiSdkAdapter fallback-friendly failures (review N2, N3)', () => {
  it('a connection dropped mid-stream is unavailable, so fallback continues (N2)', async () => {
    server = await fakeServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = {
        id: 'c',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm',
        choices: [{ index: 0, delta: { content: 'par' }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      setTimeout(() => res.destroy(), 10);
    });
    const a = new AiSdkAdapter(
      byId('deepseek'),
      { DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: server.url },
      'deepseek',
    );
    expect(await drain(a)).toMatchObject({ kind: 'unavailable', fallbackEligible: true });
  });

  it('a plain-http remote endpoint is unavailable in detect and send, with no request (N3)', async () => {
    const fetchSpy = noFetch();
    const env = { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://example.invalid/v1' };
    const a = new AiSdkAdapter(byId('openai'), env, 'openai', fetchSpy);
    expect(await a.detect()).toMatchObject({
      available: false,
      reason: expect.stringMatching(/not https/),
    });
    expect(await drain(a)).toMatchObject({ kind: 'unavailable', fallbackEligible: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AiSdkAdapter reasoning keeps the attempt alive (review R1)', () => {
  it('emits progress events for reasoning chunks before any text', async () => {
    server = await fakeServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm' };
      const delta = (d: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
      res.write(delta({ reasoning_content: 'thinking 1' }));
      res.write(delta({ reasoning_content: 'thinking 2' }));
      res.write(delta({ content: 'answer' }));
      res.write(delta({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
    const a = new AiSdkAdapter(
      byId('deepseek'),
      { DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: server.url },
      'deepseek',
    );
    const types: string[] = [];
    for await (const ev of a.send(req)) types.push(ev.type);
    const firstText = types.indexOf('text');
    expect(types.slice(0, firstText)).toContain('progress');
    expect(types.at(-1)).toBe('end');
  });
});
