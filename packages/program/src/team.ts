/**
 * S10 R7: the smallest charter that fits. One team (a builder, plus a pack specialist when a
 * pack applies) and the mandatory independent reviewer. Departments are opt-in. The envelope
 * expires 14 days after drafting (S10 R3) and pre-answers only in-envelope budget questions
 * and writes inside a run's own worktree. Reports go out at gates; liveness is the heartbeat.
 */
import { expiryFrom } from './safeguards.js';
import { CharterSchema, type Cadence, type Charter, type Locale } from './schemas.js';

export interface DraftWorkPackage {
  title: string;
  request: string;
  acceptance?: string[];
}

export interface TeamDraft {
  programId: string;
  goal: string;
  locale: Locale;
  totalCapUsd: number;
  packs?: string[];
  workPackages: DraftWorkPackage[];
  cadence?: Cadence;
  /** Opt-in departments (expert view): engineering, a domain department for packs, review. */
  departments?: boolean;
  now: Date;
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function org(d: TeamDraft): Pick<Charter, 'departments' | 'seats'> {
  const packs = (d.packs ?? []).slice(0, 20);
  const work = d.departments ? 'eng' : 'team';
  const domain = d.departments && packs.length ? 'domain' : work;
  const departments: Charter['departments'] = [
    {
      id: work,
      kind: 'engineering',
      title: d.departments ? 'Engineering' : 'Team',
      escalatesTo: 'sponsor',
    },
    ...(domain !== work
      ? [{ id: domain, kind: 'domain' as const, title: 'Domain', escalatesTo: 'sponsor' as const }]
      : []),
    { id: 'review', kind: 'review', title: 'Independent review', escalatesTo: 'sponsor' },
  ];
  const seats: Charter['seats'] = [
    {
      id: 'builder',
      kind: 'builder',
      department: work,
      title: 'Builder',
      mandate: 'Build the work packages and their tests.',
      packs: [],
    },
    ...(packs.length
      ? [
          {
            id: 'specialist',
            kind: 'specialist' as const,
            department: domain,
            title: `Pack specialist (${packs.join(', ')})`,
            mandate: 'Bring the domain packs to the work.',
            packs,
          },
        ]
      : []),
    {
      id: 'reviewer',
      kind: 'reviewer',
      department: 'review',
      title: 'Independent reviewer',
      mandate: 'Gate review on another provider, exit criteria only.',
      packs: [],
    },
  ];
  return { departments, seats };
}

/** A small-team charter for the goal, parsed by the strict schema (throws on nonsense). */
export function smallTeamCharter(d: TeamDraft): Charter {
  const wps = d.workPackages.slice(0, 30).map((w, i) => ({
    id: `wp${i + 1}`,
    title: cut(w.title, 200),
    lead: 'builder',
    request: cut(w.request, 4_000),
    deliverables: [],
    acceptance: (w.acceptance?.length
      ? w.acceptance
      : [`${cut(w.title, 400)}: done and reviewed`]
    ).slice(0, 50),
  }));
  return CharterSchema.parse({
    version: 1,
    programId: d.programId,
    goal: cut(d.goal, 4_000),
    locale: d.locale,
    packs: d.packs ?? [],
    outOfScope: [],
    ...org(d),
    phases: [
      {
        id: 'p1',
        title: 'Deliver',
        goal: cut(d.goal, 2_000),
        capUsd: d.totalCapUsd,
        workPackages: wps,
        exit: ['Every work package finished and approved by a critic of another provider'],
      },
    ],
    envelope: {
      totalCapUsd: d.totalCapUsd,
      write: { mode: 'isolated-only' },
      preAnswer: ['budget-within-envelope', 'write-in-worktree'],
      subscriptions: [],
      expires: expiryFrom(d.now),
    },
    // Q-8: a daily digest by default (sent only when something changed, S10 R4 b).
    reports: { cadence: d.cadence ?? { every: 'hours', hours: 24 } },
  });
}

/**
 * Work packages from a goal written as a list ("- a", "1. b", one per line); otherwise the
 * whole goal is one work package. The kernel planner can split further inside each run.
 */
export function workPackagesFromGoal(goal: string): DraftWorkPackage[] {
  const items = goal
    .split('\n')
    .map((l) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x);
  const head = goal.split('\n')[0]?.trim() ?? goal;
  if (items.length < 2) return [{ title: cut(head || goal, 120), request: goal }];
  return items.map((item) => ({
    title: cut(item, 120),
    request: `${item}\n\nPart of the program goal:\n${cut(goal, 3_000)}`,
  }));
}
