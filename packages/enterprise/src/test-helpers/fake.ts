/** A fake kernel side for the daemon: plans with chosen figures, runs settled by the test. */
import type { RunOutcome } from '@kernelpai/kernel';
import type { PlannedRun } from '@kernelpai/program';
import type { ProgramStarter } from '../context.js';
import { watch } from '../dispatch.js';
import type { EnterpriseRuntime } from '../runtime.js';

export interface FakeRun {
  runId: string;
  programId: string;
  wpId: string;
  finish(o?: RunOutcome): void;
}

export interface Fake extends ProgramStarter {
  runs: FakeRun[];
  plans: number;
  figures: { capUsd: number; providers: string[]; source: PlannedRun['source'] };
}

export const FINISHED: RunOutcome = {
  status: 'finished',
  result: { graphId: 'g', results: {}, states: {}, costUsd: 0, ok: true },
  cancelled: false,
  patches: [],
  refused: [],
  artifacts: [],
  refusedArtifacts: [],
};

export function fakeStarter(rt: EnterpriseRuntime): Fake {
  const inputs = new Map<string, { programId: string; wpId: string }>();
  let n = 0;
  const fake: Fake = {
    runs: [],
    plans: 0,
    figures: { capUsd: 1, providers: ['mock-beta'], source: 'api' },
    plan(input) {
      fake.plans += 1;
      const planId = `plan-${++n}`;
      inputs.set(planId, { programId: input.programId, wpId: input.wpId });
      return Promise.resolve({ planId, expectedUsd: fake.figures.capUsd / 2, ...fake.figures });
    },
    start(planId) {
      const ctx = inputs.get(planId)!;
      const runId = `run-${++n}`;
      let resolve: (o: RunOutcome) => void = () => undefined;
      const done = new Promise<RunOutcome>((r) => (resolve = r));
      const sessionId = rt.ctx.kernel.openSession(`fake ${runId}`, false);
      fake.runs.push({ runId, ...ctx, finish: (o = FINISHED) => resolve(o) });
      watch(rt.ctx, { handle: { runId, planId, sessionId, done }, sessionId, planId, ctx });
      return Promise.resolve({ runId });
    },
    forgetWp: () => undefined,
  };
  rt.ctx.starter = fake;
  return fake;
}
