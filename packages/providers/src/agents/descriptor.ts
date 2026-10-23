/**
 * External agent CLIs as graph-node authors (R-503, ADR-0034). One YAML descriptor per
 * agent says how to run it headless: binary, arguments, how the prompt is passed, how its
 * output and its cost or usage are reported, how a rate limit or quota shows, and which
 * provider it counts as for critic diversity. No model id lives here: the CLI uses the
 * model of the user's own login and settings.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase id, digits and dashes');
/** A dotted path into the CLI's JSON output (`usage.input_tokens`). */
const JsonPath = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/);
/** Only credential-shaped names, as in provider descriptors (review F8). */
const SecretName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*_(API_KEY|API_TOKEN|AUTH_TOKEN|KEY|TOKEN)$/, 'credential-shaped name');

export const PROMPT_PLACEHOLDER = '{prompt}';

export const AgentDescriptorSchema = z
  .strictObject({
    id: Id,
    name: z.string().min(1).max(80),
    /** A command name looked up on PATH, or an absolute path. Never run through a shell. */
    binary: z
      .string()
      .min(1)
      .refine(
        (b) => isAbsolute(b) || /^[A-Za-z0-9._-]+$/.test(b),
        'a bare name or an absolute path',
      ),
    /** Headless arguments; `{prompt}` is replaced by the prompt (whole argument only). */
    args: z.array(z.string().max(400)).max(32),
    promptVia: z.enum(['arg', 'stdin']).default('arg'),
    /** The provider the agent counts as (principle 2): a critic must come from another one. */
    provider: Id,
    /** Further providers the agent may be backed by (multi-provider CLIs): critics avoid them too. */
    alsoCounts: z.array(Id).max(16).default([]),
    /** Where its model runs; checked against a run's allowed jurisdictions. */
    jurisdiction: z.string().min(1).max(32),
    /** Always `subscription` in phase 5: the user's own login (ADR-0031 §8). */
    source: z.literal('subscription').default('subscription'),
    output: z
      .strictObject({
        format: z.enum(['text', 'json', 'jsonl']),
        /** JSON: the field holding the final answer; text: the whole stdout. */
        text: JsonPath.optional(),
        /** JSON: a boolean error flag. */
        error: JsonPath.optional(),
        /** How cost or usage is reported: notional USD, tokens, or nothing. */
        costUsd: JsonPath.optional(),
        inputTokens: JsonPath.optional(),
        outputTokens: JsonPath.optional(),
      })
      .refine((o) => o.format === 'text' || o.text !== undefined, 'json output needs `text`'),
    /** What a rate limit or an exhausted plan looks like (case-insensitive regexes). */
    rateLimit: z
      .strictObject({
        patterns: z.array(z.string().min(3).max(200)).max(16).default([]),
        exitCodes: z.array(z.number().int().min(1).max(255)).max(8).default([]),
        /** How long `subscription:<provider>` is skipped after one. */
        cooldownMinutes: z.number().int().min(1).max(1440).default(60),
      })
      .default({ patterns: [], exitCodes: [], cooldownMinutes: 60 }),
    /** Longest one run may take, in minutes (the run budget may cut it shorter). */
    timeoutMinutes: z.number().int().min(1).max(240).default(20),
    /** Extra variables removed from the child's environment (beyond KernelPAI's keys). */
    scrubEnv: z.array(SecretName).max(32).default([]),
    /** Arguments that print a version without side effects (detection). */
    versionArgs: z.array(z.string().max(40)).max(4).default(['--version']),
    notes: z.string().max(1000).optional(),
  })
  .refine(
    (d) => d.promptVia === 'stdin' || d.args.includes(PROMPT_PLACEHOLDER),
    'args must contain {prompt} when promptVia is arg',
  );
export type AgentDescriptor = z.infer<typeof AgentDescriptorSchema>;

export const BUILTIN_AGENT_DIR = fileURLToPath(new URL('../../agents/', import.meta.url));

export function parseAgentDescriptor(source: string, origin: string): AgentDescriptor {
  const r = AgentDescriptorSchema.safeParse(parseYaml(source));
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid agent descriptor ${origin}: ${issues}`);
  }
  return r.data;
}

/** Every *.yaml of the directories; later directories override earlier ids (user files). */
export function loadAgentDescriptors(
  dirs: readonly string[],
  onInvalid?: (path: string, error: Error) => void,
): AgentDescriptor[] {
  const byId = new Map<string, AgentDescriptor>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()) {
      const path = join(dir, file);
      try {
        const d = parseAgentDescriptor(readFileSync(path, 'utf8'), path);
        byId.set(d.id, d);
      } catch (err) {
        if (!onInvalid) throw err;
        onInvalid(path, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  return [...byId.values()];
}

/** Every provider an agent counts as, for critic diversity (its own first). */
export function agentProviders(d: AgentDescriptor): string[] {
  return [...new Set([d.provider, ...d.alsoCounts])];
}

/** The argument list with the prompt substituted (no shell: each argument stays one). */
export function agentArgs(d: AgentDescriptor, prompt: string): string[] {
  if (d.promptVia === 'stdin') return [...d.args];
  return d.args.map((a) => (a === PROMPT_PLACEHOLDER ? prompt : a));
}
