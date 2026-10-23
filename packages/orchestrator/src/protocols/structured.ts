import type { ParseResult } from '../parse.js';
import { onlyDecision } from '../routing.js';
import type { StepRunner } from '../step.js';
import type { NodeRun, StepFailed, StepOk, StepSpec } from '../types.js';

export type Structured<T> =
  { ok: true; value: T; step: StepOk } | (StepFailed & { malformed?: boolean });

/**
 * A step whose answer must parse (judge, voter): an unparseable answer gets one retry on
 * the same model with the parse error appended; still unparseable is `malformed`.
 */
export async function structured<T>(
  s: StepRunner,
  run: NodeRun,
  spec: StepSpec,
  parse: (text: string) => ParseResult<T>,
): Promise<Structured<T>> {
  const first = await s.run(run, spec);
  if (!first.ok) return first;
  const parsed = parse(first.text);
  if (parsed.ok) return { ok: true, value: parsed.value, step: first };
  const retry = await s.run(run, {
    ...spec,
    prompt: `${spec.prompt}\n\nYour previous reply could not be read (${parsed.error}). Reply with only the JSON object, nothing else.`,
    decision: onlyDecision(run.node.id, first.served),
  } as StepSpec);
  if (!retry.ok) return retry;
  const again = parse(retry.text);
  if (again.ok) return { ok: true, value: again.value, step: retry };
  return {
    ok: false,
    malformed: true,
    error: `${spec.role} output malformed: ${again.error}`,
    cancelled: false,
    costUsd: 0,
  };
}
