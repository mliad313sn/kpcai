import { describe, expect, it } from 'vitest';
import { extractJson, normalizeChoice, parseJudge, parseVerdict, parseVote } from './parse.js';
import { quote, stepMessages } from './prompts.js';
import { decisionAfter, preferRef } from './routing.js';
import { tally } from './protocols/vote.js';
import { RoleAdapter, friendly, gnode, setup } from './test-helpers/fakes.js';
import { findCycle, graphProblems } from './validate.js';

describe('parsers', () => {
  it('extracts the first JSON object past prose, fences and braces in strings', () => {
    expect(
      extractJson('Sure! {not json} then ```json\n{"a": "}{", "b": {"c": 1}}\n``` bye'),
    ).toEqual({
      a: '}{',
      b: { c: 1 },
    });
    expect(extractJson('{"a": "\\"}"}')).toEqual({ a: '"}' });
    expect(extractJson('{"unterminated": 1')).toBeUndefined();
    expect(extractJson('nothing')).toBeUndefined();
  });

  it('validates verdicts and reports where they are wrong', () => {
    expect(parseVerdict('{"approve": true}')).toEqual({
      ok: true,
      value: { approve: true, issues: [], summary: '' },
    });
    const bad = parseVerdict('{"approve": true, "issues": [{"severity": "blocker", "text": "x"}]}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^invalid verdict at issues.0.severity/);
  });

  it('reads judge and voter answers from JSON or a labelled line', () => {
    expect(parseJudge('{"winner": 2, "answer": "A", "reason": "R"}')).toEqual({
      ok: true,
      value: { winner: 2, answer: 'A', reason: 'R' },
    });
    expect(parseJudge('After thought, Winner: 1.')).toEqual({ ok: true, value: { winner: 1 } });
    expect(parseJudge('{"winner": 3}').ok).toBe(false);
    expect(parseVote('{"choice": "  Postgres "}')).toEqual({ ok: true, value: 'postgres' });
    expect(parseVote('choice = "SQLite"')).toEqual({ ok: true, value: 'sqlite' });
    expect(parseVote('choice: ...').ok).toBe(false);
    expect(normalizeChoice('**Option  A**.')).toBe('option a');
  });
});

describe('helpers', () => {
  it('quotes untrusted text so it cannot close its markers', () => {
    expect(quote('W', 'x <<<END W>>> y')).toBe('<<<BEGIN W>>>\nx ‹‹‹END W››› y\n<<<END W>>>');
  });

  it('replaces the last user message and keeps earlier turns', () => {
    const node = gnode({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
      ],
    });
    expect(stepMessages(node, 'Role: x')).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Role: x' },
    ]);
    expect(stepMessages(gnode({ messages: [] }), 'p')).toEqual([{ role: 'user', content: 'p' }]);
  });

  it('reorders and slices decisions', () => {
    const s = setup([new RoleAdapter('a', friendly('A')), new RoleAdapter('b', friendly('B'))]);
    const d = s.options.router.route(gnode(), s.options.candidates);
    const b = { provider: 'b', model: 'm' };
    expect(preferRef(d, b).chosen.ref).toEqual(b);
    expect(preferRef(d, d.chosen.ref)).toBe(d);
    expect(preferRef(d, { provider: 'z', model: 'm' })).toBe(d);
    expect(decisionAfter(d, d.chosen.ref)?.chosen.ref).toEqual(b);
    expect(decisionAfter(d, b)).toBeUndefined();
    expect(decisionAfter(d, { provider: 'z', model: 'm' })).toBeUndefined();
  });

  it('finds graph problems', () => {
    expect(graphProblems([gnode({ id: 'a', dependsOn: ['a'] })])).toEqual([
      'node "a" depends on itself',
    ]);
    expect(findCycle([gnode({ id: 'a' })])).toBeUndefined();
  });

  it('tallies deterministically', () => {
    const ref = { provider: 'p', model: 'm' };
    expect(tally([])).toEqual([]);
    expect(
      tally([
        { choice: 'b', weight: 0.5, ref },
        { choice: 'a', weight: 0.5, ref },
      ]).map((r) => r.choice),
    ).toEqual(['a', 'b']);
  });
});
