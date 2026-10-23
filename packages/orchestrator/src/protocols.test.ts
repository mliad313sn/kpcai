import { describe, expect, it } from 'vitest';
import { GraphRunner } from './runner.js';
import {
  RoleAdapter,
  friendly,
  gnode,
  graph,
  setup,
  verdict,
  type Script,
} from './test-helpers/fakes.js';

const run = (s: ReturnType<typeof setup>, nodes = [gnode()]) =>
  new GraphRunner(s.options).run(graph(nodes));

describe('solo', () => {
  it('routes one model, journals role in routing and call payloads', async () => {
    const a = new RoleAdapter('a', friendly('A'));
    const s = setup([a]);
    const r = await run(s);
    expect(r.ok).toBe(true);
    expect(r.results['n1']?.output).toBe('A:author:0');
    expect(r.results['n1']?.contributions.map((c) => c.role)).toEqual(['solo']);
    const ev = s.journal.events({ sessionId: s.sessionId });
    expect(ev.find((e) => e.type === 'routing')?.payload['role']).toBe('solo');
    expect(ev.find((e) => e.type === 'call')?.payload['role']).toBe('solo');
    expect(ev.find((e) => e.type === 'response')?.payload['role']).toBe('solo');
    expect(a.seen[0]?.prompt.startsWith('Role: author\n')).toBe(true);
  });
});

