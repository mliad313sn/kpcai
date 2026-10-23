import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ProviderDescriptor, StreamEvent } from '@kernelpai/core';
import { AnthropicAdapter } from './anthropic.js';
import { loadDescriptors, BUILTIN_DESCRIPTOR_DIR } from '../registry.js';
import { fakeServer, sse, type FakeServer } from '../test-helpers/server.js';

const descriptor = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]).find(
  (d) => d.id === 'anthropic',
) as ProviderDescriptor;
const MODEL = descriptor.models[0]!.id;

const TOOLS: ChatRequest['tools'] = [
  {
    name: 'fs.read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  { name: 'fs_read', description: 'Clashing wire name', inputSchema: {} },
];

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
    usage: { input_tokens: 20, output_tokens: 1 },
  },
};

/** A text block then a streamed tool_use block with the given raw JSON chunks. */
function toolTurn(name: string, chunks: string[], stop = 'tool_use') {
  return [
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading.' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} },
    },
    ...chunks.map((partial_json) => ({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json },
    })),
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 9 },
    },
    { type: 'message_stop' },
  ];
}

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const adapter = (url: string) =>
  new AnthropicAdapter(descriptor, { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: url });

async function run(req: ChatRequest): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of adapter(server!.url).send(req)) out.push(ev);
  return out;
}

const ask: ChatRequest = {
  model: MODEL,
  messages: [{ role: 'user', content: 'read a.txt' }],
  tools: TOOLS,
};

describe('AnthropicAdapter tool use', () => {
  it('sends tools, emits a parsed tool_call and stop reason tool_use', async () => {
    server = await fakeServer((_q, res) =>
      sse(res, toolTurn('fs_read_2', ['{"pa', 'th": "a.txt"}'])),
    );
    const events = await run(ask);
    expect(events).toContainEqual({ type: 'text', delta: 'Reading.' });
    expect(events).toContainEqual({
      type: 'tool_call',
      call: { id: 'toolu_1', name: 'fs.read', input: { path: 'a.txt' } },
    });
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'tool_use' });
    const body = server.requests[0]!.body as Record<string, unknown>;
    expect(body['tools']).toEqual([
      { name: 'fs_read_2', description: 'Read a file', input_schema: TOOLS[0]!.inputSchema },
      { name: 'fs_read', description: 'Clashing wire name', input_schema: { type: 'object' } },
    ]);
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('temperature');
  });

  it('treats an empty input stream as {}', async () => {
    server = await fakeServer((_q, res) => sse(res, toolTurn('fs_read', [])));
    const events = await run(ask);
    expect(events).toContainEqual({
      type: 'tool_call',
      call: { id: 'toolu_1', name: 'fs_read', input: {} },
    });
  });

  it.each([['{"path": "a.t'], ['["a.txt"]'], ['42']])(
    'maps tool input %s to malformed',
    async (json) => {
      server = await fakeServer((_q, res) => sse(res, toolTurn('fs_read_2', [json])));
      await expect(run(ask)).rejects.toMatchObject({ kind: 'malformed', provider: 'anthropic' });
    },
  );

  it('maps tool_use history and tool_result blocks with is_error', async () => {
    server = await fakeServer((_q, res) => sse(res, toolTurn('fs_read', ['{}'], 'end_turn')));
    await run({
      ...ask,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'read two files' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'toolu_a', name: 'fs.read', input: { path: 'a' } },
            { id: 'toolu_b', name: 'fs.read', input: 'not-an-object' },
          ],
        },
        { role: 'tool', toolCallId: 'toolu_a', content: 'A' },
        { role: 'tool', toolCallId: 'toolu_b', content: 'denied', isError: true },
        { role: 'user', content: 'go on' },
        { role: 'assistant', content: 'ok' },
      ],
    });
    const body = server.requests[0]!.body as { messages: unknown[]; system: string };
    expect(body.system).toBe('sys');
    expect(body.messages).toEqual([
      { role: 'user', content: 'read two files' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'fs_read_2', input: { path: 'a' } },
          { type: 'tool_use', id: 'toolu_b', name: 'fs_read_2', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_a', content: 'A' },
          { type: 'tool_result', tool_use_id: 'toolu_b', content: 'denied', is_error: true },
          { type: 'text', text: 'go on' },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('keeps assistant text next to its tool_use blocks', async () => {
    server = await fakeServer((_q, res) => sse(res, toolTurn('fs_read', ['{}'], 'end_turn')));
    await run({
      model: MODEL,
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: 'Let me look.',
          toolCalls: [{ id: 't1', name: 'git.status', input: {} }],
        },
        { role: 'tool', toolCallId: 't1', content: 'clean' },
      ],
    });
    const body = server.requests[0]!.body as { messages: Array<{ content: unknown }> };
    expect(body.messages[1]!.content).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 't1', name: 'git_status', input: {} },
    ]);
  });

  it('maps a stream that ends without a stop reason to malformed', async () => {
    server = await fakeServer((_q, res) => sse(res, toolTurn('fs_read', ['{}']).slice(0, 5)));
    await expect(run(ask)).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('refuses a tool message without a matching call as bad_request', async () => {
    server = await fakeServer((_q, res) => sse(res, toolTurn('fs_read', ['{}'])));
    await expect(
      run({ model: MODEL, messages: [{ role: 'tool', content: 'r' }] }),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    expect(server.requests).toHaveLength(0);
  });
});
