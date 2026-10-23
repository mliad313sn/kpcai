import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { ChatRequest, ProviderDescriptor, StreamEvent } from '@kernelpai/core';
import { OllamaAdapter } from './ollama.js';
import { BUILTIN_DESCRIPTOR_DIR, loadDescriptors } from '../registry.js';
import { fakeServer, type FakeServer } from '../test-helpers/server.js';

const descriptor = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]).find(
  (d) => d.id === 'ollama',
) as ProviderDescriptor;

const TOOLS: ChatRequest['tools'] = [
  {
    name: 'fs.read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];
const ask: ChatRequest = {
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'read a.txt' }],
  tools: TOOLS,
};

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const ndjson = (lines: unknown[]) => (_q: unknown, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const l of lines) res.write(`${JSON.stringify(l)}\n`);
  res.end();
};

const toolChunk = (args: unknown, id?: string) => ({
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ ...(id ? { id } : {}), function: { name: 'fs_read', arguments: args } }],
  },
  done: false,
});
const done = { message: { content: '' }, done: true, done_reason: 'stop', eval_count: 3 };

async function run(req: ChatRequest): Promise<StreamEvent[]> {
  const a = new OllamaAdapter(descriptor, { OLLAMA_HOST: server!.url });
  const out: StreamEvent[] = [];
  for await (const ev of a.send(req)) out.push(ev);
  return out;
}

describe('OllamaAdapter tool calls', () => {
  it('sends tools on /api/chat and emits tool calls with stop reason tool_use', async () => {
    server = await fakeServer(
      ndjson([toolChunk({ path: 'a.txt' }), toolChunk('{"path":"b.txt"}', 'call_x'), done]),
    );
    const events = await run(ask);
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([
      {
        type: 'tool_call',
        call: { id: 'ollama_call_1', name: 'fs.read', input: { path: 'a.txt' } },
      },
      { type: 'tool_call', call: { id: 'call_x', name: 'fs.read', input: { path: 'b.txt' } } },
    ]);
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'tool_use' });
    expect(server.requests[0]!.body).toMatchObject({
      tools: [
        {
          type: 'function',
          function: {
            name: 'fs_read',
            description: 'Read a file',
            parameters: TOOLS[0]!.inputSchema,
          },
        },
      ],
    });
  });

  it.each([['{"path":'], [['a.txt']], [null]])(
    'maps tool arguments %j to malformed',
    async (args) => {
      server = await fakeServer(ndjson([toolChunk(args), done]));
      await expect(run(ask)).rejects.toMatchObject({ kind: 'malformed', provider: 'ollama' });
    },
  );

  it('maps tool history onto Ollama messages and sends only known fields', async () => {
    server = await fakeServer(ndjson([{ message: { content: 'ok' }, done: false }, done]));
    const events = await run({
      ...ask,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'read' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'fs.read', input: { path: 'a' } }],
        },
        { role: 'tool', toolCallId: 'c1', content: 'nope', isError: true },
      ],
    });
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'end' });
    expect((server.requests[0]!.body as { messages: unknown }).messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'fs_read', arguments: { path: 'a' } } }],
      },
      { role: 'tool', content: 'Error: nope', tool_name: 'fs_read' },
    ]);
  });

  it('surfaces a model without tool support as bad_request with a clear message', async () => {
    server = await fakeServer((_q, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}');
    });
    await expect(run({ ...ask, model: 'gemma:2b' })).rejects.toMatchObject({
      kind: 'bad_request',
      status: 400,
      message: expect.stringMatching(/gemma:2b does not support tool calling/),
    });
  });

  it('says in detect() how tools are handled', async () => {
    server = await fakeServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
    });
    const det = await new OllamaAdapter(descriptor, { OLLAMA_HOST: server.url }).detect();
    expect(det.reason).toMatch(/tools via \/api\/chat/);
  });
});