describe('author + critic', () => {
  const ac = gnode({ protocol: 'author_critic' });

  it('routes the critic to another provider and records approval', async () => {
    const s = setup([new RoleAdapter('a', friendly('A')), new RoleAdapter('b', friendly('B'))]);
    const r = (await run(s, [ac])).results['n1'];
    expect(r?.approved).toBe(true);
    expect(r?.contributions.map((c) => [c.role, c.ref.provider])).toEqual([
      ['author', 'a'],
      ['critic', 'b'],
    ]);
    expect(r?.contributions[1]?.verdict?.approve).toBe(true);
    const routing = s.journal.events().filter((e) => e.type === 'routing');
    expect(routing[1]?.payload['excludedProviders']).toEqual(['a']);
  });

  it('fails clearly when only one provider exists', async () => {
    const s = setup([new RoleAdapter('a', friendly('A'))]);
    const r = await run(s, [ac]);
    expect(r.states['n1']).toBe('failed');
    expect(r.results['n1']?.error).toMatch(/diversity \(principle 2\).*allowSameProvider/);
    expect(r.results['n1']?.output).toBe('A:author:0');
  });

  it('waives diversity only with allowSameProvider, and journals it', async () => {
    const s = setup([new RoleAdapter('a', friendly('A'))], { allowSameProvider: true });
    const r = await run(s, [ac]);
    expect(r.ok).toBe(true);
    const iv = s.journal.events().filter((e) => e.type === 'intervention');
    expect(iv.map((e) => e.payload['action'])).toContain('diversity waived');
  });

  it('revises on major issues by the same author, then approves', async () => {
    const critic: Script = ({ role, n }) => (role === 'critic' ? verdict(n > 0) : 'B');
    const a = new RoleAdapter('a', friendly('A'), { analysis: 0.9 });
    const s = setup([a, new RoleAdapter('b', critic, { analysis: 0.5 })]);
    const r = (await run(s, [ac])).results['n1'];
    expect(r?.contributions.map((c) => `${c.role}@${c.ref.provider}`)).toEqual([
      'author@a',
      'critic@b',
      'revision@a',
      'critic@b',
    ]);
    expect(r?.approved).toBe(true);
    expect(r?.output).toBe('A:author:1');
    expect(a.seen[1]?.prompt).toContain('[major] missing check');
  });

  it('stops after two revisions and records the missing approval', async () => {
    const critic: Script = ({ role }) => (role === 'critic' ? verdict(false) : 'B');
    const s = setup([new RoleAdapter('a', friendly('A')), new RoleAdapter('b', critic)]);
    const r = (await run(s, [ac])).results['n1'];
    expect(r?.contributions.map((c) => c.role)).toEqual([
      'author',
      'critic',
      'revision',
      'critic',
      'revision',
      'critic',
    ]);
    expect(r?.ok).toBe(true);
    expect(r?.approved).toBe(false);
    const iv = s.journal.events().filter((e) => e.type === 'intervention');
    expect(iv.map((e) => e.payload['action'])).toContain('not approved');
  });

  it('treats approve with a major issue as a rejection', async () => {
    const critic: Script = ({ role, n }) =>
      role === 'critic' ? (n === 0 ? verdict(true, true) : verdict(true)) : 'B';
    const s = setup([new RoleAdapter('a', friendly('A')), new RoleAdapter('b', critic)]);
    const r = (await run(s, [ac])).results['n1'];
    expect(r?.contributions).toHaveLength(4);
  });

  it('retries an invalid verdict once on the same critic', async () => {
    const critic: Script = ({ role, n }) =>
      role === 'critic' ? (n === 0 ? 'looks good to me' : verdict(true)) : 'B';
    const b = new RoleAdapter('b', critic);
    const s = setup([new RoleAdapter('a', friendly('A')), b]);
    const r = (await run(s, [ac])).results['n1'];
    expect(r?.approved).toBe(true);
    expect(b.seen[1]?.prompt).toContain('not a valid verdict (no JSON object found)');
    expect(r?.contributions.map((c) => c.verdict === undefined)).toEqual([true, true, false]);
  });

  it('falls back to the next critic when a critic stays malformed', async () => {
    const bad: Script = () => '{"approve": "yes"}';
    const s = setup([
      new RoleAdapter('a', friendly('A'), { analysis: 0.9 }),
      new RoleAdapter('b', bad, { analysis: 0.8 }),
      new RoleAdapter('c', friendly('C'), { analysis: 0.1 }),
    ]);
    const r = (await run(s, [ac])).results['n1'];
    expect(r?.approved).toBe(true);
    expect(r?.contributions.at(-1)?.ref.provider).toBe('c');
    const ev = s.journal.events();
    expect(ev.some((e) => e.type === 'error' && e.payload['kind'] === 'malformed')).toBe(true);
    expect(ev.some((e) => e.type === 'routing' && e.payload['fallbackFrom'] === 'b/m')).toBe(true);
  });

  it('fails the node when every critic is malformed', async () => {
    const s = setup([new RoleAdapter('a', friendly('A')), new RoleAdapter('b', () => 'nope')]);
    const r = await run(s, [ac]);
    expect(r.states['n1']).toBe('failed');
    expect(r.results['n1']?.error).toMatch(/critic output malformed/);
  });

  it('upgrades a critical solo node to author + critic', async () => {
    const s = setup([new RoleAdapter('a', friendly('A')), new RoleAdapter('b', friendly('B'))]);
    const r = await run(s, [gnode({ criticality: 'critical' })]);
    expect(r.results['n1']?.protocol).toBe('author_critic');
    expect(r.results['n1']?.contributions.map((c) => c.role)).toEqual(['author', 'critic']);
    const iv = s.journal.events().filter((e) => e.type === 'intervention');
    expect(iv[0]?.payload['action']).toBe('protocol upgraded');
  });

  it('fails when the revision step fails, keeping the last version', async () => {
    const critic: Script = ({ role }) => (role === 'critic' ? verdict(false) : 'B');
    let calls = 0;
    const a = new RoleAdapter('a', () => (calls++ === 0 ? 'draft' : [{ fail: 'auth' }]));
    const s = setup([a, new RoleAdapter('b', critic)]);
    const r = await run(s, [ac]);
    expect(r.states['n1']).toBe('failed');
    expect(r.results['n1']?.output).toBe('draft');
  });
});

