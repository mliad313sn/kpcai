import type { Wire } from './ai-sdk-wire.js';

/**
 * Wire fixtures for one streamed tool call per protocol: Chat Completions
 * `delta.tool_calls`, Responses `function_call` output items, Gemini `functionCall`.
 * `args` is the raw argument JSON text (may be deliberately broken).
 */
export interface ToolScript {
  id: string;
  /** Wire name (already dot-free). */
  name: string;
  args: string;
}

const data = (o: unknown): string => `data: ${JSON.stringify(o)}`;
const usage = { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 };

function chatToolFrames(t: ToolScript): string[] {
  const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm' };
  const call = { index: 0, id: t.id, type: 'function', function: { name: t.name, arguments: '' } };
  const more = (args: string) => ({ index: 0, function: { arguments: args } });
  const half = Math.floor(t.args.length / 2);
  const chunk = (delta: unknown, finish: string | null = null, extra = {}) =>
    data({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  return [
    chunk({ role: 'assistant', tool_calls: [call] }),
    chunk({ tool_calls: [more(t.args.slice(0, half))] }),
    chunk({ tool_calls: [more(t.args.slice(half))] }),
    chunk({}, 'tool_calls', { usage }),
    'data: [DONE]',
  ];
}

/** Mistral sends each tool call whole, in one chunk. */
export function mistralToolFrames(t: ToolScript): string[] {
  const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm' };
  const call = { id: t.id, type: 'function', function: { name: t.name, arguments: t.args } };
  return [
    data({
      ...base,
      choices: [
        { index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null },
      ],
    }),
    data({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }),
    'data: [DONE]',
  ];
}

function geminiToolFrames(t: ToolScript): string[] {
  const args: unknown = JSON.parse(t.args);
  return [
    data({
      candidates: [
        {
          content: { role: 'model', parts: [{ functionCall: { name: t.name, args } }] },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
    }),
  ];
}

function responsesToolFrames(t: ToolScript): string[] {
  const resp = { id: 'resp_1', object: 'response', created_at: 1, model: 'm', output: [] };
  const ev = (type: string, o: Record<string, unknown>): string =>
    `event: ${type}\n${data({ type, ...o })}`;
  const item = { type: 'function_call', id: 'fc_1', call_id: t.id, name: t.name };
  return [
    ev('response.created', { response: { ...resp, status: 'in_progress' } }),
    ev('response.output_item.added', {
      output_index: 0,
      item: { ...item, arguments: '', status: 'in_progress' },
    }),
    ev('response.function_call_arguments.delta', {
      item_id: 'fc_1',
      output_index: 0,
      delta: t.args,
    }),
    ev('response.output_item.done', {
      output_index: 0,
      item: { ...item, arguments: t.args, status: 'completed' },
    }),
    ev('response.completed', {
      response: {
        ...resp,
        status: 'completed',
        incomplete_details: null,
        usage: {
          input_tokens: 9,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 4,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 13,
        },
      },
    }),
  ];
}

export function toolFrames(wire: Wire, t: ToolScript, sdk = ''): string[] {
  if (sdk === 'mistral') return mistralToolFrames(t);
  if (wire === 'chat') return chatToolFrames(t);
  if (wire === 'gemini') return geminiToolFrames(t);
  return responsesToolFrames(t);
}
