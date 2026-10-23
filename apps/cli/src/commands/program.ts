/**
 * `kpai program …` (design §3, §14; ADR-0035): goals run as programs by the Enterprise
 * daemon (`kpai serve --headless`). You are the Sponsor: you approve a charter by its hash,
 * pause, resume, stop, and answer questions. A consequential question shows its evidence
 * before it can be answered (S10 R8); trivial ones may be answered together. Text a model
 * wrote (critique, questions) is shown quoted and made safe for the terminal.
 */
import { EnterpriseRuntime, readHeartbeat, HEARTBEAT_FILE } from '@kernelpai/enterprise';
import type { Kernel } from '@kernelpai/kernel';
import { approvalClass } from '@kernelpai/program';
import { sanitizeForTerminal as clean } from '../sanitize.js';
import type { Io } from '../io.js';
import { notRun, open } from './graph.js';

export interface ProgramCliOptions {
  db?: string | undefined;
  budgetUsd?: number | undefined;
  departments?: boolean | undefined;
  critic?: boolean | undefined;
  trivial?: boolean | undefined;
  check?: boolean | undefined;
  allowTest?: boolean | undefined;
}

const USAGE = [
  'usage: kpai program new <goal> [--budget N] [--departments] [--no-critic]',
  '       kpai program list | show <id> | approve <id> [<hash>] | pause|resume|stop <id>',
  '       kpai program inbox [<id>] | answer <id> <question> yes|no | answer <id> --trivial yes|no',
  '       kpai program heartbeat [--check]',
  '',
].join('\n');

const quote = (text: string): string =>
  clean(text)
    .split('\n')
    .map((l) => `    > ${l}`)
    .join('\n');

type Ctx = { io: Io; rt: EnterpriseRuntime; args: string[]; o: ProgramCliOptions };

async function create({ io, rt, args, o }: Ctx): Promise<number> {
  const goal = args.join(' ').trim();
  if (!goal) return usage(io);
  const d = await rt.create({
    goal,
    ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
    ...(o.departments ? { departments: true } : {}),
    ...(o.critic === false ? { critic: false } : {}),
  });
  const c = d.charter;
  io.out(`program ${d.programId} (draft, proposed to you)\n`);
  io.out(`  team: ${c.seats.map((s) => clean(s.title)).join(', ')}\n`);
  for (const wp of c.phases.flatMap((p) => p.workPackages))
    io.out(`  ${wp.id}: ${clean(wp.title)}\n`);
  io.out(
    `  cap $${c.envelope.totalCapUsd.toFixed(2)}; as one run: likely $${d.baseline.expectedUsd.toFixed(2)}, up to $${d.baseline.capUsd.toFixed(2)} (rough)\n`,
  );
  io.out(
    `  envelope expires ${c.envelope.expires ?? '-'}; pre-answers: ${c.envelope.preAnswer.join(', ')}\n`,
  );
  io.out(
    `  critique (${d.critique.status}, ${d.critique.providers.join(', ') || 'no provider'}; model text):\n${quote(d.critique.text.slice(0, 1_500))}\n`,
  );
  io.out(
    `charter ${d.charterHash}\napprove: kpai program approve ${d.programId} ${d.charterHash}\n`,
  );
  return 0;
}

function list({ io, rt }: Ctx): number {
  const all = rt.list();
  if (!all.length) io.out('no programs\n');
  for (const p of all)
    io.out(
      `${p.programId.padEnd(14)} ${p.status.padEnd(10)} ${p.health.padEnd(9)} ${clean(p.goal.split('\n')[0] ?? '').slice(0, 60)}\n`,
    );
  return 0;
}

function show({ io, rt, args }: Ctx): number {
  const s = rt.get(args[0] ?? '');
  io.out(
    `${s.charter.programId}: ${s.status}, phase ${s.phaseIndex + 1}/${s.charter.phases.length}, charter ${s.charterHash.slice(0, 16)}\n`,
  );
  io.out(`goal:\n${quote(s.charter.goal)}\n`);
  for (const r of s.runs)
    io.out(
      `  ${r.wpId.padEnd(6)} ${r.runId.slice(0, 8)} ${r.status.padEnd(9)} $${r.costUsd.toFixed(4)} ${r.assurance ?? 'V0'} ${clean(s.meta.runs[r.runId]?.basis ?? '')}\n`,
    );
  if (s.meta.pausedReason) io.out(`paused: ${clean(s.meta.pausedReason)}\n`);
  for (const r of s.meta.reports)
    io.out(`report ${r.reportId} ${r.kind} ${r.at}${r.verified ? '' : ' (not verified)'}\n`);
  return 0;
}

async function approve({ io, rt, args }: Ctx): Promise<number> {
  const [id, given] = args;
  const s = rt.get(id ?? '');
  const hash = given ?? s.charterHash;
  if (
    !given &&
    !(await io.confirm(
      `Approve charter ${hash.slice(0, 16)} of ${s.charter.programId} (cap $${s.charter.envelope.totalCapUsd.toFixed(2)})?`,
    ))
  ) {
    io.err('not approved\n');
    return 1;
  }
  await rt.sponsor.act(s.charter.programId, { type: 'approve', charterHash: hash });
  io.out(`approved ${s.charter.programId}: the daemon starts it (kpai serve --headless)\n`);
  return 0;
}

