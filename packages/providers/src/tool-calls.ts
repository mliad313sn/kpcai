import { ProviderError, type ChatMessage, type ChatRequest } from '@kernelpai/core';

/** Characters every wire protocol accepts in a function/tool name (Anthropic, OpenAI). */
const WIRE_SAFE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ToolNameCodec {
  /** Kernel tool name (may contain dots, e.g. `fs.read`, `mcp.git.log`) → wire name. */
  encode(name: string): string;
  /** Wire name from the model → kernel tool name (unknown names pass through). */
  decode(wire: string): string;
}

/**
 * Anthropic and OpenAI reject dots in tool names, while kernel tools are namespaced
 * with dots (ADR-0017). The codec is a per-request bijection: dots become `_`, and a
 * collision with another tool's name gets a numeric suffix. Wire-safe names keep
 * themselves.
 */
export function toolNameCodec(req: ChatRequest): ToolNameCodec {
  const names = new Set([
    ...(req.tools ?? []).map((t) => t.name),
    ...req.messages.flatMap((m) => (m.toolCalls ?? []).map((c) => c.name)),
  ]);
  const ordered = [...names].sort(
    (a, b) => Number(!WIRE_SAFE.test(a)) - Number(!WIRE_SAFE.test(b)),
  );
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  for (const name of ordered) {
    const base = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    let wire = base;
    for (let i = 2; fromWire.has(wire); i++) wire = `${base.slice(0, 60)}_${i}`;
    toWire.set(name, wire);
    fromWire.set(wire, name);
  }
  return { encode: (n) => toWire.get(n) ?? n, decode: (w) => fromWire.get(w) ?? w };
}

export function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Tool input from a model is untrusted data (ADR-0017): it must be a JSON object.
 * A string is parsed first (streamed argument JSON); an empty string means `{}`.
 */
export function parseToolInput(
  provider: string,
  toolName: string,
  raw: unknown,
): Record<string, unknown> {
  let value = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {};
    try {
      value = JSON.parse(raw);
    } catch (cause) {
      throw new ProviderError('malformed', provider, `Tool ${toolName}: input is not valid JSON`, {
        cause,
      });
    }
  }
  if (!isJsonObject(value)) {
    throw new ProviderError('malformed', provider, `Tool ${toolName}: input is not a JSON object`);
  }
  return value;
}

/** Tool call id → tool name, from the assistant turns of the history. */
export function toolNamesById(messages: readonly ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) for (const c of m.toolCalls ?? []) map.set(c.id, c.name);
  return map;
}

/** The tool call a `tool` message answers; a dangling result is a caller bug. */
export function answeredCall(
  provider: string,
  m: ChatMessage,
  names: ReadonlyMap<string, string>,
): { id: string; name: string } {
  const id = m.toolCallId;
  const name = id === undefined ? undefined : names.get(id);
  if (id === undefined || name === undefined) {
    throw new ProviderError(
      'bad_request',
      provider,
      `tool message ${id === undefined ? 'has no toolCallId' : `answers unknown call ${id}`}`,
    );
  }
  return { id, name };
}
