import { describe, expect, it } from 'vitest';
import type { DisputeQuestion } from './dispute.js';
import { readRun } from './run-journal.js';
import { GraphRunner } from './runner.js';
import {
  RoleAdapter,
  friendly,
  gnode,
  graph,
  isNote,
  setup,
  verdict,
  type Script,
} from './test-helpers/fakes.js';
import type { RunControlEvent } from './types.js';

const voter =
  (choice: string): Script =>
  ({ role }) =>
    role === 'voter' ? JSON.stringify({ choice }) : 'x';

const voteNode = gnode({ protocol: 'vote', type: 'decision' });
const three = () => [
  new RoleAdapter('a', voter('alpha'), { decision: 0.9 }),
  new RoleAdapter('b', voter('beta'), { decision: 0.5 }),
  new RoleAdapter('c', voter('gamma'), { decision: 0.4 }),
];

describe('disagreement surfaced (R-405)', () => {
  it('a 1–1–1 vote is disputed and fails closed without a human', async () => {
    const control: RunControlEvent[] = [];
    const s = setup(three(), { voters: 3, onControl: (e) => control.push(e) });
    const r = await new GraphRunner(s.options).run(graph([voteNode]), { runId: 'v-1' });
    expect(r.states['n1']).toBe('failed');
    expect(r.ok).toBe(false);
    expect(r.results['n1']?.output).toBe('');
    expect(r.results['n1']?.error).toMatch(/disputed: no majority among 3 voters \(1–1–1\)/);
    expect(r.deliverables['n1']).toBeUndefined();
    expect(r.disputes['n1']).toMatchObject({ kind: 'vote', choice: null, by: 'none' });
    expect(r.disputes['n1']?.options.map((o) => o.text)).toEqual(['alpha', 'beta', 'gamma']);
    expect(control.map((e) => e.type)).toEqual(['node_disputed', 'dispute_resolved']);
    expect(s.events).toContainEqual({ type: 'node_state', nodeId: 'n1', state: 'review' });
    const notes = s.journal
      .events()
      .filter(isNote)
      .map((e) => e.payload['action']);
    expect(notes).toEqual(['node disputed', 'dispute unresolved']);
    expect(readRun(s.journal, 'v-1')?.nodes['n1']?.dispute?.unresolved).toBe('no human to decide');
  });

  it('the human choice resolves the dispute', async () => {
    const asked: DisputeQuestion[] = [];
    const s = setup(three(), {
      voters: 3,
      dispute: (q) => {
        asked.push(q);
        return Promise.resolve(q.options.find((o) => o.text === 'beta')?.id ?? null);
      },
    });
    const r = await new GraphRunner(s.options).run(graph([voteNode]), { runId: 'v-2' });
    expect(r.states['n1']).toBe('done');
    expect(r.results['n1']?.output).toBe('beta');
    expect(r.disputes['n1']).toMatchObject({ choice: 'choice-2', by: 'human' });
    expect(asked[0]).toMatchObject({ runId: 'v-2', nodeId: 'n1', kind: 'vote' });
    expect(asked[0]?.positions.map((p) => p.role)).toEqual(['voter', 'voter', 'voter']);
  });

  it('a rejection, an unknown option or a throw keeps the node failed', async () => {
    for (const answer of [
      () => Promise.resolve(null),
      () => Promise.resolve('choice-9'),
      () => Promise.reject(new Error('ui gone')),
    ]) {
      const s = setup(three(), { voters: 3, dispute: answer });
      const r = await new GraphRunner(s.options).run(graph([voteNode]));
      expect(r.states['n1']).toBe('failed');
      expect(r.disputes['n1']?.by).toBe('none');
    }
  });

  it('a cancel while the human is asked leaves the node unresolved', async () => {
    const ctl = new AbortController();
    const s = setup(three(), {
      voters: 3,
      dispute: () => {
        ctl.abort();
        return new Promise<string | null>(() => undefined);
      },
    });
    const r = await new GraphRunner(s.options).run(graph([voteNode]), { signal: ctl.signal });
    expect(r.states['n1']).toBe('cancelled');
    expect(r.disputes['n1']?.unresolved).toBe('cancelled');
  });

  it('a 2–1 vote is a majority and is not disputed', async () => {
    const s = setup(
      [
        new RoleAdapter('a', voter('alpha'), { decision: 0.5 }),
        new RoleAdapter('b', voter('alpha'), { decision: 0.5 }),
        new RoleAdapter('c', voter('gamma'), { decision: 0.5 }),
      ],
      { voters: 3 },
    );
    const r = await new GraphRunner(s.options).run(graph([voteNode]));
    expect(r.results['n1']?.output).toBe('alpha');
    expect(r.disputes).toEqual({});
  });
});

