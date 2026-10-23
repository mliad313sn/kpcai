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

/** Built-in descriptors, overridable by ~/.kernelpai/providers/*.yaml. */
export function buildRegistry(env: Env): ProviderRegistry {
  const dirs = [BUILTIN_DESCRIPTOR_DIR, join(kpaiHome(env), 'providers')];
  return new ProviderRegistry(loadDescriptors(dirs), env);
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
