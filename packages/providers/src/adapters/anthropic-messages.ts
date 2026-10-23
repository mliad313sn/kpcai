import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatRequest } from '@kernelpai/core';
import { answeredCall, isJsonObject, toolNamesById, type ToolNameCodec } from '../tool-calls.js';

type Block = Anthropic.ContentBlockParam;

/** `req.tools` as Messages API tool definitions (no tool_choice: the model decides). */
export function toAnthropicTools(req: ChatRequest, codec: ToolNameCodec): Anthropic.Tool[] {
  return (req.tools ?? []).map((t) => ({
    name: codec.encode(t.name),
    description: t.description,
    input_schema: { ...t.inputSchema, type: 'object' },
  }));
}

function assistantBlocks(m: ChatMessage, codec: ToolNameCodec): Block[] {
  const text: Block[] = m.content ? [{ type: 'text', text: m.content }] : [];
  return [
    ...text,
    ...(m.toolCalls ?? []).map((c): Block => ({
      type: 'tool_use',
      id: c.id,
      name: codec.encode(c.name),
      input: isJsonObject(c.input) ? c.input : {},
    })),
  ];
}

function toolResult(provider: string, m: ChatMessage, names: Map<string, string>): Block {
  const { id } = answeredCall(provider, m, names);
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: m.content,
    ...(m.isError ? { is_error: true } : {}),
  };
}

/**
 * Conversation history in Messages API shape. Assistant tool calls become `tool_use`
 * blocks; consecutive `tool` messages become `tool_result` blocks of one user turn
 * (results first, as the API requires), followed by any user text of the same turn.
 * Plain turns keep string content.
 */
export function toAnthropicMessages(
  provider: string,
  messages: readonly ChatMessage[],
  codec: ToolNameCodec,
): Anthropic.MessageParam[] {
  const names = toolNamesById(messages);
  const out: Anthropic.MessageParam[] = [];
  /** Blocks of the user turn that carries tool results, while it is still open. */
  let toolTurn: Block[] | undefined;
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant') {
      const plain = !m.toolCalls?.length;
      out.push({ role: 'assistant', content: plain ? m.content : assistantBlocks(m, codec) });
      toolTurn = undefined;
    } else if (toolTurn) {
      toolTurn.push(
        m.role === 'tool' ? toolResult(provider, m, names) : { type: 'text', text: m.content },
      );
    } else if (m.role === 'tool') {
      toolTurn = [toolResult(provider, m, names)];
      out.push({ role: 'user', content: toolTurn });
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}
