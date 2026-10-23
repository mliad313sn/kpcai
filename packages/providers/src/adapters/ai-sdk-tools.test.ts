import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, StreamEvent } from '@kernelpai/core';
import { AiSdkAdapter } from './ai-sdk.js';
import type { AiSdkName } from './ai-sdk-models.js';
import { BUILTIN_DESCRIPTOR_DIR, loadDescriptors } from '../registry.js';
import { fakeServer, type FakeServer } from '../test-helpers/server.js';
import { frames, writeSse, type Wire } from '../test-helpers/ai-sdk-wire.js';
import { toolFrames } from '../test-helpers/ai-sdk-wire-tools.js';

const descriptors = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]);

const CASES: Array<{ sdk: AiSdkName; id: string; wire: Wire; prefix: string }> = [
  { sdk: 'openai', id: 'openai', wire: 'responses', prefix: '/v1' },
  { sdk: 'xai', id: 'xai', wire: 'responses', prefix: '/v1' },
  { sdk: 'google', id: 'google', wire: 'gemini', prefix: '/v1beta' },
  { sdk: 'mistral', id: 'mistral', wire: 'chat', prefix: '/v1' },
  { sdk: 'deepseek', id: 'deepseek', wire: 'chat', prefix: '' },
  { sdk: 'openrouter', id: 'openrouter', wire: 'chat', prefix: '/api/v1' },
  { sdk: 'openai-compatible', id: 'llamacpp', wire: 'chat', prefix: '/v1' },
];

const TOOLS: ChatRequest['tools'] = [
  {
    name: 'fs.read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function adapterFor(c: (typeof CASES)[number], url: string): AiSdkAdapter {
  const d = descriptors.find((x) => x.id === c.id)!;
  const env: Record<string, string> = {};
  if (d.baseUrlEnv) env[d.baseUrlEnv] = `${url}${c.prefix}`;
  if (d.auth) env[d.auth.env] = 'test-key';
  return new AiSdkAdapter(d, env, c.sdk);
}

const modelOf = (c: (typeof CASES)[number]) =>
  descriptors.find((x) => x.id === c.id)!.models[0]?.id ?? 'local-model';

async function run(a: AiSdkAdapter, req: ChatRequest): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of a.send(req)) out.push(ev);
  return out;
}

const ask = (model: string): ChatRequest => ({
  model,
  messages: [{ role: 'user', content: 'read a.txt' }],
  tools: TOOLS,
});

describe.each(CASES)('AiSdkAdapter tool calls: $sdk ($id)', (c) => {
  const model = modelOf(c);

  it('sends tools and returns a parsed tool_call with stop reason tool_use', async () => {
    const script = { id: 'call_1', name: 'fs_read', args: '{"path":"a.txt"}' };
    server = await fakeServer((_q, res) => writeSse(res, toolFrames(c.wire, script, c.sdk)));
    const events = await run(adapterFor(c, server.url), ask(model));
    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ call: { name: 'fs.read', input: { path: 'a.txt' } } });
    if (c.wire !== 'gemini') expect(call).toMatchObject({ call: { id: 'call_1' } });
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'tool_use' });
    const body = JSON.stringify(server.requests[0]?.body);
    expect(body).toContain('"fs_read"');
    expect(body).toContain('Read a file');
    expect(body).not.toContain('"fs.read"');
    expect(body).not.toMatch(/tool_choice"\s*:\s*\{/);
  });

  it('maps the tool-call and tool-result history onto the wire', async () => {
    server = await fakeServer((_q, res) => writeSse(res, frames(c.wire, { texts: ['done'] })));
    const req: ChatRequest = {
      ...ask(model),
      messages: [
        { role: 'user', content: 'read a.txt and b.txt' },
        {
          role: 'assistant',
          content: 'Reading.',
          toolCalls: [
            { id: 'call_1', name: 'fs.read', input: { path: 'a.txt' } },
            { id: 'call_2', name: 'fs.read', input: { path: 'b.txt' } },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: 'alpha-content' },
        { role: 'tool', toolCallId: 'call_2', content: 'no such file', isError: true },
      ],
    };
    const events = await run(adapterFor(c, server.url), req);
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'end' });
    const body = JSON.stringify(server.requests[0]?.body);
    for (const s of ['alpha-content', 'no such file', 'b.txt', '"fs_read"']) {
      expect(body).toContain(s);
    }
    if (c.wire !== 'gemini') expect(body).toContain('call_2');
  });

  it.runIf(c.wire !== 'gemini')('maps broken tool argument JSON to malformed', async () => {
    const script = { id: 'call_1', name: 'fs_read', args: '{"path": "a.t' };
    server = await fakeServer((_q, res) => writeSse(res, toolFrames(c.wire, script, c.sdk)));
    await expect(run(adapterFor(c, server.url), ask(model))).rejects.toMatchObject({
      kind: 'malformed',
      provider: c.id,
    });
  });

  it.runIf(c.wire !== 'gemini')('maps non-object tool input to malformed', async () => {
    const script = { id: 'call_1', name: 'fs_read', args: '["a.txt"]' };
    server = await fakeServer((_q, res) => writeSse(res, toolFrames(c.wire, script, c.sdk)));
    await expect(run(adapterFor(c, server.url), ask(model))).rejects.toMatchObject({
      kind: 'malformed',
    });
  });
});

describe('AiSdkAdapter tool history errors', () => {
  it('rejects a tool result that answers no known call as bad_request', async () => {
    const c = CASES[0]!;
    const req: ChatRequest = {
      ...ask(modelOf(c)),
      messages: [
        { role: 'user', content: 'x' },
        { role: 'tool', toolCallId: 'nope', content: 'r' },
      ],
    };
    await expect(run(adapterFor(c, 'http://127.0.0.1:9'), req)).rejects.toMatchObject({
      kind: 'bad_request',
    });
  });

  it('maps a call to an undeclared tool to malformed', async () => {
    const c = CASES[6]!;
    const script = { id: 'call_1', name: 'rm_rf', args: '{}' };
    server = await fakeServer((_q, res) => writeSse(res, toolFrames(c.wire, script)));
    await expect(run(adapterFor(c, server.url), ask(modelOf(c)))).rejects.toMatchObject({
      kind: 'malformed',
    });
  });
});
