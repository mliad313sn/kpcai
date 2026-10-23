import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Journal } from '@kernelpai/journal';
import { main } from './main.js';
import { fakeIo, type FakeIo } from './test-helpers/fake-io.js';
import { THREE_MOCKS, writeMockProviders } from './test-helpers/mock-providers.js';

function io3(env: Record<string, string> = {}): FakeIo {
  const io = fakeIo(env);
  writeMockProviders(io.home, THREE_MOCKS);
  return io;
}

function events(
  io: FakeIo,
): Array<{ type: string; provider: string | null; payload: Record<string, unknown> }> {
  const j = Journal.open(join(io.home, 'journal.db'));
  try {
    return j.events();
  } finally {
    j.close();
  }
}

const CODE = 'write a typescript function that parses dates';

describe('kpai route / run / stats', () => {
  it('route classifies, plans and explains without sending anything', async () => {
    const io = io3();
    expect(await main(['route', '--allow-test', CODE], io)).toBe(0);
    expect(io.stdout).toMatch(/^plan\s+n1 · code_generation/);
    expect(io.stdout).toMatch(
      /route\s+mock-beta\/m1 for code_generation: score .* beats mock-alpha\/m1/,
    );
    expect(io.stdout).toMatch(/→\s+mock-beta\/m1/);
    expect(events(io)).toEqual([]);
  });

  it('never routes to test providers unless allowed, and says what to do', async () => {
    const io = io3();
    expect(await main(['route', CODE], io)).toBe(1);
    expect(io.stderr).toMatch(/provider kind "test" excluded/);
    const none = fakeIo({
      KPAI_HOME: io.home,
      OLLAMA_HOST: 'http://127.0.0.1:9',
      LLAMACPP_BASE_URL: 'http://127.0.0.1:9/v1',
    });
    expect(
      await main(
        ['route', '--verbose', '--exclude', 'mock,mock-alpha,mock-beta,mock-gamma', CODE],
        none,
      ),
    ).toBe(1);
  });

  it('profiles change the decision (performance favours competence over cost)', async () => {
    const io = io3();
    await main(['route', '--allow-test', '-p', 'performance', CODE], io);
    expect(io.stdout).toMatch(/→\s+mock-alpha\/m1/);
  });

  it('honours --type, --local-only and --exclude', async () => {
    const io = io3();
    await main(['route', '--allow-test', '--type', 'writing', 'anything'], io);
    expect(io.stdout).toMatch(/writing \(100 %: set with --type\)/);
    expect(await main(['route', '--allow-test', '--local-only', 'anything'], io)).toBe(1);
    expect(io.stderr).toMatch(/mock-gamma\/m1: local only/);
    io.stdout = '';
    await main(['route', '--allow-test', '--exclude', 'mock-beta', '--verbose', CODE], io);
    expect(io.stdout).toMatch(/✗ mock-beta\/m1: .*denied/);
    expect(await main(['route', '--type', 'poetry', 'x'], io)).toBe(2);
    expect(await main(['route', '--criticality', 'huge', 'x'], io)).toBe(2);
    expect(await main(['route'], io)).toBe(2);
  });

  it('run streams the answer and journals routing with its reason and latency', async () => {
    const io = io3();
    expect(await main(['run', '--allow-test', CODE], io)).toBe(0);
    expect(io.stdout).toContain('You asked: write a typescript function');
    expect(io.stderr).toMatch(/— mock-beta\/m1 · .* · end · 1 attempt\(s\)/);
    const ev = events(io);
    expect(ev.map((e) => e.type)).toEqual(['routing', 'call', 'response']);
    expect(ev[0]!.payload).toMatchObject({
      taskType: 'code_generation',
      fallbacks: ['mock-alpha/m1', 'mock-gamma/m1', 'mock/echo'],
    });
    expect(ev[0]!.payload['elapsedMs']).toEqual(expect.any(Number));
  });

  it('falls back automatically when the chosen model fails', async () => {
    const io = io3();
    expect(await main(['run', '--allow-test', `${CODE} [[fail:rate_limit@mock-beta]]`], io)).toBe(
      0,
    );
    expect(io.stderr).toMatch(/↷ mock-beta\/m1 failed \(rate_limit\)/);
    expect(io.stderr).toMatch(/— mock-alpha\/m1 \(fallback\) · .* 2 attempt\(s\)/);
    expect(events(io).map((e) => e.type)).toEqual([
      'routing',
      'call',
      'error',
      'routing',
      'call',
      'response',
    ]);
    io.stdout = '';
    expect(await main(['stats'], io)).toBe(0);
    expect(io.stdout).toMatch(/fallback rate\s+100\.0 %/);
    expect(io.stdout).toMatch(/fallback success\s+100\.0 %/);
  });

  it('reports failure when every model fails', async () => {
    const io = io3();
    expect(await main(['run', '--allow-test', `${CODE} [[fail:unavailable]]`], io)).toBe(1);
    expect(io.stderr).toMatch(/— nobody · .* 4 attempt\(s\)/);
  });

  it('blocks over budget with options, and journals the refusal (principle 6)', async () => {
    const io = io3({ KPAI_BUDGET_SESSION_USD: '0.0001' });
    expect(await main(['run', '--allow-test', '--yes', CODE], io)).toBe(4);
    expect(io.stderr).toMatch(
      /blocked by session budget: .* Options: reduce_scope, cheaper_models, continue/,
    );
    expect(events(io).map((e) => e.type)).toEqual(['routing', 'intervention']);
  });

  it('asks for confirmation above the threshold', async () => {
    const io = io3({ KPAI_CONFIRM_ABOVE_USD: '0' });
    expect(await main(['run', '--allow-test', CODE], io)).toBe(4);
    expect(io.questions[0]).toMatch(/Continue\?/);
    io.confirmAnswers.push(true);
    expect(await main(['run', '--allow-test', CODE], io)).toBe(0);
  });

  it('cancels on Ctrl+C and keeps the partial answer', async () => {
    const io = io3();
    const run = main(['run', '--allow-test', `${CODE} [[slow]] one two three four five`], io);
    await new Promise((r) => setTimeout(r, 120));
    io.interrupt();
    expect(await run).toBe(130);
    expect(events(io).map((e) => e.type)).toContain('intervention');
  });

  it('stats shows n/a on an empty journal, per session, and in another currency', async () => {
    const io = io3({ KPAI_CURRENCY: 'EUR', KPAI_USD_RATE: '0.9' });
    expect(await main(['stats'], io)).toBe(0);
    expect(io.stdout).toMatch(/fallback rate\s+n\/a/);
    await main(['run', '--allow-test', CODE], io);
    const id = io.stderr.match(/session ([0-9a-f]{8})/)![1]!;
    io.stdout = '';
    expect(await main(['stats', '--session', id], io)).toBe(0);
    expect(io.stdout).toMatch(/avg cost per task\s+€/);
    expect(await main(['stats', '--session', 'zzzz'], io)).toBe(1);
  });
});