/** b always approves, c always rejects: the critics stay split. */
const split =
  (name: string, approve: boolean): Script =>
  (seen) =>
    seen.role === 'critic' ? verdict(approve) : friendly(name)(seen);

const codeNode = gnode({
  type: 'code_generation',
  protocol: 'author_critic',
  critics: 2,
} as Parameters<typeof gnode>[0]);

const critics = () => [
  new RoleAdapter('a', friendly('A'), { code_generation: 0.9, critique: 0.1 }),
  new RoleAdapter('b', split('B', true), { code_generation: 0.2, critique: 0.9 }),
  new RoleAdapter('c', split('C', false), { code_generation: 0.1, critique: 0.5 }),
];

describe('critics that disagree (R-405)', () => {
  it('revises, then disputes; with no human no patch comes out', async () => {
    const s = setup(critics(), { maxRevisions: 1 });
    const r = await new GraphRunner(s.options).run(graph([codeNode]));
    const roles = r.results['n1']?.contributions.map((c) => `${c.role}@${c.ref.provider}`);
    expect(roles).toEqual([
      'author@a',
      'critic@b',
      'critic@c',
      'revision@a',
      'critic@b',
      'critic@c',
    ]);
    expect(r.states['n1']).toBe('failed');
    expect(r.results['n1']?.approved).toBeUndefined();
    expect(r.deliverables['n1']).toBeUndefined();
    expect(r.disputes['n1']).toMatchObject({ kind: 'critics', choice: null });
    expect(r.disputes['n1']?.reason).toBe('critics disagree: 1 approve, 1 reject');
    const notes = s.journal
      .events()
      .filter(isNote)
      .map((e) => e.payload['action']);
    expect(notes).toContain('critics split');
  });

  it('the human accepting makes the node done and approved', async () => {
    const s = setup(critics(), { maxRevisions: 0, dispute: () => Promise.resolve('accept') });
    const r = await new GraphRunner(s.options).run(graph([codeNode]));
    expect(r.states['n1']).toBe('done');
    expect(r.results['n1']).toMatchObject({ ok: true, approved: true, output: 'A:author:0' });
    expect(r.deliverables['n1']).toBeDefined();
  });

  it('goes on with fewer critics when no new provider is left (journaled)', async () => {
    const s = setup(critics().slice(0, 2));
    const r = await new GraphRunner(s.options).run(graph([codeNode]));
    expect(r.ok).toBe(true);
    const notes = s.journal
      .events()
      .filter(isNote)
      .map((e) => e.payload['action']);
    expect(notes).toContain('diversity reduced');
  });
});

describe('judges that disagree (R-405)', () => {
  const judge =
    (name: string, winner: 1 | 2): Script =>
    (seen) =>
      seen.role === 'judge' ? JSON.stringify({ winner, reason: 'why' }) : friendly(name)(seen);
  const adapters = () => [
    new RoleAdapter('a', friendly('A'), { decision: 0.9 }),
    new RoleAdapter('b', friendly('B'), { decision: 0.8 }),
    new RoleAdapter('c', judge('C', 1), { decision: 0.7 }),
    new RoleAdapter('d', judge('D', 2), { decision: 0.6 }),
  ];
  const debateNode = gnode({ protocol: 'debate', type: 'decision' });

  it('two judges picking different debaters make the node disputed', async () => {
    const s = setup(adapters(), {
      judges: 2,
      dispute: (q) => Promise.resolve(q.options[1]?.id ?? null),
    });
    const r = await new GraphRunner(s.options).run(graph([debateNode]));
    expect(r.disputes['n1']?.kind).toBe('judges');
    expect(r.disputes['n1']?.options.map((o) => o.id)).toEqual(['debater-1', 'debater-2']);
    expect(r.states['n1']).toBe('done');
    expect(r.results['n1']?.output).toBe('B:debater:1');
  });

  it('agreeing judges decide as before', async () => {
    const s = setup(
      [...adapters().slice(0, 3), new RoleAdapter('d', judge('D', 1), { decision: 0.6 })],
      { judges: 2 },
    );
    const r = await new GraphRunner(s.options).run(graph([debateNode]));
    expect(r.ok).toBe(true);
    expect(r.disputes).toEqual({});
    expect(r.results['n1']?.contributions.filter((c) => c.role === 'judge')).toHaveLength(2);
  });
});
