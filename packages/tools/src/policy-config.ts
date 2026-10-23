import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { GradedPermissionPolicy, type GradedPolicyOptions } from './policy.js';

/** `$KPAI_HOME/policy.json`: extends the defaults, never replaces them. */
export const PolicyConfigSchema = z
  .object({
    forbiddenPaths: z.array(z.string().min(1).max(256)).max(500).default([]),
    denyByModel: z
      .record(z.string().min(1).max(200), z.array(z.string().min(1).max(200)).max(200))
      .default({}),
  })
  .strict();
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export interface LoadedPolicy {
  config: PolicyConfig;
  /** A broken policy.json: reported, and the defaults still apply. */
  error?: string;
}

/** Reads `$KPAI_HOME/policy.json`; missing → empty; invalid → empty plus an error. */
export async function loadPolicyConfig(kpaiHome: string): Promise<LoadedPolicy> {
  const empty: PolicyConfig = { forbiddenPaths: [], denyByModel: {} };
  let raw: string;
  try {
    raw = await readFile(path.join(kpaiHome, 'policy.json'), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { config: empty };
    return { config: empty, error: `policy.json: ${(err as Error).message}` };
  }
  try {
    return { config: PolicyConfigSchema.parse(JSON.parse(raw)) };
  } catch (err) {
    const msg = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
    return { config: empty, error: `policy.json is invalid (defaults still apply): ${msg}` };
  }
}

/** Defaults + policy.json + caller extras (and pack zones), as one graded policy. */
export function buildPolicy(
  config: PolicyConfig,
  extra: GradedPolicyOptions = {},
): GradedPermissionPolicy {
  const denyByModel: Record<string, string[]> = {};
  for (const src of [config.denyByModel, extra.denyByModel ?? {}]) {
    for (const [model, tools] of Object.entries(src)) {
      denyByModel[model] = [...(denyByModel[model] ?? []), ...tools];
    }
  }
  return new GradedPermissionPolicy({
    ...extra,
    policyForbiddenPaths: [...config.forbiddenPaths, ...(extra.policyForbiddenPaths ?? [])],
    denyByModel,
  });
}
