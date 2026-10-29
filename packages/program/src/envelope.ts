/**
 * The delegation envelope checker (ADR-0031 §3): allow, escalate to the Sponsor, or
 * refuse a proposed action. Pure: it reads the program state and returns a verdict; it
 * never changes the envelope, and nothing it is given can widen it.
 */
import { ProposedActionSchema, type ProposedAction, type Verdict } from './actions.js';
import { departmentCommittedUsd, departmentOf, ledger } from './ledger.js';
import { permits, policyFor, quotaBlocker } from './sources.js';
import type { Envelope, Phase, ProgramState, WritePolicy } from './schemas.js';

const EPS = 1e-9;
const allow = (rule: string, reason: string): Verdict => ({ verdict: 'allow', rule, reason });
const refuse = (rule: string, reason: string): Verdict => ({ verdict: 'refuse', rule, reason });
const escalate = (rule: string, reason: string, reserved?: Verdict['reserved']): Verdict =>
  reserved
    ? { verdict: 'escalate', rule, reason, reserved }
    : { verdict: 'escalate', rule, reason };

/** Checks one proposed action of the PO assistant against the approved charter's envelope. */
export function checkAction(state: ProgramState, input: unknown, now: Date): Verdict {
  const parsed = ProposedActionSchema.safeParse(input);
  if (!parsed.success) return refuse('action.invalid', 'the proposed action does not parse');
  const action = parsed.data;
  // Reserved items come first: no state, envelope or expiry turns them into an allow.
  if (action.kind === 'reserved')
    return escalate(`reserved.${action.item}`, 'reserved to the Sponsor', action.item);
  if (action.kind === 'envelope.change') return checkEnvelopeChange(state.charter.envelope, action);
  if (!state.approval) return refuse('program.unapproved', 'the charter is not approved');
  if (state.status === 'paused' || state.status === 'stopped' || state.status === 'delivered')
    return refuse(`program.${state.status}`, `the program is ${state.status}`);
  const env = state.charter.envelope;
  if (env.expires && now.getTime() >= Date.parse(env.expires))
    return escalate('envelope.expired', 'the envelope has expired');
  switch (action.kind) {
    case 'run.start':
      return checkRunStart(state, action);
    case 'confirm':
      return checkConfirm(state, action);
    case 'merge':
      return checkMerge(env.write, action);
  }
}

function checkRunStart(
  state: ProgramState,
  a: Extract<ProposedAction, { kind: 'run.start' }>,
): Verdict {
  const want = a.purpose === 'review' ? 'gate' : 'running';
  if (state.status !== want)
    return refuse('run.state', `no ${a.purpose} run while ${state.status}`);
  const phase = state.charter.phases[state.phaseIndex];
  const inScope =
    a.purpose === 'review'
      ? phase?.id === a.wpId
      : phase?.workPackages.some((wp) => wp.id === a.wpId);
  if (!phase || !inScope) return refuse('run.scope', `${a.wpId} is not in the current phase`);
  if (!a.isolated)
    return escalate('write.in-place', 'a run outside its own worktree needs the Sponsor');
  const src = checkSources(state, a);
  if (src) return src;
  const dept = a.purpose === 'work' ? departmentOf(state.charter, a.wpId) : undefined;
  const d = state.charter.departments.find((x) => x.id === dept);
  if (d?.capUsd !== undefined && departmentCommittedUsd(state, d.id) + a.capUsd > d.capUsd + EPS)
    return escalate('budget.department', `run would pass the ${d.id} cap`, 'spend-beyond-envelope');
  return withinEnvelope(state, phase, a.capUsd, 'run');
}

/** Source policy (refuse: it is the Sponsor's standing rule) and subscription quotas. */
function checkSources(
  state: ProgramState,
  a: Extract<ProposedAction, { kind: 'run.start' }>,
): Verdict | undefined {
  if (!a.providers.length) return refuse('source.unknown', 'the plan names no provider');
  const policy = policyFor(state.charter, a.wpId);
  const out = a.providers.find((p) => !permits(policy, a.source, p));
  if (out) return refuse('source.policy', `${a.source}:${out} is outside the source policy`);
  if (a.source !== 'subscription') return undefined;
  for (const p of a.providers) {
    const q = state.charter.envelope.subscriptions.find((x) => x.provider === p);
    const why = quotaBlocker(state, q);
    if (why) return escalate('budget.subscription', why, 'spend-beyond-envelope');
  }
  return undefined;
}

/** The amount fits the run cap, the phase cap and the total cap, counting live reservations. */
function withinEnvelope(state: ProgramState, phase: Phase, usd: number, what: string): Verdict {
  const env = state.charter.envelope;
  const l = ledger(state);
  const p = l.byPhase.find((b) => b.phaseId === phase.id);
  if (env.runCapUsd !== undefined && usd > env.runCapUsd + EPS)
    return escalate('budget.run', `${what} cap above the per-run cap`, 'spend-beyond-envelope');
  if ((p?.committedUsd ?? 0) + usd > phase.capUsd + EPS)
    return escalate('budget.phase', `${what} would pass the phase cap`, 'spend-beyond-envelope');
  if (l.committedUsd + usd > env.totalCapUsd + EPS)
    return escalate('budget.total', `${what} would pass the total cap`, 'spend-beyond-envelope');
  return allow(`budget.within`, `${what} fits the envelope`);
}

