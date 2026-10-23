import { z } from 'zod';
import type { ChatMessage, ChatRequest, ToolCall } from '@kernelpai/core';
import { answeredCall, parseToolInput, toolNamesById, type ToolNameCodec } from '../tool-calls.js';

/** One tool call as Ollama streams it in `message.tool_calls`. */
export const OllamaToolCallSchema = z
  .object({
    id: z.string().optional(),
    function: z.object({ name: z.string().min(1), arguments: z.unknown() }).loose(),
  })
  .loose();
export type OllamaToolCall = z.infer<typeof OllamaToolCallSchema>;

/** `req.tools` in the OpenAI-style function shape `/api/chat` accepts. */
export function toOllamaTools(req: ChatRequest, codec: ToolNameCodec): unknown[] | undefined {
  if (!req.tools?.length) return undefined;
  return req.tools.map((t) => ({
    type: 'function',
    function: {
      name: codec.encode(t.name),
      description: t.description,
      parameters: { ...t.inputSchema, type: 'object' },
    },
  }));
}

/**
 * History in `/api/chat` shape. Only the fields Ollama knows are sent: assistant
 * `tool_calls` (arguments as objects) and `tool` turns named by `tool_name`. Ollama
 * has no error flag on tool results, so an error result is prefixed with `Error: `.
 */
export function toOllamaMessages(
  provider: string,
  messages: readonly ChatMessage[],
  codec: ToolNameCodec,
): unknown[] {
  const names = toolNamesById(messages);
  return messages.map((m) => {
    if (m.role === 'tool') {
      const { name } = answeredCall(provider, m, names);
      const content = m.isError ? `Error: ${m.content}` : m.content;
      return { role: 'tool', content, tool_name: codec.encode(name) };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          function: { name: codec.encode(c.name), arguments: c.input ?? {} },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * A streamed call as a kernel ToolCall. Ollama gives arguments as an object (some
 * versions as a JSON string); either way it must end up a JSON object. Ollama may omit
 * call ids, so one is made from the call's position in the response.
 */
export function fromOllamaToolCall(
  provider: string,
  call: OllamaToolCall,
  codec: ToolNameCodec,
  position: number,
): ToolCall {
  const name = codec.decode(call.function.name);
  return {
    id: call.id ?? `ollama_call_${position}`,
    name,
    input: parseToolInput(provider, name, call.function.arguments),
  };
}
