/** One JSON-RPC 2.0 message in, at most one reply out; everything checked against protocol.ts. */
import {
  ErrorCodes,
  RequestSchema,
  isMethod,
  parseParams,
  parseResult,
  type MethodName,
} from '@kernelpai/kernel/protocol';
import { toRpcError, type Handlers } from './handlers.js';

type Id = string | number | null;

export interface Reply {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const failure = (id: Id, code: number, message: string, data?: unknown): Reply => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

function idOf(msg: unknown): Id {
  const id = (msg as { id?: unknown } | null)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/**
 * Handles one text frame. Returns the reply, or undefined for messages that get none
 * (client notifications and replies, which this server does not ask for).
 */
export async function handleMessage(text: string, h: Handlers): Promise<Reply | undefined> {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return failure(null, ErrorCodes.parse, 'parse error');
  }
  if (Array.isArray(msg))
    return failure(null, ErrorCodes.invalidRequest, 'batches are not supported');
  const m = msg as Record<string, unknown> | null;
  if (m && typeof m === 'object' && m.id === undefined) return undefined;
  const req = RequestSchema.safeParse(msg);
  if (!req.success) return failure(idOf(msg), ErrorCodes.invalidRequest, 'invalid request');
  const { id, method, params } = req.data;
  if (!isMethod(method)) return failure(id, ErrorCodes.methodNotFound, 'method not found');
  const checked = parseParams(method, params);
  if (!checked.ok) return failure(id, ErrorCodes.invalidParams, 'invalid params', checked.error);
  return call(id, method, checked.value, h);
}

async function call(id: Id, method: MethodName, params: unknown, h: Handlers): Promise<Reply> {
  let result: unknown;
  try {
    result = await (h[method] as (p: unknown) => unknown)(params);
  } catch (err) {
    const e = toRpcError(err);
    return failure(id, e.code, e.message);
  }
  const out = parseResult(method, result);
  if (!out.ok) return failure(id, ErrorCodes.internal, `invalid ${method} result`, out.error);
  return { jsonrpc: '2.0', id, result: out.value };
}
