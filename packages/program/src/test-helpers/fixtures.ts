/** A small coherent charter and helpers to drive a program through the machine. */
import { charterHash } from '../ledger.js';
import { newProgram, transition } from '../machine.js';
import type { MachineActor } from '../events.js';
import type { CharterSchema, ProgramState, RunRecord } from '../schemas.js';
import type { z } from 'zod';

export const NOW = new Date('2026-10-23T10:00:00.000Z');

export function charter(
  over: Partial<z.input<typeof CharterSchema>> = {},
): z.input<typeof CharterSchema> {
  return {
    version: 1,
    programId: 'prog-1',
    goal: 'A parametric 3D-printable bracket with its slicing profile',
    locale: 'en',
    packs: ['cad'],
    departments: [
      { id: 'eng', kind: 'engineering', title: 'Engineering', capUsd: 6 },
      { id: 'sec', kind: 'security', title: 'Security', sources: { sources: ['local'] } },
      { id: 'rev', kind: 'review', title: 'Independent review' },
    ],
    seats: [
      { id: 'arch', kind: 'architect', department: 'eng', title: 'Architect', mandate: 'Design' },
      {
        id: 'cad',
        kind: 'builder',
        department: 'eng',
        title: 'CAD engineer',
        mandate: 'Model',
        packs: ['cad'],
      },
      { id: 'secu', kind: 'security', department: 'sec', title: 'Security', mandate: 'Threats' },
      { id: 'rv', kind: 'reviewer', department: 'rev', title: 'Reviewer', mandate: 'Gate review' },
    ],
    phases: [
      {
        id: 'p1',
        title: 'Design',
        goal: 'Design the bracket',
        capUsd: 4,
        workPackages: [
          {
            id: 'wp1',
            title: 'Model',
            lead: 'cad',
            request: 'Model the bracket',
            deliverables: ['model3d'],
            acceptance: ['prints'],
          },
          {
            id: 'wp2',
            title: 'Threats',
            lead: 'secu',
            request: 'Review the firmware config',
            deliverables: [],
            acceptance: ['no secrets'],
          },
        ],
        exit: ['model validated'],
      },
      {
        id: 'p2',
        title: 'Release',
        goal: 'Release files',
        capUsd: 4,
        workPackages: [
          {
            id: 'wp3',
            title: 'Docs',
            lead: 'arch',
            request: 'Write the guide',
            deliverables: [],
            acceptance: ['guide'],
          },
        ],
        exit: ['guide published locally'],
      },
    ],
    envelope: { totalCapUsd: 10, preAnswer: ['budget-within-envelope', 'write-in-worktree'] },
    reports: { cadence: { every: 'hours', hours: 24 } },
    ...over,
  };
}

/** Applies events in order and fails loudly on a refusal. */
export function drive(
  s: ProgramState,
  steps: Array<[unknown, MachineActor]>,
  now: Date = NOW,
): ProgramState {
  let cur = s;
  for (const [event, actor] of steps) {
    const r = transition(cur, event, actor, now);
    if (!r.ok) throw new Error(`refused ${JSON.stringify(event)}: ${r.reason}`);
    cur = r.state;
  }
  return cur;
}

/** A program approved and running phase 1. */
export function running(over: Partial<z.input<typeof CharterSchema>> = {}): ProgramState {
  const s = newProgram(charter(over), NOW);
  const proposed = drive(s, [[{ type: 'propose', charter: charter(over) }, 'po']]);
  return drive(proposed, [
    [{ type: 'approve', charterHash: charterHash(proposed.charter) }, 'sponsor'],
    [{ type: 'start' }, 'po'],
  ]);
}

export function run(
  over: Partial<z.input<typeof import('../schemas.js').RunRecordSchema>> = {},
): RunRecord {
  return {
    runId: 'r1',
    wpId: 'wp1',
    phaseId: 'p1',
    capUsd: 1,
    costUsd: 0,
    status: 'running',
    purpose: 'work',
    source: 'api',
    hours: 0,
    providers: ['openai'],
    evidence: [],
    startedAt: NOW.toISOString(),
    ...over,
  } as RunRecord;
}
