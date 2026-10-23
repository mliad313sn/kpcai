import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENT_DIR,
  agentArgs,
  agentProviders,
  loadAgentDescriptors,
  parseAgentDescriptor,
} from './descriptor.js';
import { agentEnv, isScrubbed } from './env.js';
import { looksRateLimited, parseOutput, pick, sanitize } from './output.js';
import { fakeAgentDescriptor } from '../test-helpers/agent-repo.js';

describe('agent descriptors', () => {
  it('ships the four agents of R-503, each with a provider identity and no model id', () => {
    const all = loadAgentDescriptors([BUILTIN_AGENT_DIR]);
    const byId = Object.fromEntries(all.map((d) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual(['claude-code', 'codex', 'gemini-cli', 'opencode']);
    expect(byId['claude-code']?.provider).toBe('anthropic');
    expect(byId['codex']?.provider).toBe('openai');
    expect(byId['gemini-cli']?.provider).toBe('google');
    // A multi-provider CLI counts as every provider it may be backed by (fail safe).
    expect(agentProviders(byId['opencode']!)).toContain('anthropic');
    for (const d of all) {
      expect(d.source).toBe('subscription');
      expect(d.args.join(' ')).not.toMatch(/--model|claude-|gpt-|gemini-\d/);
    }
  });

  it('refuses unsafe or incomplete descriptors', () => {
    const base = 'id: a\nname: A\nprovider: x\njurisdiction: US\noutput: { format: text }\n';
    expect(() => parseAgentDescriptor(`${base}binary: 'sh -c x'\nargs: ['{prompt}']`, 'f')).toThrow(
      /binary/,
    );
    expect(() => parseAgentDescriptor(`${base}binary: a\nargs: ['-p']`, 'f')).toThrow(/\{prompt\}/);
    expect(() =>
      parseAgentDescriptor(
        `${base}binary: a\nargs: ['{prompt}']\nscrubEnv: [AWS_REGION]`.replace('text', 'text'),
        'f',
      ),
    ).toThrow(/credential-shaped/);
    expect(() =>
      parseAgentDescriptor(
        'id: a\nname: A\nprovider: x\njurisdiction: US\nbinary: a\nargs: ["{prompt}"]\noutput: { format: json }',
        'f',
      ),
    ).toThrow(/needs `text`/);
    const ok = parseAgentDescriptor(`${base}binary: a\nargs: []\npromptVia: stdin`, 'f');
    expect(agentArgs(ok, 'hello')).toEqual([]);
  });

  it('substitutes the prompt as one argument, never through a shell', () => {
    const d = fakeAgentDescriptor();
    const args = agentArgs(d, 'a; rm -rf / "$(x)"');
    expect(args).toContain('a; rm -rf / "$(x)"');
    expect(args.filter((a) => a.includes('rm -rf'))).toHaveLength(1);
  });

  it('lets a user directory override a built-in agent, and skips invalid files on request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kpai-agents-'));
    try {
      writeFileSync(
        join(dir, 'opencode.yaml'),
        'id: opencode\nname: opencode\nbinary: opencode\nargs: [run, "{prompt}"]\nprovider: mistral\njurisdiction: EU\noutput: { format: text }\n',
      );
      writeFileSync(join(dir, 'bad.yaml'), 'id: Bad!\n');
      const bad: string[] = [];
      const all = loadAgentDescriptors([BUILTIN_AGENT_DIR, dir, join(dir, 'none')], (p) =>
        bad.push(p),
      );
      expect(all.find((d) => d.id === 'opencode')?.provider).toBe('mistral');
      expect(bad).toHaveLength(1);
      expect(() => loadAgentDescriptors([dir])).toThrow(/Invalid agent descriptor/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agent environment', () => {
  it("removes KernelPAI's keys and every credential-shaped variable, keeps the login", () => {
    const env = agentEnv(
      {
        PATH: '/bin',
        HOME: '/home/u',
        ANTHROPIC_API_KEY: 'k1',
        MY_PROVIDER_TOKEN_VAR: 'kept',
        CUSTOM_LLM_KEY: 'k2',
        GITHUB_TOKEN: 'k3',
        AWS_SECRET_ACCESS_KEY: 'k4',
        KPAI_HOME: '/x',
        UNDEF: undefined,
      },
      ['CUSTOM_LLM_KEY', 'GITHUB_TOKEN'],
      { TMPDIR: '/t' },
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      MY_PROVIDER_TOKEN_VAR: 'kept',
      TMPDIR: '/t',
    });
    expect(isScrubbed('OPENAI_API_KEY', [])).toBe(true);
    expect(isScrubbed('PATH', [])).toBe(false);
  });
});

describe('agent output', () => {
  const d = fakeAgentDescriptor();

  it('reads text, notional cost and tokens from JSON', () => {
    const out = JSON.stringify({
      result: 'done',
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    expect(parseOutput(d, out, '', 0)).toEqual({
      text: 'done',
      usage: { reportedUsd: 0.5, inputTokens: 10, outputTokens: 2 },
      error: false,
      rateLimited: false,
    });
  });

  it('treats malformed JSON as plain text and ignores ill-typed usage', () => {
    const r = parseOutput(d, 'not json', '', 0);
    expect(r.text).toBe('not json');
    expect(r.usage).toEqual({});
    const bad = JSON.stringify({ result: 3, total_cost_usd: -1, usage: { input_tokens: 'x' } });
    expect(parseOutput(d, bad, '', 0).usage).toEqual({});
  });

  it('reads the last JSON line of jsonl output', () => {
    const j = fakeAgentDescriptor({ output: { format: 'jsonl', text: 'msg' } });
    expect(parseOutput(j, '{"msg":"a"}\nnoise\n{"msg":"b"}\n', '', 0).text).toBe('b');
    expect(parseOutput(j, 'noise only', '', 0).text).toBe('noise only');
  });

  it('flags rate limits only on failure, by pattern or exit code', () => {
    expect(parseOutput(d, '', 'usage limit reached', 1).rateLimited).toBe(true);
    expect(parseOutput(d, '', 'usage limit reached', 0).rateLimited).toBe(false);
    const coded = fakeAgentDescriptor({ rateLimit: { exitCodes: [75], patterns: ['(bad'] } });
    expect(looksRateLimited(coded, 'x', 75)).toBe(true);
    expect(looksRateLimited(coded, 'x', 1)).toBe(false);
  });

  it('strips terminal escapes, control bytes and bidi overrides', () => {
    expect(sanitize('a\u001b[31mb\u001b]0;t\u0007c\u0000d\u202ee\r\nf')).toBe('abcde\nf');
  });

  it('walks own properties only', () => {
    const data = JSON.parse('{"__proto__":{"x":1},"a":{"b":2}}') as unknown;
    expect(pick(data, '__proto__.x')).toBeUndefined();
    expect(pick(data, 'a.b')).toBe(2);
    expect(pick(data, 'a.c.d')).toBeUndefined();
    expect(pick(data, undefined)).toBeUndefined();
  });

  it('caps a long summary', () => {
    expect(parseOutput(d, 'y'.repeat(20_000), '', 0).text.length).toBeLessThanOrEqual(8_000);
  });
});
