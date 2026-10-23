import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '@kernelpai/core';
import { Journal, type JournalEventInput } from '@kernelpai/journal';
import { median, outputCalibration } from './calibration.js';
import { FallbackExecutor } from './executor.js';
import { ScriptedAdapter, decision, node } from './test-helpers/fakes.js';

let journal: Journal;
let sessionId: string;

beforeEach(() => {
  journal = Journal.open(':memory:');
  sessionId = journal.startSession('cal', '/');
});
afterEach(() => journal.close());

const A = { provider: 'a', model: 'echo' };
let seq = 0;

/** One call/response pair; `extra` overrides response payload fields. */
function pair(taskType: string, out: number, extra: Record<string, unknown> = {}): void {
  const requestId = `r${String(seq++)}`;
  const base: Omit<JournalEventInput, 'type' | 'payload'> = {
    sessionId,
    nodeId: 'n1',
    provider: 'a',
    model: 'echo',
  };
  journal.append({ ...base, type: 'call', payload: { requestId, taskType } });
  journal.append({
    ...base,
    type: 'response',
    payload: { requestId, outputTokens: out, usageBasis: 'reported', stopReason: 'end', ...extra },
  });
}

describe('outputCalibration', () => {
  it('returns the median of reported output per model and task type', () => {
    for (const out of [10, 30, 20]) pair('code', out);
    for (const out of [100, 200, 300, 400]) pair('writing', out);
    const expected = outputCalibration(journal);
    expect(expected(A, 'code')).toBe(20);
    expect(expected(A, 'writing')).toBe(250);
    expect(expected(A, 'analysis')).toBeUndefined();
    expect(expected({ provider: 'b', model: 'echo' }, 'code')).toBeUndefined();
  });

  it('is undefined below minSamples and uses only the last window', () => {
    pair('code', 10);
    pair('code', 20);
    expect(outputCalibration(journal)(A, 'code')).toBeUndefined();
    expect(outputCalibration(journal, { minSamples: 2 })(A, 'code')).toBe(15);
    for (const out of [1000, 1000, 1000]) pair('code', out);
    expect(outputCalibration(journal, { window: 3 })(A, 'code')).toBe(1000);
  });

  it('ignores estimated, cancelled, refused, zero and unpaired responses', () => {
    pair('code', 50, { usageBasis: 'estimated' });
    pair('code', 50, { stopReason: 'cancelled' });
    pair('code', 50, { stopReason: 'refusal' });
    pair('code', 0);
    journal.append({
      sessionId,
      type: 'response',
      provider: 'a',
      model: 'echo',
      payload: { requestId: 'orphan', outputTokens: 50, usageBasis: 'reported' },
    });
    journal.append({ sessionId, type: 'routing', payload: {} });
    expect(outputCalibration(journal, { minSamples: 1 })(A, 'code')).toBeUndefined();
  });

  it('learns from what FallbackExecutor journals and feeds it back', async () => {
    const usage = { inputTokens: 10, outputTokens: 40 };
    const a = new ScriptedAdapter('a', [[{ text: 'x' }, { usage }, { end: 'end' }]]);
    const run = (ex: FallbackExecutor) =>
      ex.execute(node({ type: 'code' }), decision('a/echo'), { sessionId });
    const plain = new FallbackExecutor(() => a as ProviderAdapter, journal);
    for (let i = 0; i < 3; i++) await run(plain);
    const expectedOutput = outputCalibration(journal);
    expect(expectedOutput(A, 'code')).toBe(40);
    await run(new FallbackExecutor(() => a as ProviderAdapter, journal, { expectedOutput }));
    const calls = journal.events({ sessionId }).filter((e) => e.type === 'call');
    expect(calls.at(-1)?.payload).toMatchObject({
      estimatedOutputTokens: 40,
      estimateBasis: 'calibrated',
    });
  });
});

describe('median', () => {
  it('handles empty, odd and even lists', () => {
    expect(median([])).toBeUndefined();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
