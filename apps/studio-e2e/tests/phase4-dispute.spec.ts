/**
 * R-405 end to end: a 1–1–1 vote is disputed and asks the human through `confirm.request`
 * (kind `dispute`). Silence, or a yes without a choice, fails closed (no output, nothing
 * delivered); an offered choice settles it with that option's text.
 */
import {
  CONFIRM_TIMEOUT_MS,
  expect,
  journal,
  planAndRun,
  test,
  type Client,
} from '../fixtures/phase4.js';

const VOTE =
  'which license should we pick? [[vote:MIT@mock-alpha]] [[vote:Apache@mock-beta]] [[vote:GPL@mock-gamma]] [[vote:BSD@mock-delta]]';

interface Dispute {
  nodeId: string;
  kind: string;
  reason: string;
  options: Array<{ id: string; label: string; text: string; backers: string[] }>;
}

/** Plans the decision, turns its protocol into a three-voter vote (R-301 edit) and runs it. */
async function vote(c: Client) {
  const plan = await c.call<{ planId: string; graph: { nodes: Array<{ id: string }> } }>('plan', {
    request: VOTE,
    options: { isolated: false },
  });
  const nodes = plan.graph.nodes.map((n) => ({ ...n, protocol: 'vote' }));
  expect(nodes.map((n) => n.id)).toEqual(['decision']);
  return planAndRun(c, VOTE, { graph: { nodes } });
}

const disputeOf = (c: Client): Dispute =>
  c.confirms.find((x) => x['kind'] === 'dispute')?.['dispute'] as Dispute;

test('a split vote with no human answer fails closed', async ({ c }) => {
  const started = Date.now();
  const { done } = await vote(c);
  const d = disputeOf(c);
  expect(d).toMatchObject({ nodeId: 'decision', kind: 'vote' });
  expect(d.reason).toMatch(/no majority among 3 voters \(1–1–1\)/);
  expect(d.options).toHaveLength(3);
  for (const o of d.options) expect(o.backers).toHaveLength(1);
  // Nobody answered: the kernel waited the confirmation timeout, then refused to pick.
  expect(Date.now() - started).toBeGreaterThanOrEqual(CONFIRM_TIMEOUT_MS);
  expect(done.result.states['decision']).toBe('failed');
  expect(done.result.ok).toBe(false);
  expect(done.result.results['decision']!.output).toBe('');
  expect(done.result.results['decision']!.error).toMatch(/disputed/);
  expect(done.result.deliverables?.['decision']).toBeUndefined();
  expect(done.result.disputes?.['decision']).toMatchObject({ choice: null, by: 'none' });
  const actions = (await journal(c)).map((e) => e.payload['action']);
  expect(actions).toContain('node disputed');
});

test('a yes without a choice is not a choice: still failed', async ({ c }) => {
  c.answer = (q) => (q['kind'] === 'dispute' ? { ok: true } : undefined);
  const { done } = await vote(c);
  expect(disputeOf(c)).toBeTruthy();
  expect(done.result.states['decision']).toBe('failed');
  expect(done.result.disputes?.['decision']).toMatchObject({ by: 'none' });
});

test('the human settles the dispute by picking an offered option', async ({ c }) => {
  let picked: Dispute['options'][number] | undefined;
  c.answer = (q) => {
    if (q['kind'] !== 'dispute') return undefined;
    picked = (q['dispute'] as Dispute).options[1];
    return { ok: true, choice: picked!.id };
  };
  const { done } = await vote(c);
  expect(picked).toBeTruthy();
  expect(done.result.states['decision']).toBe('done');
  expect(done.result.results['decision']!.output).toBe(picked!.text);
  expect(done.result.disputes?.['decision']).toMatchObject({ choice: picked!.id, by: 'human' });
});