async function steer({ io, rt, args }: Ctx, type: 'pause' | 'resume' | 'stop'): Promise<number> {
  const id = args[0] ?? '';
  if (type === 'stop') await rt.sponsor.stop(id, 'stopped by the Sponsor');
  else await rt.sponsor.act(id, { type });
  io.out(`${id}: ${rt.get(id).status}\n`);
  return 0;
}

function inbox({ io, rt, args }: Ctx): number {
  const items = rt.snapshot().inbox.filter((i) => !args[0] || i.programId === args[0]);
  if (!items.length) io.out('nothing waits for you\n');
  for (const i of items) {
    io.out(
      `${i.programId} ${i.escalationId} [${i.class}] ${i.rule} asked ${i.askedAt}\n${quote(i.question)}\n`,
    );
  }
  return 0;
}

/** Shows what a question rests on, and records that you opened it (S10 R6 J2). */
async function evidence(c: Ctx, id: string, escId: string): Promise<void> {
  const s = c.rt.get(id);
  const e = s.escalations.find((x) => x.id === escId);
  if (!e) return;
  c.io.out(`--- ${escId} (${e.rule}) evidence\n${quote(e.question)}\n`);
  if (e.subject) c.io.out(`  one run of ${e.subject.wpId} up to $${e.subject.capUsd.toFixed(2)}\n`);
  for (const ref of s.meta.escalations[escId]?.evidence ?? []) {
    const r = s.runs.find((x) => x.runId === ref.id);
    c.io.out(
      `  ${ref.kind} ${ref.id}${r ? `: ${r.status}, $${r.costUsd.toFixed(4)}, ${r.assurance ?? 'V0'}, ${r.providers.join(', ')}` : ''}\n`,
    );
    if (ref.kind === 'run' && r) await c.rt.sponsor.viewed(id, ref);
  }
  await c.rt.sponsor.viewed(id, { kind: 'escalation', id: escId }, escId);
}

async function answer(c: Ctx): Promise<number> {
  const [id, escOrAnswer, maybe] = c.args;
  if (c.o.trivial) return trivial(c, id ?? '', escOrAnswer);
  const ans = maybe;
  if (!id || !escOrAnswer || (ans !== 'yes' && ans !== 'no')) return usage(c.io);
  const e = c.rt.get(id).escalations.find((x) => x.id === escOrAnswer);
  if (e && approvalClass(e) === 'consequential') {
    await evidence(c, id, escOrAnswer);
    if (!(await c.io.confirm(`Answer ${ans} to ${escOrAnswer}?`))) return 1;
  }
  await c.rt.sponsor.answer(id, escOrAnswer, ans);
  c.io.out(`${escOrAnswer}: ${ans}\n`);
  return 0;
}

async function trivial(c: Ctx, id: string, ans: string | undefined): Promise<number> {
  if (ans !== 'yes' && ans !== 'no') return usage(c.io);
  const ids = c.rt
    .snapshot()
    .inbox.filter((i) => i.programId === id && i.class === 'trivial')
    .map((i) => i.escalationId);
  if (!ids.length) {
    c.io.out('no trivial question waits\n');
    return 0;
  }
  const r = await c.rt.sponsor.answerBatch(id, ids, ans);
  c.io.out(`answered ${r.answered.length} trivial question(s) ${ans}\n`);
  return 0;
}

function heartbeat({ io, rt, o }: Ctx): number {
  const hb = readHeartbeat(rt.store.path(HEARTBEAT_FILE), new Date());
  if (!hb) {
    io.out('no heartbeat: the daemon has never run here\n');
    return o.check ? 1 : 0;
  }
  io.out(
    `daemon ${hb.status} at ${hb.at} (every ${hb.intervalSec}s, stale after ${hb.staleAfterSec}s), ${hb.running} run(s)\n`,
  );
  for (const a of hb.alerts) io.out(`  alert ${a.rule}: ${clean(a.text)}\n`);
  return o.check && hb.status !== 'ok' ? 1 : 0;
}

function usage(io: Io): number {
  io.err(USAGE);
  return 2;
}

const SUBS: Record<string, (c: Ctx) => number | Promise<number>> = {
  new: create,
  list,
  show,
  approve,
  pause: (c) => steer(c, 'pause'),
  resume: (c) => steer(c, 'resume'),
  stop: (c) => steer(c, 'stop'),
  inbox,
  answer,
  heartbeat,
};

export async function programCommand(
  io: Io,
  rest: readonly string[],
  o: ProgramCliOptions,
): Promise<number> {
  const [sub, ...args] = rest;
  const run = sub ? SUBS[sub] : undefined;
  if (!run) return usage(io);
  const kernel: Kernel = open(io, o);
  const rt = new EnterpriseRuntime({
    kernel,
    env: io.env,
    options: o.allowTest ? { allowTest: true } : {},
  });
  try {
    return await run({ io, rt, args, o });
  } catch (err) {
    return notRun(io, err);
  } finally {
    await rt.close();
    await kernel.close();
  }
}
