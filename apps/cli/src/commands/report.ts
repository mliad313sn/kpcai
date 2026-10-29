/**
 * `kpai report …` and `kpai notify …` (R-5E8, R-5E9, ADR-0036). Reports are read from the
 * program's archive and shown made safe for the terminal (they quote model text). Channels
 * are read from `$KPAI_HOME/enterprise/channels.json`; only the names of the environment
 * variables that hold secrets are ever printed, with whether each is set. A test notice
 * carries no project data and is sent only after you confirm (or with --yes).
 */
import { EnterpriseRuntime, isLocal, refusal, type ChannelSpec } from '@kernelpai/enterprise';
import type { Kernel } from '@kernelpai/kernel';
import { sanitizeForTerminal as clean } from '../sanitize.js';
import type { Io } from '../io.js';
import { notRun, open } from './graph.js';

export interface ReportCliOptions {
  db?: string | undefined;
  yes?: boolean | undefined;
}

const USAGE = [
  'usage: kpai report list <program> | show <program> [<report-id>]',
  '       kpai notify list | test <channel> [--yes] | check',
  '',
].join('\n');

type Ctx = { io: Io; rt: EnterpriseRuntime; args: string[]; o: ReportCliOptions };

/**
 * "verified" is a delivery's word only (ADR-0031, P5-F7): any other report is "not a
 * delivery", whatever its flag says. `kpai program show` uses the same words.
 */
export function deliveryWord(r: { kind: string; verified: boolean }): string {
  if (r.kind !== 'final') return 'not a delivery';
  return r.verified ? 'verified' : 'not verified';
}

function list({ io, rt, args }: Ctx): number {
  const id = args[0];
  if (!id) return usage(io);
  const all = rt.get(id).meta.reports;
  if (!all.length) io.out('no reports yet\n');
  for (const r of all)
    io.out(
      `${r.reportId}  ${r.kind.padEnd(9)} ${r.at}  ${deliveryWord(r)}  ${r.channels.map(clean).join(',')}\n`,
    );
  return 0;
}

function show({ io, rt, args }: Ctx): number {
  const [id, reportId] = args;
  if (!id) return usage(io);
  const all = rt.reports(id);
  const r = reportId ? all.find((x) => x.reportId === reportId) : all.at(-1);
  if (!r) {
    io.err(reportId ? `no report ${clean(reportId)}\n` : 'no reports yet\n');
    return 1;
  }
  io.out(`${clean(r.markdown)}\n`);
  return 0;
}

function secrets(c: ChannelSpec, env: Io['env']): string {
  const names = [
    'userEnv' in c ? c.userEnv : undefined,
    'secretEnv' in c ? c.secretEnv : undefined,
  ].filter((x): x is string => !!x);
  return names.map((n) => `${n} ${env[n] ? 'set' : 'missing'}`).join(', ');
}

function channels({ io, rt }: Ctx): number {
  const f = rt.channels();
  io.out(`third-party channels ${f.allowThirdParty ? 'allowed' : 'refused (Q-11 default)'}\n`);
  for (const c of f.channels) {
    const why = refusal(c, f);
    const where = isLocal(c) ? 'local' : 'third-party';
    const secret = secrets(c, io.env);
    io.out(
      `${c.id.padEnd(12)} ${c.type.padEnd(9)} ${where.padEnd(11)} ${why ? `refused: ${why}` : 'on'}${c.summary ? ', summary' : ', counts only'}${secret ? `  [${secret}]` : ''}\n`,
    );
  }
  return 0;
}

async function test({ io, rt, args, o }: Ctx): Promise<number> {
  const id = args[0];
  if (!id) return usage(io);
  const c = rt.channels().channels.find((x) => x.id === id);
  if (!c) {
    io.err(`no channel ${clean(id)} in channels.json\n`);
    return 1;
  }
  const ask = `Send a test notice (no project data) to ${c.id} (${c.type})?`;
  if (!o.yes && !(await io.confirm(ask))) {
    io.err('not sent\n');
    return 1;
  }
  const [d] = await rt.notifyTest(id);
  if (d?.ok) {
    io.out(`${id}: sent (${d.status})\n`);
    return 0;
  }
  io.err(`${id}: not sent (${d?.status ?? 'refused'}, ${d?.attempts ?? 0} attempt(s))\n`);
  return 1;
}

async function check({ io, rt }: Ctx): Promise<number> {
  const status = await rt.deadManCheck();
  const text = {
    none: 'no heartbeat: the daemon has never run here',
    ok: 'daemon ok',
    alert: 'daemon alive, with alerts',
    stale: 'daemon silent: the channels were told',
  }[status];
  io.out(`${text}\n`);
  return status === 'stale' ? 1 : 0;
}

function usage(io: Io): number {
  io.err(USAGE);
  return 2;
}

async function withRuntime(
  io: Io,
  o: ReportCliOptions,
  fn: (rt: EnterpriseRuntime) => number | Promise<number>,
): Promise<number> {
  const kernel: Kernel = open(io, o);
  const rt = new EnterpriseRuntime({ kernel, env: io.env });
  try {
    return await fn(rt);
  } catch (err) {
    return notRun(io, err);
  } finally {
    await rt.close();
    await kernel.close();
  }
}

const REPORT: Record<string, (c: Ctx) => number | Promise<number>> = { list, show };
const NOTIFY: Record<string, (c: Ctx) => number | Promise<number>> = {
  list: channels,
  test,
  check,
};

function dispatch(
  table: typeof REPORT,
  io: Io,
  rest: readonly string[],
  o: ReportCliOptions,
): Promise<number> {
  const [sub, ...args] = rest;
  const run = sub ? table[sub] : undefined;
  if (!run) return Promise.resolve(usage(io));
  return withRuntime(io, o, (rt) => run({ io, rt, args, o }));
}

export function reportCommand(
  io: Io,
  rest: readonly string[],
  o: ReportCliOptions,
): Promise<number> {
  return dispatch(REPORT, io, rest, o);
}

export function notifyCommand(
  io: Io,
  rest: readonly string[],
  o: ReportCliOptions,
): Promise<number> {
  return dispatch(NOTIFY, io, rest, o);
}
