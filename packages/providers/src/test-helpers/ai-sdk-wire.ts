import type { ServerResponse } from 'node:http';

/**
 * Minimal wire fixtures for the three protocols the AI SDK packages speak:
 * Chat Completions SSE (Mistral, DeepSeek, OpenRouter, llama.cpp), OpenAI/xAI
 * Responses SSE, and Gemini `streamGenerateContent?alt=sse`.
 */
export type Wire = 'chat' | 'responses' | 'gemini';

export interface Script {
  texts: string[];
  /** Protocol-native finish reason; defaults to the protocol's "stop". */
  finish?: string;
  usage?: { input: number; output: number };
  /** Keep the connection open after the text chunks (cancellation tests). */
  hold?: boolean;
}

export function writeSse(res: ServerResponse, frames: readonly string[], hold = false): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write(`${f}\n\n`);
  if (!hold) res.end();
}

const data = (o: unknown): string => `data: ${JSON.stringify(o)}`;

function chatFrames(s: Script): string[] {
  const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm' };
  const frames = s.texts.map((t) =>
    data({ ...base, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }),
  );
  if (s.hold) return frames;
  const u = s.usage ?? { input: 7, output: 2 };
  frames.push(
    // Usage rides on the finish chunk, as Mistral and llama.cpp send it.
    data({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: s.finish ?? 'stop' }],
      usage: {
        prompt_tokens: u.input,
        completion_tokens: u.output,
        total_tokens: u.input + u.output,
      },
    }),
    'data: [DONE]',
  );
  return frames;
}

function geminiFrames(s: Script): string[] {
  const frames = s.texts.map((t) =>
    data({ candidates: [{ content: { role: 'model', parts: [{ text: t }] }, index: 0 }] }),
  );
  if (s.hold) return frames;
  const u = s.usage ?? { input: 7, output: 2 };
  frames.push(
    data({
      candidates: [
        { content: { role: 'model', parts: [{ text: '' }] }, finishReason: s.finish ?? 'STOP' },
      ],
      usageMetadata: {
        promptTokenCount: u.input,
        candidatesTokenCount: u.output,
        totalTokenCount: u.input + u.output,
      },
    }),
  );
  return frames;
}

function responsesFrames(s: Script): string[] {
  const resp = {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    model: 'm',
    status: 'completed',
    output: [],
  };
  const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress' };
  const ev = (type: string, o: Record<string, unknown>): string =>
    `event: ${type}\n${data({ type, ...o })}`;
  const frames = [
    ev('response.created', { response: { ...resp, status: 'in_progress' } }),
    ev('response.output_item.added', { output_index: 0, item: { ...item, content: [] } }),
    ...s.texts.map((t) =>
      ev('response.output_text.delta', {
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: t,
        logprobs: [],
      }),
    ),
  ];
  if (s.hold) return frames;
  const u = s.usage ?? { input: 7, output: 2 };
  const incomplete = s.finish ? { reason: s.finish } : null;
  frames.push(
    ev(incomplete ? 'response.incomplete' : 'response.completed', {
      response: {
        ...resp,
        status: incomplete ? 'incomplete' : 'completed',
        incomplete_details: incomplete,
        usage: {
          input_tokens: u.input,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: u.output,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: u.input + u.output,
        },
      },
    }),
  );
  return frames;
}

export function frames(wire: Wire, s: Script): string[] {
  if (wire === 'chat') return chatFrames(s);
  if (wire === 'gemini') return geminiFrames(s);
  return responsesFrames(s);
}

/** A provider-style JSON error body for the given wire protocol. */
export function errorBody(wire: Wire, status: number): string {
  if (wire === 'gemini') {
    return JSON.stringify({ error: { code: status, message: `fake ${status}`, status: 'X' } });
  }
  return JSON.stringify({ error: { message: `fake ${status}`, type: 'x', code: null } });
}
