/**
 * Calls to methods the kernel's protocol module does not list (`mcp.status`, `mcp.approve`
 * for the MCP registry panel): params are built by typed callers, and every result is
 * checked against the console's own schema before use. A kernel without them answers
 * "method not found" and the panel stays read-only.
 */
import { ErrorCodes } from '@kernelpai/kernel/protocol';
import type { z } from 'zod';
import { t } from '../i18n/core';
import { RpcError } from './client';

export interface RawCaller {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

let caller: RawCaller | undefined;

export function setRawCaller(c: RawCaller | undefined): void {
  caller = c;
}

export async function rawCall<T>(
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!caller) throw new Error(t('error.notConnected'));
  const raw = await caller.request(method, params);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(t('tools.error.badReply', { method }));
  return parsed.data;
}

/** The kernel does not offer this method (an older or a not-yet-wired server). */
export const isMethodNotFound = (e: unknown): boolean =>
  e instanceof RpcError && e.code === ErrorCodes.methodNotFound;
