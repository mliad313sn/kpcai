/**
 * The program state machine (ADR-0031 §2): draft → proposed → approved → running phase N
 * → gate → … → delivered, with paused and stopped from anywhere live. Pure: one event in,
 * a new state or a refusal out. The host persists the state and journals every event, so
 * a program resumes after a restart from its last state (R-507).
 */
import { checkAction } from './envelope.js';
import {
  EVENT_ACTORS,
  ProgramEventSchema,
  type MachineActor,
  type ProgramEvent,
} from './events.js';
import { charterHash } from './ledger.js';
import {
  CharterSchema,
  ProgramStateSchema,
  type Charter,
  type ProgramState,
  type ProgramStatus,
} from './schemas.js';

export type Transition = { ok: true; state: ProgramState } | { ok: false; reason: string };
type Ev<T extends ProgramEvent['type']> = Extract<ProgramEvent, { type: T }>;
type Ctx = { actor: MachineActor; now: Date };
type Handler<T extends ProgramEvent['type']> = (s: ProgramState, e: Ev<T>, c: Ctx) => Transition;

const no = (reason: string): Transition => ({ ok: false, reason });
const ok = (state: ProgramState): Transition => ({ ok: true, state });
const LIVE: ReadonlySet<ProgramStatus> = new Set(['approved', 'running', 'gate']);
const ENDED: ReadonlySet<ProgramStatus> = new Set(['stopped', 'delivered']);

/** A new program in `draft`, around a charter the PO assistant drafted. */
export function newProgram(charter: unknown, now: Date): ProgramState {
  return ProgramStateSchema.parse({
    version: 1,
    status: 'draft',
    charter: CharterSchema.parse(charter),
    updatedAt: now.toISOString(),
  });
}

/** Applies one event. Never throws on bad input: an unknown event is a refusal. */
export function transition(
  state: ProgramState,
  input: unknown,
  actor: MachineActor,
  now: Date,
): Transition {
  const parsed = ProgramEventSchema.safeParse(input);
  if (!parsed.success) return no('the event does not parse');
  const e = parsed.data;
  if (!EVENT_ACTORS[e.type].includes(actor)) return no(`${actor} may not send ${e.type}`);
  const handler = HANDLERS[e.type] as Handler<typeof e.type>;
  const r = handler(state, e as never, { actor, now });
  return r.ok ? ok({ ...r.state, updatedAt: now.toISOString() }) : r;
}

function parseCharter(input: unknown): Charter | string {
  const c = CharterSchema.safeParse(input);
  return c.success ? c.data : `invalid charter: ${c.error.issues[0]?.message ?? 'unknown'}`;
}

const propose: Handler<'propose'> = (s, e) => {
  if (s.status !== 'draft' && s.status !== 'proposed') return no(`cannot propose in ${s.status}`);
  const c = parseCharter(e.charter);
  if (typeof c === 'string') return no(c);
  return ok({ ...s, status: 'proposed', charter: c, approval: undefined });
};

const approve: Handler<'approve'> = (s, e, c) => {
  if (s.status !== 'proposed') return no(`nothing to approve in ${s.status}`);
  if (e.charterHash !== charterHash(s.charter)) return no('the approval is for another charter');
  return ok({
    ...s,
    status: 'approved',
    approval: { charterHash: e.charterHash, at: c.now.toISOString() },
  });
};

