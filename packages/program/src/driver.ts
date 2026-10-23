/**
 * Delegation of a work package to the kernel (ADR-0031 §4). The kernel is injected as a
 * `RunStarter`, so this package never starts a real run itself; phase 5 wires it to
 * `Kernel.plan` + `Kernel.startRun` (isolated worktree, packs, cross-provider critic).
 *
 * Injection posture: a run's result reaches the program only as typed fields (status,
 * cost, tests, evidence ids). Its free text is kept as `untrustedSummary` for people and
 * is never parsed, so no run output can ask the PO for more budget or rights.
 */
import { checkAction } from './envelope.js';
import { sponsorYes } from './machine.js';
import type { ProgramEvent } from './events.js';
import type { Verdict } from './actions.js';
import type { ProgramState, RunRecord } from './schemas.js';

export interface PlannedRun {
  planId: string;
  /** Band top (D-021), what the envelope reserves. */
  capUsd: number;
  expectedUsd: number;
  /** Providers the plan routes the authors to (for the cross-provider gate check). */
  providers: string[];
  /** Where those authors run (a subscription agent CLI counts as its provider, R-503). */
  source: 'local' | 'api' | 'subscription';
}

export interface StartedRun {
  runId: string;
}

/** The kernel, seen from a program. */
export interface RunStarter {
  plan(input: {
    programId: string;
    wpId: string;
    request: string;
    packs: string[];
    purpose: 'work' | 'review';
  }): Promise<PlannedRun>;
  /** Starts the planned run in its own worktree. Never called unless the envelope allowed. */
  start(planId: string, options: { isolated: true }): Promise<StartedRun>;
}

/** What a settled run reports. Only typed fields drive the program. */
export interface RunResult {
  runId: string;
  status: 'finished' | 'failed' | 'cancelled' | 'not_run';
  costUsd: number;
  testsPassed?: boolean;
  hours?: number;
  evidence: string[];
  /** S10 R5: V0–V2, derived by the host from the run's journal. */
  assurance?: 'V0' | 'V1' | 'V2';
  /** Model text for people to read. Never parsed, never acted on. */
  untrustedSummary?: string;
}

export type Delegation =
  | { outcome: 'started'; verdict: Verdict; event: ProgramEvent }
  | { outcome: 'escalated'; verdict: Verdict; event: ProgramEvent }
  | { outcome: 'refused'; verdict: Verdict };

export interface DelegateOptions {
  now: Date;
  /** `review`: the gate's independent review run, keyed by the phase id. */
  purpose?: 'work' | 'review';
  /** Id for the escalation if one is needed. */
  escalationId: string;
}

/**
 * Plans a work package, checks the plan's band top against the envelope, and starts it
 * only on `allow`. Returns the event the host applies: `run.started` (actor kernel) or
 * `escalate` (actor po). A Sponsor yes to that escalation lets the next delegation start.
 */
export async function delegate(
  state: ProgramState,
  wpId: string,
  kernel: RunStarter,
  o: DelegateOptions,
): Promise<Delegation> {
  const purpose = o.purpose ?? 'work';
  const phase = state.charter.phases[state.phaseIndex];
  const wp = phase?.workPackages.find((w) => w.id === wpId);
  const request = purpose === 'review' ? reviewRequest(state) : wp?.request;
  if (!phase || !request) {
    const verdict = refusal(`${wpId} is not in the current phase`);
    return { outcome: 'refused', verdict };
  }
  const plan = await kernel.plan({
    programId: state.charter.programId,
    wpId,
    request,
    packs: packsFor(state, wp?.lead),
    purpose,
  });
  const action = {
    kind: 'run.start',
    wpId,
    capUsd: plan.capUsd,
    isolated: true,
    purpose,
    source: plan.source,
    providers: plan.providers,
  };
  const verdict = checkAction(state, action, o.now);
  if (verdict.verdict === 'refuse') return { outcome: 'refused', verdict };
  if (verdict.verdict === 'escalate' && !sponsorYes(state, verdict.rule, wpId, plan.capUsd))
    return { outcome: 'escalated', verdict, event: escalation(o, verdict, wpId, plan.capUsd) };
  const { runId } = await kernel.start(plan.planId, { isolated: true });
  const run = runRecord(runId, wpId, phase.id, plan, purpose, o.now);
  return { outcome: 'started', verdict, event: { type: 'run.started', run } };
}

function runRecord(
  runId: string,
  wpId: string,
  phaseId: string,
  plan: PlannedRun,
  purpose: 'work' | 'review',
  now: Date,
): RunRecord {
  return {
    runId,
    wpId,
    phaseId,
    capUsd: plan.capUsd,
    costUsd: 0,
    status: 'running',
    purpose,
    source: plan.source,
    hours: 0,
    providers: plan.providers,
    evidence: [`run:${runId}`, `plan:${plan.planId}`],
    startedAt: now.toISOString(),
  };
}

/** The `run.settled` event for a result: typed fields only. */
export function settleEvent(r: RunResult): ProgramEvent {
  return {
    type: 'run.settled',
    runId: r.runId,
    status: r.status,
    costUsd: r.costUsd,
    testsPassed: r.testsPassed,
    hours: r.hours,
    evidence: r.evidence,
    ...(r.assurance ? { assurance: r.assurance } : {}),
  };
}

function escalation(o: DelegateOptions, v: Verdict, wpId: string, capUsd: number): ProgramEvent {
  return {
    type: 'escalate',
    escalation: {
      id: o.escalationId,
      at: o.now.toISOString(),
      rule: v.rule,
      question: `Start ${wpId} up to $${capUsd.toFixed(2)}? ${v.reason}.`,
      subject: { wpId, capUsd },
    },
  };
}

/** The reviewer gets the phase's goal and exit criteria, not the builders' conversations. */
export function reviewRequest(s: ProgramState): string {
  const p = s.charter.phases[s.phaseIndex]!;
  return [
    `Independent gate review of phase "${p.title}". Read-only.`,
    `Goal: ${p.goal}`,
    'Exit criteria:',
    ...p.exit.map((e) => `- ${e}`),
    'Each finding: severity, file:line or artefact, failure scenario, reproduction.',
  ].join('\n');
}

function packsFor(s: ProgramState, lead: string | undefined): string[] {
  const seat = s.charter.seats.find((x) => x.id === lead);
  return [...new Set([...s.charter.packs, ...(seat?.packs ?? [])])];
}

function refusal(reason: string): Verdict {
  return { verdict: 'refuse', rule: 'run.scope', reason };
}