function checkConfirm(
  state: ProgramState,
  a: Extract<ProposedAction, { kind: 'confirm' }>,
): Verdict {
  const pre = new Set(state.charter.envelope.preAnswer);
  if (a.physical) return escalate('confirm.physical', 'physical effect', 'physical-device');
  if (a.risk === 'destructive' || a.confirm === 'restore')
    return escalate('confirm.destructive', 'destructive action', 'destructive');
  if (a.confirm === 'dispute' || a.confirm === 'memory')
    return escalate(`confirm.${a.confirm}`, 'a human choice by design (R-405, ADR-0027)');
  if (a.confirm === 'budget') return checkBudgetConfirm(state, pre, a);
  return checkWriteConfirm(pre, a);
}

/**
 * A spend question (D-035, P5-F2): trivial only when its amount is known and fits the
 * envelope; spend past a cap already accepted, an unknown amount or one above the envelope
 * is consequential (`confirm.overcap` or the envelope's own budget rule).
 */
function checkBudgetConfirm(
  state: ProgramState,
  pre: ReadonlySet<string>,
  a: Extract<ProposedAction, { kind: 'confirm' }>,
): Verdict {
  if (a.overCap || a.amountUsd === undefined)
    return escalate('confirm.overcap', 'spend past an accepted cap, or of an unknown amount');
  const phase = state.charter.phases[state.phaseIndex];
  if ((state.status !== 'running' && state.status !== 'gate') || !phase)
    return escalate('confirm.unbounded', 'no phase is running: the envelope cannot bound it');
  const v = withinEnvelope(state, phase, a.amountUsd, 'extra spend');
  if (v.verdict !== 'allow' || pre.has('budget-within-envelope')) return v;
  return escalate('confirm.budget', 'in-envelope spend, not pre-answered');
}

/**
 * tool, patch, artifact (D-035, P5-F2): a control-file write (`confirm.control`), a tool
 * that reaches past the worktree with more than read risk (`confirm.exec`: test.run,
 * shell.run, browser, MCP) and a write outside a worktree (`confirm.outside`) are
 * consequential; `write-in-worktree` covers none of them.
 */
function checkWriteConfirm(
  pre: ReadonlySet<string>,
  a: Extract<ProposedAction, { kind: 'confirm' }>,
): Verdict {
  if (a.control) return escalate('confirm.control', 'writes a control file of the project');
  if (!a.inWorktree && a.confirm === 'tool' && a.risk !== 'read')
    return escalate('confirm.exec', 'runs code or acts outside the run worktree');
  if (!a.inWorktree && a.confirm !== 'tool')
    return escalate('confirm.outside', 'writes outside a run worktree');
  if (pre.has('write-in-worktree') && a.inWorktree)
    return allow('confirm.worktree', 'write inside the run worktree, pre-authorised');
  return escalate('confirm.write', 'in-worktree write or read tool, not pre-authorised');
}

function checkMerge(policy: WritePolicy, a: Extract<ProposedAction, { kind: 'merge' }>): Verdict {
  if (a.targetIsDefaultBranch)
    return escalate('merge.default', 'merge into the default branch', 'merge-default-branch');
  if (policy.mode !== 'auto-merge')
    return escalate('merge.approval', 'merge waits for one-click Sponsor approval');
  const missing: string[] = [];
  if (!a.testsPassed) missing.push('tests');
  if (!a.criticApproved) missing.push('critic approval');
  if (!a.ciGreenForCommit) missing.push('CI for this commit');
  if (a.zonesTouched) missing.push('no zone touched');
  if (a.files > policy.limits.maxFiles) missing.push('file limit');
  if (a.lines > policy.limits.maxLines) missing.push('line limit');
  if (missing.length) return escalate('merge.conditions', `auto-merge needs ${missing.join(', ')}`);
  return allow('merge.auto', 'pre-authorised auto-merge: every condition holds');
}

function checkEnvelopeChange(
  current: Envelope,
  a: Extract<ProposedAction, { kind: 'envelope.change' }>,
): Verdict {
  const wider = widenings(current, a.proposed);
  if (wider.length)
    return escalate('envelope.widen', `widens: ${wider.join(', ')}`, 'widen-envelope');
  // Even a narrowing is an amendment of an approved charter: the machine records it as one.
  return allow('envelope.narrow', 'the proposal only narrows the envelope');
}

/** Every way `next` gives more room than `cur`. Empty means it only narrows or keeps. */
export function widenings(cur: Envelope, next: Envelope): string[] {
  const out: string[] = [];
  if (next.totalCapUsd > cur.totalCapUsd) out.push('total cap');
  if (cur.runCapUsd !== undefined && (next.runCapUsd ?? Infinity) > cur.runCapUsd)
    out.push('run cap');
  const pre = new Set(cur.preAnswer);
  if (next.preAnswer.some((p) => !pre.has(p))) out.push('pre-answers');
  if (writeWider(cur.write, next.write)) out.push('write policy');
  if (subscriptionsWider(cur, next)) out.push('subscriptions');
  if (cur.expires && (!next.expires || Date.parse(next.expires) > Date.parse(cur.expires)))
    out.push('expiry');
  return out;
}

function subscriptionsWider(cur: Envelope, next: Envelope): boolean {
  const more = (a: number | undefined, b: number | undefined): boolean =>
    b !== undefined && (a === undefined || a > b);
  return next.subscriptions.some((n) => {
    const c = cur.subscriptions.find((x) => x.provider === n.provider);
    return !c || more(n.runs ?? Infinity, c.runs) || more(n.hours ?? Infinity, c.hours);
  });
}

function writeWider(cur: WritePolicy, next: WritePolicy): boolean {
  if (next.mode === 'isolated-only') return false;
  if (cur.mode === 'isolated-only') return true;
  return next.limits.maxFiles > cur.limits.maxFiles || next.limits.maxLines > cur.limits.maxLines;
}
