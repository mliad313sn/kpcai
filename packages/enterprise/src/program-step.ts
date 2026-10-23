/**
 * One program, one tick (ADR-0035), inside the store lock: start an approved program, act
 * on the Sponsor's answers, apply the S10 R3 safeguards (envelope expiry, progress-gated
 * burn), open the gate when every work package is done, and list what needs a run. The PO
 * acts only through the machine's events; the Sponsor's yes is the only way past a pause.
 */
import {
  charterHash,
  effectiveExpiry,
  envelopeExpired,
  expiryFrom,
  noProgress,
  reviewRequest,
  type ProgramState,
} from '@kernelpai/program';
import { newId } from './confirm-gate.js';
import type { Ctx } from './context.js';
import type { ProgramMeta, Ref } from './meta.js';
import { writeReport } from './reports.js';

export interface Need {
  programId: string;
  wpId: string;
  purpose: 'work' | 'review';
  request: string;
}

const MAX_ATTEMPTS = 3;
type Kind = ProgramMeta['escalations'][string]['kind'];

function apply(c: Ctx, id: string, event: unknown, actor: 'po' | 'sponsor' | 'kernel', now: Date) {
  const t = c.store.applyLocked(id, event, actor, now);
  if (t.ok) c.feed.notify('enterprise.program', { programId: id, status: t.state.status });
  return t;
}

/** Pauses the program (PO) and asks the Sponsor, once per open question of this rule. */
export function pauseFor(
  c: Ctx,
  id: string,
  now: Date,
  q: {
    kind: Kind;
    rule: string;
    question: string;
    evidence?: Ref[];
    extra?: { renewTo?: string; checkpoint?: number };
  },
): void {
  const { state } = c.store.read(id);
  if (state.escalations.some((e) => e.rule === q.rule && !e.answer)) return;
  if (state.status !== 'paused') apply(c, id, { type: 'pause' }, 'po', now);
  const escId = newId('esc');
  const t = apply(
    c,
    id,
    {
      type: 'escalate',
      escalation: { id: escId, at: now.toISOString(), rule: q.rule, question: q.question },
    },
    'po',
    now,
  );
  if (!t.ok) return;
  c.store.updateMeta(id, (m) => {
    m.escalations[escId] = { kind: q.kind, evidence: q.evidence ?? [], ...(q.extra ?? {}) };
    m.pausedReason = q.question.slice(0, 500);
  });
  c.fact(id, { action: 'program paused by a safeguard', rule: q.rule, escalationId: escId });
  c.feed.notify('enterprise.inbox', { programId: id, escalationId: escId, state: 'open' });
  c.feed.line(`paused: ${q.rule}`, id, [{ kind: 'escalation', id: escId }], now);
}

function resumeByPo(c: Ctx, id: string, now: Date): void {
  const { state } = c.store.read(id);
  if (state.status === 'paused' && state.pausedBy === 'po')
    apply(c, id, { type: 'resume' }, 'po', now);
  c.store.updateMeta(id, (m) => void delete m.pausedReason);
}

/** S10 R3: expiry renewal; the Sponsor's yes approves exactly the amended charter hash. */
function renew(c: Ctx, id: string, renewTo: string | undefined, now: Date): void {
  const { state } = c.store.read(id);
  if (!renewTo || Date.parse(renewTo) <= now.getTime()) return;
  const charter = { ...state.charter, envelope: { ...state.charter.envelope, expires: renewTo } };
  if (!apply(c, id, { type: 'amend', charter }, 'po', now).ok) return;
  const hash = charterHash(c.store.read(id).state.amendment!);
  if (apply(c, id, { type: 'amend.approve', charterHash: hash }, 'sponsor', now).ok)
    resumeByPo(c, id, now);
}

function gateVerdict(c: Ctx, id: string, escId: string, yes: boolean, now: Date): void {
  const { state } = c.store.read(id);
  const phase = state.charter.phases[state.phaseIndex];
  const review = state.runs
    .filter((r) => r.phaseId === phase?.id && r.purpose === 'review' && r.status === 'finished')
    .at(-1);
  const reviewer = state.charter.seats.find((s) => s.kind === 'reviewer');
  if (!phase || !review || !reviewer) return;
  const record = {
    phaseId: phase.id,
    verdict: yes ? 'pass' : 'hold',
    reviewer: reviewer.id,
    reviewerProvider: review.providers[0] ?? 'unknown',
    openCriticalOrHigh: 0,
    evidence: [`run:${review.runId}`, `escalation:${escId}`],
    at: now.toISOString(),
  };
  const t = apply(c, id, { type: 'gate.close', record }, 'po', now);
  if (!t.ok || !yes) {
    const why = t.ok ? 'the Sponsor held the gate' : t.reason;
    c.feed.line(`gate ${phase.id} not passed: ${why}`, id, [], now);
    if (t.ok || state.status === 'gate')
      pauseFor(c, id, now, {
        kind: 'gate',
        rule: 'gate.held',
        question: `Phase ${phase.id} is held (${why}). Amend the plan, then resume.`,
      });
    return;
  }
  c.feed.line(`gate ${phase.id} passed`, id, [{ kind: 'run', id: review.runId }], now);
  if (t.state.status === 'delivered') writeReport(c, id, 'final', now);
}