const runStarted: Handler<'run.started'> = (s, e, c) => {
  const r = e.run;
  if (r.status !== 'running') return no('a started run is running');
  if (s.runs.some((x) => x.runId === r.runId)) return no(`run ${r.runId} is already recorded`);
  // Defence in depth: the kernel's start is checked against the envelope again here.
  const v = checkAction(
    s,
    {
      kind: 'run.start',
      wpId: r.wpId,
      capUsd: r.capUsd,
      isolated: true,
      purpose: r.purpose,
      source: r.source,
      providers: r.providers,
    },
    c.now,
  );
  if (v.verdict === 'refuse') return no(v.reason);
  if (r.phaseId !== s.charter.phases[s.phaseIndex]?.id) return no('run outside the current phase');
  if (v.verdict === 'allow') return ok({ ...s, runs: [...s.runs, r] });
  const yes = sponsorYes(s, v.rule, r.wpId, r.capUsd);
  if (!yes) return no(`needs the Sponsor: ${v.reason}`);
  const escalations = s.escalations.map((x) => (x.id === yes ? { ...x, consumed: true } : x));
  return ok({ ...s, runs: [...s.runs, r], escalations });
};

/** An unused Sponsor yes for exactly this rule, work package and at least this band top. */
export function sponsorYes(
  s: ProgramState,
  rule: string,
  wpId: string,
  cap: number,
): string | undefined {
  return s.escalations.find(
    (x) =>
      x.rule === rule &&
      x.answer === 'yes' &&
      !x.consumed &&
      x.subject?.wpId === wpId &&
      x.subject.capUsd >= cap,
  )?.id;
}

const runSettled: Handler<'run.settled'> = (s, e, c) => {
  const run = s.runs.find((r) => r.runId === e.runId);
  if (!run || run.status !== 'running') return no(`no running run ${e.runId}`);
  const settled = {
    ...run,
    status: e.status,
    costUsd: e.costUsd,
    testsPassed: e.testsPassed,
    hours: e.hours ?? run.hours,
    evidence: [...run.evidence, ...e.evidence],
    settledAt: c.now.toISOString(),
    ...(e.assurance ? { assurance: e.assurance } : {}),
  };
  return ok({ ...s, runs: s.runs.map((r) => (r.runId === e.runId ? settled : r)) });
};

const gateOpen: Handler<'gate.open'> = (s) => {
  if (s.status !== 'running') return no(`no gate from ${s.status}`);
  const phase = s.charter.phases[s.phaseIndex]!;
  const missing = phase.workPackages.filter(
    (wp) => !s.runs.some((r) => r.wpId === wp.id && r.status === 'finished'),
  );
  if (missing.length) return no(`unfinished: ${missing.map((w) => w.id).join(', ')}`);
  if (s.runs.some((r) => r.phaseId === phase.id && r.status === 'running'))
    return no('runs are still live');
  return ok({ ...s, status: 'gate' });
};

const gateClose: Handler<'gate.close'> = (s, e) => {
  if (s.status !== 'gate') return no(`no gate open (${s.status})`);
  const phase = s.charter.phases[s.phaseIndex]!;
  const g = e.record;
  if (g.phaseId !== phase.id) return no('the verdict is for another phase');
  const seat = s.charter.seats.find((x) => x.id === g.reviewer);
  if (seat?.kind !== 'reviewer') return no('the reviewer is not a reviewer seat');
  const gates = [...s.gates, g];
  if (g.verdict === 'hold') return ok({ ...s, status: 'running', gates });
  const why = passBlocker(s, g);
  if (why) return no(why);
  const last = s.phaseIndex + 1 >= s.charter.phases.length;
  return ok({
    ...s,
    gates,
    status: last ? 'delivered' : 'running',
    phaseIndex: last ? s.phaseIndex : s.phaseIndex + 1,
  });
};

/** Why a pass verdict cannot close the gate (charter §4), or undefined. */
function passBlocker(s: ProgramState, g: ProgramState['gates'][number]): string | undefined {
  if (g.openCriticalOrHigh > 0) return 'Critical/High findings are still open';
  if (!g.evidence.length) return 'a pass needs journal evidence';
  const runs = s.runs.filter((r) => r.phaseId === g.phaseId);
  const review = runs.find((r) => r.purpose === 'review' && r.status === 'finished');
  if (!review) return 'no finished independent review run for this phase';
  const builders = new Set(runs.filter((r) => r.purpose === 'work').flatMap((r) => r.providers));
  if (builders.has(g.reviewerProvider)) return 'the reviewer shares a provider with a builder';
  return undefined;
}

