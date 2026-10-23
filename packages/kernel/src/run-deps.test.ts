/**
 * Review P4-F11 at its source: an option longer than the cap is shown cut, so the kernel
 * refuses any choice of it, whatever the client sends; unknown ids are refused too.
 */
import type { DisputeQuestion } from '@kernelpai/orchestrator';
import { describe, expect, it } from 'vitest';
import type { DisputeInfo } from './confirm.js';
import { MAX_OPTION_CHARS, TRUNCATED_NOTE, disputeHook, disputeInfo } from './run-deps.js';

const ref = { provider: 'p', model: 'm' };
const option = (id: string, chars: number, label = id) => ({
  id,
  label,
  text: 'x'.repeat(chars),
  backers: [ref],
});
const question = {
  runId: 'r',
  nodeId: 'n',
  kind: 'critics',
  reason: 'split critics',
  options: [
    option('short', 100),
    option('exact', MAX_OPTION_CHARS),
    option('long', MAX_OPTION_CHARS + 1, 'L'.repeat(200)),
  ],
  positions: [{ ref, role: 'critic', says: 'ok', option: 'short' }],
} as unknown as DisputeQuestion;

describe('disputes: what is shown is what can be chosen (P4-F11)', () => {
  it('marks an over-long option truncated, in its label too, within the label cap', () => {
    const d = disputeInfo(question);
    expect(d.options.map((o) => o.truncated)).toEqual([undefined, undefined, true]);
    const long = d.options[2]!;
    expect(long.text).toHaveLength(MAX_OPTION_CHARS);
    expect(long.label.endsWith(TRUNCATED_NOTE)).toBe(true);
    expect(long.label.length).toBeLessThanOrEqual(200);
    expect(d.options[1]!.label).toBe('exact');
  });

  it('refuses a choice of a truncated option or an unknown id, and keeps the others', async () => {
    const seen: DisputeInfo[] = [];
    const pick = (id: string | null) =>
      disputeHook((r) => (seen.push(r.dispute), Promise.resolve(id)))(question);
    expect(await pick('long')).toBeNull();
    expect(await pick('forged')).toBeNull();
    expect(await pick(null)).toBeNull();
    expect(await pick('exact')).toBe('exact');
    expect(await pick('short')).toBe('short');
    expect(seen[0]!.options).toHaveLength(3);
  });
});
