import { homedir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '@kernelpai/journal';
import {
  BUILTIN_DESCRIPTOR_DIR,
  ProviderRegistry,
  loadDescriptors,
  type Env,
} from '@kernelpai/providers';

export const DEFAULT_CONFIRM_ABOVE_USD = 0.1;

export function kpaiHome(env: Env): string {
  return env['KPAI_HOME']?.trim() || join(homedir(), '.kernelpai');
}

export function journalPath(env: Env, override?: string): string {
  return override ?? join(kpaiHome(env), 'journal.db');
}

export function openJournal(env: Env, override?: string): Journal {
  return Journal.open(journalPath(env, override));
}

/**
 * Built-in descriptors (strict), overridable by ~/.kernelpai/providers/*.yaml. An invalid
 * user file is skipped and reported through `warn` rather than breaking every command.
 */
export function buildRegistry(
  env: Env,
  warn: (msg: string) => void = () => undefined,
): ProviderRegistry {
  const builtIn = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]);
  const user = loadDescriptors([join(kpaiHome(env), 'providers')], {
    onInvalid: (path, err) => warn(`skipped ${path}: ${err.message}\n`),
  });
  const byId = new Map([...builtIn, ...user].map((d) => [d.id, d]));
  return new ProviderRegistry([...byId.values()], env);
}

export function confirmThreshold(env: Env): number {
  const raw = env['KPAI_CONFIRM_ABOVE_USD'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONFIRM_ABOVE_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`KPAI_CONFIRM_ABOVE_USD must be a non-negative number, got "${raw}"`);
  }
  return n;
}
