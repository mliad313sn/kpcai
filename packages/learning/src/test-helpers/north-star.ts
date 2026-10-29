/**
 * North-star scenarios on top of `Script`: runs that serve a named intent, earn a given
 * assurance label from real journal shapes (author, critic verdicts, test runs), and land
 * patches with J3 file images, as the kernel, the tool bus and the daemon journal them.
 */
import type { Script } from './script.js';

export type Level = 'V0' | 'V1' | 'V2';

/** `run intent` (J1) as the kernel journals it before anything else of the run. */
export function intent(
  s: Script,
  runId: string,
  id: string,
  origin = 'human-request',
  unattended = false,
): void {
  s.note({ action: 'run intent', runId, intent: { id, origin }, unattended });
}

/**
 * One finished run of node n1 under `intent`, reaching `level`:
 * V0 the critic is the author's own provider; V1 another provider approves, no test;
 * V2 another provider approves and a real test run passes.
 */
export function deliveringRun(
  s: Script,
  runId: string,
  o: { intent?: string; origin?: string; level: Level; costUsd?: number; parent?: string },
): void {
  s.plan([{ id: 'n1', type: 'code_generation' }], { expectedUsd: 0.1, capUsd: 0.3 });
  if (o.intent) intent(s, runId, o.intent, o.origin);
  s.note({
    action: 'run started',
    runId,
    ...(o.parent ? { parent: { runId: o.parent, nodeId: 'n1' } } : {}),
  });
  s.answer('n1', 'alpha/m', 'author', 'diff', { costUsd: o.costUsd ?? 0.1 });
  s.critic('n1', o.level === 'V0' ? 'alpha/other' : 'delta/m', true);
  if (o.level === 'V2') s.test('n1', 'alpha/m', 0);
  s.outcome(runId);
}

export interface Img {
  pre: string | null;
  post: string | null;
}

/** A kernel `git.apply` of node n1 after its checkpoint, with J3 images per file. */
export function applyImaged(
  s: Script,
  runId: string,
  i: number,
  images: Record<string, Img>,
  decision = 'confirmed',
): string {
  const cp = `refs/kpai/checkpoints/${runId}/img-${i}`;
  s.note({ action: 'checkpoint', runId, ref: cp, label: 'before patch from n1' });
  s.tool(`n1#patch-${i}`, 'kernel/apply', {
    tool: 'git.apply',
    decision,
    isError: false,
    input: { patch: { chars: 10, sha256: 'x' } },
    meta: { files: Object.keys(images), bytes: 10, images },
  });
  return cp;
}

/** A Sponsor answer as `Sponsor.answer` journals it (J2). */
export function sponsorAnswer(
  s: Script,
  o: {
    answer?: 'yes' | 'no';
    cls: 'trivial' | 'consequential';
    askedAt: string;
    answeredAt: string;
    viewedAt?: string;
  },
): void {
  s.note({
    action: 'sponsor answer',
    programId: 'prog-1',
    escalationId: `e-${o.answeredAt}`,
    rule: o.cls === 'trivial' ? 'confirm.write' : 'gate.pass',
    answer: o.answer ?? 'yes',
    askedAt: o.askedAt,
    answeredAt: o.answeredAt,
    viewed: o.viewedAt !== undefined,
    ...(o.viewedAt ? { viewedAt: o.viewedAt } : {}),
    class: o.cls,
  });
}

/** A kernel confirmation answered by the human (J2, `asks.ts`). */
export function confirmAnswer(
  s: Script,
  o: { yes: boolean; consequential: boolean; askedAt: string; answeredAt: string; diff?: boolean },
): void {
  s.note({
    action: 'confirmation answered',
    runId: 'r-ask',
    kind: 'patch',
    risk: 'write',
    consequential: o.consequential,
    answer: o.yes ? 'yes' : 'no',
    askedAt: o.askedAt,
    answeredAt: o.answeredAt,
    viewed: o.diff === false ? 'none' : 'diff',
  });
}

/** Instant `seconds` after the Script's epoch (2026-10-23T10:00:00Z). */
export const at = (seconds: number): string =>
  new Date(Date.parse('2026-10-23T10:00:00Z') + seconds * 1000).toISOString();