/** Acts once on each answered question the runtime raised. */
function followUps(c: Ctx, id: string, now: Date): void {
  const { state, meta } = c.store.read(id);
  for (const [escId, info] of Object.entries(meta.escalations)) {
    const e = state.escalations.find((x) => x.id === escId);
    if (info.handled || !e?.answer) continue;
    c.store.updateMeta(id, (m) => void (m.escalations[escId]!.handled = true));
    const yes = e.answer === 'yes';
    if (info.kind === 'progress' && yes) {
      const phaseId = state.charter.phases[state.phaseIndex]?.id ?? '';
      c.store.updateMeta(id, (m) => void (m.progressAck[phaseId] = info.checkpoint ?? 0));
      resumeByPo(c, id, now);
    } else if (info.kind === 'expiry' && yes) renew(c, id, info.renewTo, now);
    else if (info.kind === 'gate' && e.rule === 'gate.pass') gateVerdict(c, id, escId, yes, now);
  }
}

function safeguards(c: Ctx, id: string, s: ProgramState, now: Date): boolean {
  if (envelopeExpired(s, now)) {
    const renewTo = expiryFrom(now);
    const was = effectiveExpiry(s)?.toISOString() ?? '?';
    const question = `The delegation envelope expired (${was}). Renew it until ${renewTo}?`;
    pauseFor(c, id, now, {
      kind: 'expiry',
      rule: 'envelope.expired',
      question,
      extra: { renewTo },
    });
    return true;
  }
  const phaseId = s.charter.phases[s.phaseIndex]?.id ?? '';
  const p = noProgress(s, c.store.read(id).meta.progressAck[phaseId] ?? 0);
  if (!p) return false;
  const spent = `${p.checkpoint * 25}% of the ${p.phaseId} cap ($${p.spentUsd.toFixed(2)} of $${p.capUsd.toFixed(2)})`;
  const question = `${spent} is spent with ${p.verified} verified result(s). Continue?`;
  pauseFor(c, id, now, {
    kind: 'progress',
    rule: 'progress.none',
    question,
    extra: { checkpoint: p.checkpoint },
  });
  return true;
}

/** Work packages of the current phase that need a run now. */
function workNeeds(c: Ctx, s: ProgramState, busy: (wpId: string) => boolean): Need[] {
  const phase = s.charter.phases[s.phaseIndex];
  const out: Need[] = [];
  for (const wp of phase?.workPackages ?? []) {
    const runs = s.runs.filter((r) => r.wpId === wp.id);
    if (runs.some((r) => r.status === 'running' || r.status === 'finished') || busy(wp.id))
      continue;
    const last = s.escalations.filter((e) => e.subject?.wpId === wp.id).at(-1);
    if (last && (!last.answer || last.answer === 'no')) continue;
    if (runs.length >= MAX_ATTEMPTS) continue;
    out.push({ programId: s.charter.programId, wpId: wp.id, purpose: 'work', request: wp.request });
  }
  return out;
}

function reviewStep(
  c: Ctx,
  id: string,
  s: ProgramState,
  busy: (wpId: string) => boolean,
  now: Date,
): Need[] {
  const phase = s.charter.phases[s.phaseIndex]!;
  // After a hold, only reviews started since count: the phase is reviewed again.
  const held = s.gates.filter((g) => g.phaseId === phase.id && g.verdict === 'hold').at(-1)?.at;
  const reviews = s.runs.filter(
    (r) => r.phaseId === phase.id && r.purpose === 'review' && (!held || r.startedAt > held),
  );
  const done = reviews.filter((r) => r.status === 'finished').at(-1);
  if (done) {
    const asked = Object.values(c.store.read(id).meta.escalations);
    if (asked.some((x) => x.kind === 'gate' && x.runId === done.runId)) return [];
    const question = `Phase ${phase.id}: the independent review run ${done.runId} finished (${done.assurance ?? 'V0'}, on ${done.providers.join(', ') || '?'}). Pass the gate? Say yes only if it lists no open Critical or High finding.`;
    const escId = newId('esc');
    const t = apply(
      c,
      id,
      {
        type: 'escalate',
        escalation: { id: escId, at: now.toISOString(), rule: 'gate.pass', question },
      },
      'po',
      now,
    );
    if (t.ok) {
      c.store.updateMeta(
        id,
        (m) =>
          void (m.escalations[escId] = {
            kind: 'gate',
            runId: done.runId,
            evidence: [{ kind: 'run', id: done.runId }],
          }),
      );
      c.feed.notify('enterprise.inbox', { programId: id, escalationId: escId, state: 'open' });
    }
    return [];
  }
  if (
    reviews.some((r) => r.status === 'running') ||
    busy(phase.id) ||
    reviews.length >= MAX_ATTEMPTS
  )
    return [];
  return [{ programId: id, wpId: phase.id, purpose: 'review', request: reviewRequest(s) }];
}

/** Everything one tick does for one program; returns the runs it needs. Inside `locked`. */
export function stepProgram(
  c: Ctx,
  id: string,
  now: Date,
  busy: (wpId: string) => boolean,
  killed: boolean,
): Need[] {
  if (c.store.read(id).state.status === 'approved') apply(c, id, { type: 'start' }, 'po', now);
  followUps(c, id, now);
  let s = c.store.read(id).state;
  if (killed || (s.status !== 'running' && s.status !== 'gate')) return [];
  if (safeguards(c, id, s, now)) return [];
  const phase = s.charter.phases[s.phaseIndex];
  const allDone = phase?.workPackages.every((wp) =>
    s.runs.some((r) => r.wpId === wp.id && r.status === 'finished'),
  );
  if (s.status === 'running' && allDone && !s.runs.some((r) => r.status === 'running')) {
    if (apply(c, id, { type: 'gate.open' }, 'po', now).ok) writeReport(c, id, 'gate', now);
    s = c.store.read(id).state;
  }
  if (s.status === 'gate') return reviewStep(c, id, s, busy, now);
  return workNeeds(c, s, busy);
}