describe('debate', () => {
  const node = gnode({ protocol: 'debate', type: 'decision' });

  it('uses two providers for debaters and a third as judge', async () => {
    const judge: Script = ({ role }) =>
      role === 'judge' ? '```json\n{"winner": 2, "reason": "x"}\n```' : 'C';
    const s = setup([
      new RoleAdapter('a', friendly('A')),
      new RoleAdapter('b', friendly('B')),
      new RoleAdapter('c', judge),
    ]);
    const r = (await run(s, [node])).results['n1'];
    expect(r?.contributions.map((c) => `${c.role}@${c.ref.provider}`)).toEqual([
      'debater@a',
      'debater@b',
      'debater@a',
      'debater@b',
      'judge@c',
    ]);
    expect(r?.output).toBe('B:debater:1');
  });

  it('needs a third provider for the judge unless the waiver is given (P2-F18)', async () => {
    const both: Script = ({ role, n }) =>
      role === 'judge' ? JSON.stringify({ winner: '1', answer: 'synthesis' }) : `A${n}`;
    const two = () => [new RoleAdapter('a', both), new RoleAdapter('b', friendly('B'))];
    const strict = await run(setup(two()), [node]);
    expect(strict.states['n1']).toBe('failed');
    expect(strict.results['n1']?.error).toMatch(/can act as judge.*allowSameProvider/);
    const s = setup(two(), { allowSameProvider: true });
    const r = (await run(s, [node])).results['n1'];
    expect(r?.output).toBe('synthesis');
    const iv = s.journal.events().filter((e) => e.type === 'intervention');
    expect(iv.map((e) => [e.payload['action'], e.payload['role']])).toContainEqual([
      'diversity waived',
      'judge',
    ]);
  });

  it('needs two providers for debaters', async () => {
    const r = await run(setup([new RoleAdapter('a', friendly('A'))]), [node]);
    expect(r.results['n1']?.error).toMatch(/diversity/);
  });

  it('fails when the judge stays unreadable', async () => {
    const s = setup([
      new RoleAdapter('a', friendly('A')),
      new RoleAdapter('b', friendly('B')),
      new RoleAdapter('c', () => 'I cannot decide'),
    ]);
    const r = await run(s, [node]);
    expect(r.results['n1']?.error).toMatch(/judge output malformed/);
  });
});

describe('vote', () => {
  const node = gnode({ protocol: 'vote', type: 'decision' });
  const voter =
    (choice: string, unreadableFirst = false): Script =>
    ({ n }) =>
      unreadableFirst && n === 0 ? 'hmm' : `Choice: ${choice}`;

  it('takes the competence-weighted majority from three providers', async () => {
    const s = setup([
      new RoleAdapter('a', voter('X'), { decision: 0.9 }),
      new RoleAdapter('b', voter('y'), { decision: 0.5 }),
      new RoleAdapter('c', voter('Y.', true), { decision: 0.5 }),
    ]);
    const r = (await run(s, [node])).results['n1'];
    expect(r?.output).toBe('y');
    expect(new Set(r?.contributions.map((c) => c.ref.provider))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('breaks a tie by the most competent voter', async () => {
    const s = setup(
      [
        new RoleAdapter('a', voter('beta'), { decision: 0.6 }),
        new RoleAdapter('b', voter('alpha'), { decision: 0.6 }),
      ],
      { voters: 2 },
    );
    expect((await run(s, [node])).results['n1']?.output).toBe('alpha');
    const s2 = setup(
      [
        new RoleAdapter('a', voter('beta'), { decision: 0.9 }),
        new RoleAdapter('b', voter('alpha'), { decision: 0.2 }),
        new RoleAdapter('c', voter('alpha'), { decision: 0.7 }),
      ],
      { voters: 3 },
    );
    expect((await run(s2, [node])).results['n1']?.output).toBe('beta');
  });

  it('votes with fewer voters when providers run out, even with allowSameProvider', async () => {
    const s = setup([new RoleAdapter('a', voter('x'))], { allowSameProvider: true });
    const r = (await run(s, [node])).results['n1'];
    expect(r?.output).toBe('x');
    expect(r?.contributions).toHaveLength(1);
    const iv = s.journal.events().filter((e) => e.type === 'intervention');
    expect(iv[0]?.payload['reason']).toMatch(/only 1 distinct provider/);
  });

  it('leaves out an unreadable voter but fails when the first one fails', async () => {
    const s = setup([
      new RoleAdapter('a', voter('x'), { decision: 0.9 }),
      new RoleAdapter('b', () => 'no idea', { decision: 0.5 }),
    ]);
    const r = await run(s, [node]);
    expect(r.results['n1']?.output).toBe('x');
    const iv = s.journal.events().filter((e) => e.type === 'intervention');
    expect(iv.map((e) => e.payload['action'])).toContain('voter left out');
    const s2 = setup([new RoleAdapter('a', () => [{ fail: 'auth' }])]);
    expect((await run(s2, [node])).states['n1']).toBe('failed');
  });
});
