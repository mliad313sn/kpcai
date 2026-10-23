/**
 * WI-S1-03: the authorised scope a selected pack may require (reverse engineering,
 * offensive security). Given by the user (CLI `--scope`, protocol `options.scope`) or
 * declared in `.kpstudio/scope.yaml`. A repository file is repository content, so the human
 * confirms it before a run uses it. Problems refuse the run before any spend. The runner
 * (S4) validates the scope again at start and journals it without its notes.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphNode } from '@kernelpai/core';
import { checkRunScope, type PlannedNode } from '@kernelpai/orchestrator';
import {
  AuthorisedScopeSchema,
  describeScope,
  type AuthorisedScope,
  type Pack,
} from '@kernelpai/packs';
import { parse as parseYaml } from 'yaml';

export const SCOPE_FILE = '.kpstudio/scope.yaml';
const MAX_SCOPE_BYTES = 64 * 1024;

export interface ScopeCheck {
  /** Packs of this plan that need an authorised scope. */
  required: string[];
  /** Where the scope came from; absent when none was found. */
  source?: 'request' | 'file';
  /** Plan lines (`describeScope`). */
  lines: string[];
  /** Why the run would be refused; empty when it may run. */
  problems: string[];
  /** The validated scope (kept by the kernel for the journal). */
  scope?: AuthorisedScope;
}

/**
 * A scope file (YAML or JSON) as data; undefined when absent. An unreadable or invalid file
 * yields an object the scope schema refuses, so the problem is reported, never ignored.
 */
export async function readScopeFile(file: string): Promise<unknown> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text) > MAX_SCOPE_BYTES) return { invalid: `${file} is too large` };
  try {
    return parseYaml(text, { maxAliasCount: 10 }) as unknown;
  } catch {
    return { invalid: `${file} is not valid YAML` };
  }
}

const fromFile = (cwd: string): Promise<unknown> => readScopeFile(join(cwd, SCOPE_FILE));

/**
 * The scope situation of a plan, with S4's run-start check (`checkRunScope`: every pack
 * that requires a scope, and nodes from packs that are not loaded). The runner checks
 * again at start and journals acceptance or refusal; the kernel only gathers and shows.
 */
export async function checkScope(
  selected: readonly Pack[],
  cwd: string,
  given: unknown,
  nodes: readonly GraphNode[],
  now: Date = new Date(),
): Promise<ScopeCheck> {
  const raw = given !== undefined ? given : await fromFile(cwd);
  const c = checkRunScope(selected, nodes as PlannedNode[], raw, now);
  if (c.required.length === 0 && c.problems.length === 0)
    return { required: [], lines: [], problems: [] };
  const source = raw === undefined ? undefined : given !== undefined ? 'request' : 'file';
  const missing = raw === undefined && c.required.length > 0;
  const problems = missing
    ? [
        `${c.required.join(', ')} need an authorised scope: give --scope <file> or declare ${SCOPE_FILE}`,
      ]
    : c.problems;
  const parsed = AuthorisedScopeSchema.safeParse(raw);
  return {
    required: c.required,
    ...(source ? { source } : {}),
    lines: parsed.success ? describeScope(parsed.data) : [],
    problems,
    ...(parsed.success && c.ok ? { scope: parsed.data } : {}),
  };
}

/** What the plan shows: everything but the raw scope object. */
export function scopeSummary(c: ScopeCheck): Omit<ScopeCheck, 'scope'> {
  return {
    required: c.required,
    ...(c.source ? { source: c.source } : {}),
    lines: c.lines,
    problems: c.problems,
  };
}
