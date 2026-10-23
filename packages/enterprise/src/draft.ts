/**
 * A charter from a goal (design §3, S10 R7, R10; ADR-0035). The kernel planner plans the
 * goal as one ordinary run: that plan's band is the "do it as one run" baseline shown next
 * to the program's cap. The work packages come from the planner's graph (model planner) or
 * from the goal's own list (template planner). The default is one small team. Then a critic
 * on a provider that would build nothing reviews the charter; its text is model output,
 * kept quoted, never parsed. Nothing runs for the program until the Sponsor approves.
 */
import { randomBytes } from 'node:crypto';
import { plannedSources, type Kernel, type Plan } from '@kernelpai/kernel';
import {
  charterHash,
  newProgram,
  smallTeamCharter,
  transition,
  workPackagesFromGoal,
  type Cadence,
  type Charter,
  type DraftWorkPackage,
  type Locale,
} from '@kernelpai/program';
import type { Ctx } from './context.js';
import { newMeta, type ProgramMeta } from './meta.js';
import { soloGraph } from './solo.js';

export interface DraftInput {
  goal: string;
  locale?: Locale;
  budgetUsd?: number;
  cadence?: Cadence;
  departments?: boolean;
  /** False skips the charter critic (it is a paid run). */
  critic?: boolean;
}

export interface Drafted {
  programId: string;
  charter: Charter;
  charterHash: string;
  baseline: NonNullable<ProgramMeta['baseline']>;
  critique: NonNullable<ProgramMeta['critique']>;
}

const round2 = (n: number): number => Math.ceil(n * 100) / 100;

function fromGraph(goal: string, p: Plan): DraftWorkPackage[] {
  return p.graph.nodes.slice(0, 30).map((n) => ({
    title: n.title,
    request: `${n.title}\n\nPart of the program goal:\n${goal.slice(0, 3_000)}`,
  }));
}

/** Room for every work package and the gate review at the baseline's band top, plus half. */
export function defaultBudget(baselineCap: number, wps: number): number {
  return Math.max(1, round2(baselineCap * (wps + 1) * 1.5));
}

function critiqueRequest(c: Charter): string {
  const wps = c.phases.flatMap((p) => p.workPackages.map((w) => `- ${w.id}: ${w.title}`));
  return [
    'Critique this program charter before its Sponsor approves it. Look for scope creep,',
    'missing risks and over-staffing. Answer in under 150 words, as a list.',
    `Goal: ${c.goal}`,
    `Team: ${c.seats.map((s) => s.title).join(', ')}`,
    `Work packages:\n${wps.join('\n')}`,
    `Budget cap: $${c.envelope.totalCapUsd.toFixed(2)}; envelope expires ${c.envelope.expires ?? 'never'}`,
  ].join('\n');
}

/** A critic run that excludes every provider the plan would build with (S10 R10). */
async function critique(c: Ctx, charter: Charter, builders: string[], sessionId: string) {
  const request = critiqueRequest(charter);
  const options = {
    ...c.options,
    exclude: [...new Set([...(c.options.exclude ?? []), ...builders])],
    isolated: false,
  };
  try {
    const p = await c.kernel.plan(request, options, sessionId);
    // One critic, one answer: a single solo node whatever the template made of the text.
    const graph = soloGraph(p, 'Charter critique', request);
    const h = await c.kernel.startRun({ request, planId: p.planId, graph, options });
    const o = await h.done;
    if (o.status !== 'finished')
      return {
        status: 'failed' as const,
        providers: [],
        text: o.reason.slice(0, 4_000),
        runId: h.runId,
      };
    const providers = o.providers ?? [];
    const text = Object.values(o.result.results ?? {})
      .map((r) => r.output)
      .join('\n\n');
    if (providers.some((x) => builders.includes(x)))
      return {
        status: 'failed' as const,
        providers,
        text: 'not independent: the critic shares a provider with the builders',
        runId: h.runId,
      };
    return { status: 'done' as const, providers, text: text.slice(0, 4_000), runId: h.runId };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { status: 'failed' as const, providers: [], text: why.slice(0, 4_000) };
  }
}

function kindOf(p: Plan, provider: string): string | undefined {
  try {
    return p.setup.registry.get(provider).descriptor.kind;
  } catch {
    return undefined;
  }
}

export async function draftProgram(c: Ctx, kernel: Kernel, input: DraftInput): Promise<Drafted> {
  const now = c.clock();
  const programId = `prog-${randomBytes(4).toString('hex')}`;
  const sessionId = kernel.openSession(`program ${programId} charter`, false);
  const plan = await kernel.plan(input.goal, { ...c.options, isolated: false }, sessionId);
  const baseline = {
    expectedUsd: plan.estimate.expectedUsd,
    capUsd: plan.estimate.capUsd,
    basis: plan.estimate.band?.basis ?? 'heuristic',
  };
  const wps =
    c.options.planner === 'model' ? fromGraph(input.goal, plan) : workPackagesFromGoal(input.goal);
  const charter = smallTeamCharter({
    programId,
    goal: input.goal,
    locale: input.locale ?? 'en',
    totalCapUsd: input.budgetUsd ?? defaultBudget(baseline.capUsd, wps.length),
    workPackages: wps,
    ...(input.cadence ? { cadence: input.cadence } : {}),
    ...(input.departments ? { departments: true } : {}),
    now,
  });
  const builders = plannedSources(plan.estimate, (p) => kindOf(plan, p)).providers;
  const crit =
    input.critic === false
      ? { status: 'skipped' as const, providers: [], text: 'skipped at the Sponsor’s request' }
      : await critique(c, charter, builders, sessionId);
  const t = transition(newProgram(charter, now), { type: 'propose', charter }, 'po', now);
  if (!t.ok) throw new Error(`the drafted charter was refused: ${t.reason}`);
  const meta = { ...newMeta(now), baseline, critique: crit };
  await c.store.locked(() => c.store.create(programId, { state: t.state, meta }));
  c.fact(programId, {
    action: 'program drafted',
    programId,
    charterHash: charterHash(charter),
    baselineCapUsd: baseline.capUsd,
    critic: crit.status,
  });
  c.feed.line(
    `program drafted: ${charter.phases[0]!.workPackages.length} work package(s), cap $${charter.envelope.totalCapUsd.toFixed(2)}, one run would be ~$${baseline.capUsd.toFixed(2)}`,
    programId,
    [],
    now,
  );
  return { programId, charter, charterHash: charterHash(charter), baseline, critique: crit };
}
