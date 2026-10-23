/**
 * Unified memory end to end (ADR-0027, phase 4 WP5): a model proposes a fact, a human
 * confirms it, and every later call carries it; a local-only fact never reaches a cloud
 * provider. "Reaches the model" is measured, not assumed: the mock adapter reports the
 * input tokens of the messages it was actually sent, which we compare with the request the
 * executor journaled for that call.
 */
import {
  ASK,
  expect,
  journal,
  planAndRun,
  test,
  type Client,
  type JournalEvent,
} from '../fixtures/phase4.js';

interface Fact {
  id: string;
  text: string;
  provenance: { source: string; evidence: string[]; localOnly: boolean; confirmed?: string };
}

interface Message {
  role: string;
  content: string;
}

const PROPOSED = 'Deploy with make release';
const HUMAN = 'Use pnpm for every install';
const LOCAL =
  'Lab build host is gpu-box-55217 on the internal network; this name must stay on this machine and never be sent to a hosted model.';

/** The mock's own count: Σ ceil(chars / 4) over the messages it received. */
const tokens = (messages: readonly Message[]): number =>
  messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);

interface Sent {
  provider: string;
  journaled: Message[];
  /** Input tokens the mock reported for what it was really sent. */
  received: number;
}

/** Each answered call after `from`: the journaled request and what the mock reported. */
function calls(events: readonly JournalEvent[], from: number): Sent[] {
  const requests = new Map<string, Message[]>();
  const out: Sent[] = [];
  for (const e of events.filter((x) => x.seq > from)) {
    const id = String(e.payload['requestId'] ?? '');
    if (e.type === 'call') {
      const req = e.payload['request'] as { messages: Message[] };
      requests.set(id, req.messages);
    } else if (e.type === 'response' && requests.has(id)) {
      out.push({
        provider: String(e.provider),
        journaled: requests.get(id) as Message[],
        received: Number(e.payload['inputTokens']),
      });
    }
  }
  return out;
}

const lastSeq = async (c: Client): Promise<number> => (await journal(c)).at(-1)?.seq ?? 0;

test('a model proposes, a human confirms, and the fact reaches every later call', async ({ c }) => {
  const request = `${ASK}\n\`\`\`memory\n- [project] ${PROPOSED}\n\`\`\``;
  const first = await planAndRun(c, request);
  expect(first.done.result.ok).toBe(true);

  // A proposal is not memory: it waits for a human, with the model and the run as evidence.
  const { pending } = await c.call<{ pending: Fact[] }>('memory.pending');
  expect(pending).toHaveLength(1);
  const p = pending[0]!;
  expect(p.text).toBe(PROPOSED);
  expect(p.provenance.source).toMatch(/^mock-[a-z]+\/m1$/);
  expect(p.provenance.evidence).toContain(`run:${first.runId}`);
  const before = await c.call<{ facts: unknown[] }>('memory.list', { layer: 'project' });
  expect(before.facts).toHaveLength(0);

  const { fact } = await c.call<{ fact: Fact }>('memory.confirm', { id: p.id });
  expect(fact.provenance).toMatchObject({ source: p.provenance.source, localOnly: false });
  expect(fact.provenance.confirmed).toBeTruthy();
  const human = await c.call<{ fact: { id: string } }>('memory.add', {
    layer: 'project',
    text: HUMAN,
  });

  // Injection: the plan names both facts and how far each is trusted (never the text).
  const from = await lastSeq(c);
  const second = await planAndRun(c, ASK);
  const included = second.plan.memory!.included;
  expect(included).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: fact.id, trust: 'untrusted' }),
      expect.objectContaining({ id: human.fact.id, source: 'human', trust: 'user' }),
    ]),
  );
  const sent = calls(await journal(c), from);
  expect(sent.length).toBe(Object.keys(second.done.result.results).length);
  for (const s of sent) {
    const text = s.journaled.map((m) => m.content).join('\n');
    expect(text).toContain(PROPOSED);
    expect(text).toContain(HUMAN);
    // What the journal shows is exactly what the model was sent.
    expect(s.received).toBe(tokens(s.journaled));
  }
});

test('a local-only fact never reaches a cloud model, and reaches a local one', async ({ c, k }) => {
  await c.call('memory.add', { layer: 'project', text: LOCAL, localOnly: true });
  await c.call('memory.add', { layer: 'project', text: HUMAN });

  const from = await lastSeq(c);
  const cloud = await planAndRun(c, ASK);
  expect(cloud.plan.memory!.localOnly).toBe(1);
  const toCloud = calls(await journal(c), from);
  expect(toCloud.length).toBeGreaterThan(0);
  for (const s of toCloud) {
    expect(s.provider).toMatch(/^mock-(alpha|beta|gamma|delta)$/);
    expect(JSON.stringify(s.journaled)).toContain(HUMAN);
    // Nothing beyond the journaled request reached the cloud mock: no hidden fact.
    expect(s.received).toBe(tokens(s.journaled));
  }

  // Positive control: a local provider gets the withheld fact on top of the same request.
  k.addLocalMock();
  const mark = await lastSeq(c);
  const local = await planAndRun(c, ASK, { options: { localOnly: true } });
  expect(local.done.result.ok).toBe(true);
  const toLocal = calls(await journal(c), mark);
  expect(toLocal.length).toBeGreaterThan(0);
  for (const s of toLocal) {
    expect(s.provider).toBe('mock-local');
    expect(s.received - tokens(s.journaled)).toBeGreaterThanOrEqual(
      Math.floor(LOCAL.length / 4) - 8,
    );
  }
  // The journal never holds the local-only text, whoever received it.
  expect(JSON.stringify(await journal(c))).not.toContain('gpu-box-55217');
});
