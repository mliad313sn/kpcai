import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@kernelpai/core';
import { BUILTIN_DESCRIPTOR_DIR, MockAdapter, loadDescriptors } from '@kernelpai/providers';
import { PlanSchema, parseJudge, parseVerdict, parseVote } from './index.js';
import { plannerPrompt } from './planner/model.js';

/**
 * The offline demo's MockAdapter must speak exactly the formats these parsers accept.
 * This test keeps the two packages from drifting apart (they were built in parallel).
 */
const mock = new MockAdapter(
  loadDescriptors([BUILTIN_DESCRIPTOR_DIR]).find((d) => d.id === 'mock')!,
);

async function reply(content: string): Promise<string> {
  const messages: ChatMessage[] = [{ role: 'user', content }];
  let out = '';
  for await (const ev of mock.send({ model: 'echo', messages }))
    if (ev.type === 'text') out += ev.delta;
  return out;
}

describe('MockAdapter ↔ orchestrator parsers', () => {
  it('planner output is a valid PlanSchema plan', async () => {
    const out = await reply(plannerPrompt('add an OAuth state validator with tests'));
    const plan = PlanSchema.parse(JSON.parse(out));
    expect(plan.nodes.map((n) => n.type)).toEqual([
      'analysis',
      'code_generation',
      'test',
      'critique',
    ]);
  });

  it('critic, judge and voter outputs parse', async () => {
    expect(parseVerdict(await reply('Role: critic\nreview this'))).toMatchObject({
      ok: true,
      value: { approve: true },
    });
    expect(parseVerdict(await reply('Role: critic\nreview [[reject]]'))).toMatchObject({
      ok: true,
      value: { approve: false },
    });
    expect(parseJudge(await reply('Role: judge\nA or B'))).toEqual({
      ok: true,
      value: { winner: 1, reason: 'mock judge picked answer 1' },
    });
    expect(parseJudge(await reply('Role: judge\nA or B [[judge:2]]'))).toMatchObject({
      ok: true,
      value: { winner: 2 },
    });
    expect(parseVote(await reply('Role: voter\nOptions: Red | Green'))).toEqual({
      ok: true,
      value: 'red',
    });
  });
});
