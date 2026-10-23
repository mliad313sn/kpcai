import {
  jsonSchema,
  tool,
  type AssistantContent,
  type ModelMessage,
  type ToolResultPart,
  type ToolSet,
} from 'ai';
import type { ChatMessage, ChatRequest } from '@kernelpai/core';
import { answeredCall, toolNamesById, type ToolNameCodec } from '../tool-calls.js';

type JsonSchemaInput = Parameters<typeof jsonSchema>[0];

/**
 * `req.tools` as an AI SDK tool set. No `execute`: the SDK then returns the calls
 * instead of running them, and the kernel's ToolBus decides (ADR-0017). No input
 * validation either: the adapter checks the input shape, the ToolBus the schema.
 */
export function toToolSet(req: ChatRequest, codec: ToolNameCodec): ToolSet | undefined {
  if (!req.tools?.length) return undefined;
  return Object.fromEntries(
    req.tools.map((t) => [
      codec.encode(t.name),
      tool({
        description: t.description,
        inputSchema: jsonSchema({ ...t.inputSchema, type: 'object' } as JsonSchemaInput),
      }),
    ]),
  );
}

function assistantContent(m: ChatMessage, codec: ToolNameCodec): AssistantContent {
  if (!m.toolCalls?.length) return m.content;
  return [
    ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
    ...m.toolCalls.map((c) => ({
      type: 'tool-call' as const,
      toolCallId: c.id,
      toolName: codec.encode(c.name),
      input: c.input ?? {},
    })),
  ];
}

/**
 * Conversation history (system turns excluded) as AI SDK model messages: assistant
 * tool calls become `tool-call` parts, consecutive `tool` messages one `tool` message
 * of `tool-result` parts (`error-text` output when `isError`).
 */
export function toModelMessages(
  provider: string,
  messages: readonly ChatMessage[],
  codec: ToolNameCodec,
): ModelMessage[] {
  const names = toolNamesById(messages);
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: assistantContent(m, codec) });
    } else {
      const { id, name } = answeredCall(provider, m, names);
      const part: ToolResultPart = {
        type: 'tool-result',
        toolCallId: id,
        toolName: codec.encode(name),
        output: { type: m.isError ? 'error-text' : 'text', value: m.content },
      };
      const prev = out.at(-1);
      if (prev?.role === 'tool') prev.content.push(part);
      else out.push({ role: 'tool', content: [part] });
    }
  }
  return out;
}
