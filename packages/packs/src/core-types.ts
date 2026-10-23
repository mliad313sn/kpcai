import { TaskTypeSchema, type ProtocolName, type TaskType } from '@kernelpai/core';
import { z } from 'zod';

/** Re-exported so packs validate against the live core enum, never a copy. */
export { TaskTypeSchema };
export type { TaskType };

/** Core has `ProtocolName` as a type only; this schema must stay equal to it. */
export const ProtocolNameSchema = z.enum(['solo', 'author_critic', 'debate', 'vote']);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time guard: fails `tsc` if core adds or removes a protocol. */
export const PROTOCOLS_MATCH_CORE: Same<z.infer<typeof ProtocolNameSchema>, ProtocolName> = true;