const pause: Handler<'pause'> = (s, _e, c) => {
  if (!LIVE.has(s.status)) return no(`cannot pause in ${s.status}`);
  return ok({ ...s, status: 'paused', pausedFrom: s.status, pausedBy: actorOf(c) });
};

const resume: Handler<'resume'> = (s, _e, c) => {
  if (s.status !== 'paused' || !s.pausedFrom) return no('not paused');
  if (s.pausedBy === 'sponsor' && c.actor !== 'sponsor') return no('the Sponsor paused it');
  return ok({ ...s, status: s.pausedFrom, pausedFrom: undefined, pausedBy: undefined });
};

const stop: Handler<'stop'> = (s) =>
  ENDED.has(s.status) ? no(`already ${s.status}`) : ok({ ...s, status: 'stopped' });

const amend: Handler<'amend'> = (s, e) => {
  if (!s.approval || ENDED.has(s.status)) return no(`no amendment in ${s.status}`);
  const c = parseCharter(e.charter);
  if (typeof c === 'string') return no(c);
  if (c.programId !== s.charter.programId) return no('an amendment keeps the program id');
  return ok({ ...s, amendment: c });
};

const amendApprove: Handler<'amend.approve'> = (s, e, c) => {
  if (!s.amendment) return no('no amendment pending');
  if (e.charterHash !== charterHash(s.amendment)) return no('the approval is for another text');
  if (s.amendment.phases.length <= s.phaseIndex) return no('the amendment drops the current phase');
  const approval = { charterHash: e.charterHash, at: c.now.toISOString() };
  return ok({ ...s, charter: s.amendment, amendment: undefined, approval });
};

const decide: Handler<'decide'> = (s, e, c) => {
  if (e.decision.actor !== c.actor) return no('a decision is signed by who sent it');
  if (s.decisions.some((d) => d.id === e.decision.id)) return no('duplicate decision id');
  return ok({ ...s, decisions: [...s.decisions, e.decision] });
};

const escalate: Handler<'escalate'> = (s, e) => {
  const x = e.escalation;
  if (x.answer || x.answeredAt || x.consumed) return no('only the Sponsor answers');
  if (s.escalations.some((y) => y.id === x.id)) return no('duplicate escalation id');
  return ok({ ...s, escalations: [...s.escalations, x] });
};

const answer: Handler<'answer'> = (s, e, c) => {
  const x = s.escalations.find((y) => y.id === e.id);
  if (!x || x.answer) return no(`no open escalation ${e.id}`);
  const done = { ...x, answer: e.answer, answeredAt: c.now.toISOString() };
  return ok({ ...s, escalations: s.escalations.map((y) => (y.id === e.id ? done : y)) });
};

function actorOf(c: Ctx): 'sponsor' | 'po' {
  return c.actor === 'sponsor' ? 'sponsor' : 'po';
}

const HANDLERS: { [T in ProgramEvent['type']]: Handler<T> } = {
  propose,
  approve,
  reject: (s) => (s.status === 'proposed' ? ok({ ...s, status: 'draft' }) : no('not proposed')),
  start: (s) =>
    s.status === 'approved' ? ok({ ...s, status: 'running', phaseIndex: 0 }) : no('not approved'),
  'run.started': runStarted,
  'run.settled': runSettled,
  'gate.open': gateOpen,
  'gate.close': gateClose,
  pause,
  resume,
  stop,
  amend,
  'amend.approve': amendApprove,
  'amend.reject': (s) => (s.amendment ? ok({ ...s, amendment: undefined }) : no('none pending')),
  decide,
  escalate,
  answer,
  reported: (s, _e, c) => ok({ ...s, lastReportAt: c.now.toISOString() }),
};
