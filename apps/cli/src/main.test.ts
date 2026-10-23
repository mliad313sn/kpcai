import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Journal } from '@kernelpai/journal';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';

function journalOf(io: FakeIo): Journal {
  return Journal.open(join(io.home, 'journal.db'));
}

function lastSessionEvents(io: FakeIo): string[] {
  const j = journalOf(io);
  try {
    const [s] = j.sessions(1);
    return j.events({ sessionId: s!.id }).map((e) => e.type);
  } finally {
    j.close();
  }
}

describe('kpai CLI', () => {
  it('prints usage for help and no command', async () => {
    const io = fakeIo();
    expect(await main([], io)).toBe(0);
    expect(await main(['--help'], io)).toBe(0);
    expect(io.stdout).toContain('kpai ask -m <provider/model>');
  });

  it('rejects unknown commands, bad flags and bad numbers', async () => {
    const io = fakeIo();
    expect(await main(['frobnicate'], io)).toBe(2);
    expect(await main(['ask', '--bogus', 'x'], io)).toBe(2);
    expect(await main(['ask', '-m', 'mock/echo', '--max-tokens', '0', 'x'], io)).toBe(2);
    expect(await main(['ask', '-m', 'mock/echo'], io)).toBe(2);
    expect(await main(['export'], io)).toBe(2);
    expect(io.stderr).toContain('Unknown command "frobnicate"');
  });

  it('lists providers with detection status', async () => {
    const io = fakeIo();
    expect(await main(['providers'], io)).toBe(0);
    expect(io.stdout).toMatch(/ok\s+mock/);
    expect(io.stdout).toMatch(/--\s+anthropic .*ANTHROPIC_API_KEY is not set/);
    expect(io.stdout).toMatch(/--\s+ollama .*not reachable/);
    expect(io.stdout).toContain('anthropic/claude-opus-5-5');
  });

  it('never picks a model by default (principle 1)', async () => {
    const io = fakeIo();
    expect(await main(['ask', 'hello'], io)).toBe(2);
    expect(io.stderr).toContain('never picks a model by default');
  });

  it('streams an answer and journals routing, call and response with cost', async () => {
    const io = fakeIo();
    expect(await main(['ask', '-m', 'mock/echo', '--system', 'brief', 'hello', 'kernel'], io)).toBe(
      0,
    );
    expect(io.stdout).toBe('[mock/echo] You asked: hello kernel\n');
    expect(io.stderr).toMatch(/^estimate: ~\d+ in, ≤4096 out/);
    expect(io.stderr).toMatch(/— mock\/echo · .* · end · session [0-9a-f]{8}/);
    expect(lastSessionEvents(io)).toEqual(['routing', 'call', 'response']);
    const j = journalOf(io);
    const routing = j.events()[0]!;
    expect(routing.payload['reason']).toMatch(/explicit user choice/);
    expect(j.sessions()[0]!.costUsd).toBeGreaterThan(0);
    j.close();
  });

  it('asks before spending above the threshold and journals a refusal (principle 6)', async () => {
    const io = fakeIo({ KPAI_CONFIRM_ABOVE_USD: '0' });
    expect(await main(['ask', '-m', 'mock/echo', 'pricey'], io)).toBe(4);
    expect(io.questions[0]).toMatch(/above your threshold \$0/);
    expect(io.stdout).toBe('');
    expect(lastSessionEvents(io)).toEqual(['routing', 'intervention']);
    io.confirmAnswers.push(true);
    expect(await main(['ask', '-m', 'mock/echo', 'pricey'], io)).toBe(0);
    expect(await main(['ask', '-y', '-m', 'mock/echo', 'pricey'], io)).toBe(0);
    expect(io.questions).toHaveLength(2);
  });

  it('rejects an invalid threshold', async () => {
    const io = fakeIo({ KPAI_CONFIRM_ABOVE_USD: 'lots' });
    expect(await main(['ask', '-m', 'mock/echo', 'x'], io)).toBe(1);
    expect(io.stderr).toMatch(/KPAI_CONFIRM_ABOVE_USD must be/);
  });

  it('journals provider failures with their kind', async () => {
    const io = fakeIo();
    expect(await main(['ask', '-m', 'mock/echo', '[[fail:rate_limit]]'], io)).toBe(1);
    expect(io.stderr).toMatch(/error \(rate_limit\): Simulated rate_limit/);
    expect(lastSessionEvents(io)).toEqual(['routing', 'call', 'error']);
    expect(await main(['ask', '-m', 'nobody/x', 'hi'], io)).toBe(1);
    expect(await main(['ask', '-m', 'mock/unknown-model', 'hi'], io)).toBe(1);
  });

  it('cancels on Ctrl+C, keeps the partial answer and records the intervention (principle 4)', async () => {
    const io = fakeIo();
    const run = main(['ask', '-m', 'mock/echo', '[[slow]] one two three four five six'], io);
    await new Promise((r) => setTimeout(r, 120));
    io.interrupt();
    expect(await run).toBe(130);
    expect(lastSessionEvents(io)).toEqual(['routing', 'call', 'intervention', 'response']);
    const j = journalOf(io);
    const resp = j.events().at(-1)!;
    expect(resp.payload['stopReason']).toBe('cancelled');
    expect(resp.payload['usageBasis']).toBe('estimated');
    expect(resp.costUsd).toBeGreaterThan(0);
    expect(String(resp.payload['text']).length).toBeGreaterThan(0);
    j.close();
  });

  it('lists sessions, shows events, exports Markdown and verifies the chain', async () => {
    const io = fakeIo();
    await main(['ask', '-m', 'mock/echo', 'first'], io);
    io.stdout = '';
    expect(await main(['log'], io)).toBe(0);
    const id = io.stdout.slice(0, 8);
    expect(io.stdout).toContain('first');
    expect(await main(['log', '--session', id, '--limit', '10'], io)).toBe(0);
    expect(io.stdout).toMatch(/#1 .* routing\s+mock\/echo/);
    expect(await main(['log', '-s', 'zzzz'], io)).toBe(1);
    const out = join(io.home, 'session.md');
    expect(await main(['export', id, '--out', out], io)).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('## Answer');
    io.stdout = '';
    expect(await main(['export', id], io)).toBe(0);
    expect(io.stdout).toContain(`# KernelPAI session ${id}`);
    expect(await main(['export', 'zzzz'], io)).toBe(1);
    expect(await main(['verify'], io)).toBe(0);
    expect(io.stdout).toContain('hash chain intact');
  });

  it('flags a tampered journal', async () => {
    const io = fakeIo();
    await main(['ask', '-m', 'mock/echo', 'x'], io);
    const db = new DatabaseSync(join(io.home, 'journal.db'));
    db.exec("UPDATE events SET cost_usd = 0 WHERE type = 'response'");
    db.close();
    expect(await main(['verify'], io)).toBe(3);
    expect(io.stderr).toContain('journal TAMPERED');
  });
});
