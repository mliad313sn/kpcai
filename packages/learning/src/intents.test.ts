/** J1: the intent each run serves, from the journal only (forks inherit, proxy otherwise). */
import { describe, expect, it } from 'vitest';
import { readRuns } from './grades.js';
import { intentsOf, started } from './intents.js';
import { Script } from './test-helpers/script.js';
import { intent } from './test-helpers/north-star.js';

function run(s: Script, runId: string, before: () => void = () => {}): void {
  s.plan([{ id: 'n1', type: 'code_generation' }]);
  before();
  s.answer('n1', 'alpha/m', 'author', 'x');
  s.outcome(runId);
}

describe('intentsOf', () => {
  it('follows forks to the parent’s intent, and stops at a cycle or a missing parent', () => {
    const s = new Script();
    run(s, 'root', () => intent(s, 'root', 'ticket:42'));
    run(s, 'f1', () => s.note({ action: 'run started', runId: 'f1', parent: { runId: 'root' } }));
    run(s, 'f2', () => s.note({ action: 'run started', runId: 'f2', parent: { runId: 'f1' } }));
    run(s, 'orphan', () =>
      s.note({ action: 'run started', runId: 'orphan', parent: { runId: 'gone' } }),
    );
    run(s, 'self', () =>
      s.note({ action: 'run started', runId: 'self', parent: { runId: 'self' } }),
    );
    run(s, 'a', () => s.note({ action: 'run started', runId: 'a', parent: { runId: 'b' } }));
    run(s, 'b', () => s.note({ action: 'run started', runId: 'b', parent: { runId: 'a' } }));
    const i = intentsOf(readRuns(s.j));
    expect(i.get('f2')).toEqual({
      key: 'human-request|ticket:42',
      id: 'ticket:42',
      origin: 'human-request',
    });
    expect(i.get('orphan')?.key).toBe('proxy|orphan');
    expect(i.get('self')?.key).toBe('proxy|self');
    // A fork cycle (never written by the kernel) ends at the depth limit as a proxy.
    expect(i.get('a')?.origin).toBe('proxy');
  });

  it('ignores malformed intents; a run with neither start nor intent was not started', () => {
    const s = new Script();
    run(s, 'bad', () => {
      s.note({ action: 'run intent', runId: 'bad', intent: { id: 7, origin: 'human-request' } });
      s.note({ action: 'run intent', runId: 'bad' });
    });
    run(s, 'planned-only');
    const runs = readRuns(s.j);
    expect(intentsOf(runs).get('bad')?.key).toBe('proxy|bad');
    expect(runs.runs.map(started)).toEqual([true, false]);
  });
});
