import { describe, expect, it } from 'vitest';
import {
  ChatMessageSchema,
  TaskTypeSchema,
  type ChatMessage,
  type ProviderDescriptor,
  type StreamEvent,
  type TaskGraph,
  type Verdict,
} from '@kernelpai/core';
import { MockAdapter } from './mock.js';
import { BUILTIN_DESCRIPTOR_DIR, loadDescriptors } from '../registry.js';

const base = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]).find(
  (d) => d.id === 'mock',
) as ProviderDescriptor;
const mock = (id = 'mock') => new MockAdapter({ ...base, id });

async function events(messages: ChatMessage[], id?: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of mock(id).send({ model: 'echo', messages })) out.push(ev);
  return out;
}
async function text(messages: ChatMessage[], id?: string): Promise<string> {
  return (await events(messages, id)).flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
}
const user = (content: string): ChatMessage => ({ role: 'user', content });
const sys = (content: string): ChatMessage => ({ role: 'system', content });

describe('MockAdapter role scripting: planner', () => {
  it('returns the [[plan:{...}]] JSON verbatim, even with ]] inside strings', async () => {
    const plan = '{"id":"g","nodes":[{"id":"n1","title":"a ]] b"}],"x":{"y":1}}';
    expect(await text([sys('Role: planner'), user(`Plan it [[plan:${plan}]] please`)])).toBe(plan);
  });

  it('plans code requests as analysis → code_generation → test → critique', async () => {
    const out = await text([
      user('Role: planner\nRequest: add an OAuth state validator with tests'),
    ]);
    const g = JSON.parse(out) as { reason: string; nodes: Array<Record<string, unknown>> };
    expect(g.reason).toBe('mock planner: code template');
    expect(g.nodes.map((n) => [n['id'], n['type'], n['protocol'], n['dependsOn']])).toEqual([
      ['n1', 'analysis', 'solo', []],
      ['n2', 'code_generation', 'author_critic', ['n1']],
      ['n3', 'test', 'author_critic', ['n2']],
      ['n4', 'critique', 'solo', ['n3']],
    ]);
    for (const n of g.nodes) {
      expect(TaskTypeSchema.safeParse(n['type']).success).toBe(true);
      expect(n['criticality']).toBe('normal');
      expect(String(n['prompt'])).toContain('add an OAuth state validator with tests');
    }
  });

  it('plans anything else as one solo node, using the whole prompt as request', async () => {
    const g = JSON.parse(await text([sys('Role: planner'), user('summarise the meeting')])) as {
      nodes: Array<Record<string, unknown>>;
    };
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]).toMatchObject({
      id: 'n1',
      protocol: 'solo',
      dependsOn: [],
      prompt: 'Answer the request: summarise the meeting',
    });
  });
});

describe('MockAdapter role scripting: critic and author', () => {
  const verdict = async (prompt: string, id?: string, extra: ChatMessage[] = []) =>
    JSON.parse(await text([sys('Role: critic'), ...extra, user(prompt)], id)) as Verdict;

  it('approves by default with a valid Verdict', async () => {
    expect(await verdict('Draft: fine')).toEqual({
      approve: true,
      issues: [],
      summary: 'Approved by mock critic mock.',
    });
  });

  it('rejects with one major issue on [[reject]] and [[reject@<provider>]] only for that provider', async () => {
    const v = await verdict('Draft [[reject]]');
    expect(v.approve).toBe(false);
    expect(v.issues).toEqual([{ severity: 'major', text: expect.any(String) }]);
    expect((await verdict('Draft [[reject@crit-b]]', 'crit-b')).approve).toBe(false);
    expect((await verdict('Draft [[reject@crit-b]]', 'crit-a')).approve).toBe(true);
  });

  it('approves once the text contains [[revised]]', async () => {
    expect((await verdict('Draft [[reject]] [[revised]]')).approve).toBe(true);
    const earlier = [user('Draft [[reject]]'), { role: 'assistant' as const, content: 'x' }];
    expect((await verdict('[[revised]] new draft', undefined, earlier)).approve).toBe(true);
  });

  it('marks an author answer [[revised]] only after a critique', async () => {
    expect(await text([user('Role: author\nWrite it')])).not.toContain('[[revised]]');
    const critique = '{"approve":false,"issues":[],"summary":"no"}';
    expect(await text([user(`Role: author\nRevise. Verdict: ${critique}`)])).toBe(
      `[mock/echo] [[revised]] You asked: Role: author\nRevise. Verdict: ${critique}`,
    );
    const multi = [
      sys('Role: author'),
      user('Write it'),
      { role: 'assistant' as const, content: 'v1' },
      user('Address this critique please'),
    ];
    expect(await text(multi)).toContain('[[revised]]');
  });

  it('runs a full reject → revise → approve loop', async () => {
    const draft = await text([user('Role: author\nWrite it [[reject]]')]);
    const v1 = await text([sys('Role: critic'), user(`Review:\n${draft}`)]);
    expect((JSON.parse(v1) as Verdict).approve).toBe(false);
    const revised = await text([user(`Role: author\nDraft: ${draft}\nCritique: ${v1}`)]);
    const v2 = await text([sys('Role: critic'), user(`Review:\n${revised}`)]);
    expect((JSON.parse(v2) as Verdict).approve).toBe(true);
  });
});

describe('MockAdapter role scripting: judge and voter', () => {
  it('judge answers {winner: 1|2}; [[judge:2]] picks the second', async () => {
    expect(JSON.parse(await text([sys('Role: judge'), user('A or B')]))).toEqual({
      winner: 1,
      reason: 'mock judge picked answer 1',
    });
    expect(JSON.parse(await text([user('Role: judge\nA or B [[judge:2]]')]))).toMatchObject({
      winner: 2,
    });
  });

  it('voter answers {choice} with the first option unless [[vote:<option>(@provider)]]', async () => {
    const prompt = 'Role: voter\nPick one.\nOptions: red | green | blue';
    expect(JSON.parse(await text([user(prompt)]))).toMatchObject({ choice: 'red' });
    expect(JSON.parse(await text([user(`${prompt} [[vote:blue@mock]]`)]))).toMatchObject({
      choice: 'blue',
    });
    expect(JSON.parse(await text([user(`${prompt} [[vote:blue@other]]`)]))).toMatchObject({
      choice: 'red',
    });
    expect(JSON.parse(await text([user('Role: voter\n[[vote:green]]')]))).toMatchObject({
      choice: 'green',
    });
  });

  it('a voter without options falls back to the echo', async () => {
    expect(await text([user('Role: voter\nnothing')])).toContain('You asked:');
  });
});
