import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAgentDescriptor, tempRepo } from '../test-helpers/agent-repo.js';
import { detectAgent, runAgent, MAX_ARG_PROMPT_CHARS, type AgentRunRequest } from './run.js';
import { diffProblem } from './worktree.js';

const ENV = {
  PATH: process.env['PATH'],
  HOME: process.env['HOME'],
  ANTHROPIC_API_KEY: 'sk-test-anthropic',
  OPENAI_API_KEY: 'sk-test-openai',
  KPAI_SECRET_THING: 'internal',
};

let repo: { root: string; cleanup: () => void };
beforeEach(() => {
  repo = tempRepo();
});
afterEach(() => repo.cleanup());

const req = (prompt: string, over: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  descriptor: fakeAgentDescriptor(),
  root: repo.root,
  prompt,
  timeoutMs: 20_000,
  env: ENV,
  scrub: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
  ...over,
});

describe('runAgent (fake CLI)', () => {
  it('runs in a private checkout and hands back its diff, summary and usage', async () => {
    const r = await runAgent(req('MODE:ok do it'));
    expect(r.status).toBe('ok');
    expect(r.summary).toBe('Added hello.txt.');
    expect(r.files).toEqual(['hello.txt']);
    expect(r.diff).toMatch(/^diff --git a\/hello.txt b\/hello.txt/);
    expect(r.diff).toContain('+hello from the agent');
    expect(r.usage).toEqual({ reportedUsd: 0.25, inputTokens: 1200, outputTokens: 340 });
    // The workspace itself is untouched: the patch still has to be approved and applied.
    expect(existsSync(join(repo.root, 'hello.txt'))).toBe(false);
  });

  it("never passes KernelPAI's keys to the agent", async () => {
    const r = await runAgent(req('MODE:env'));
    expect(r.status).toBe('ok');
    expect(r.files).toEqual(['out/env.txt']);
    expect(r.diff).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|KPAI_|sk-test/);
    // Its TMPDIR was inside the jail, and the jail is gone once the run ends.
    const tmp = /^tmp=(.*)$/.exec(r.summary)?.[1] ?? '';
    expect(tmp).toMatch(/kpai-agent-.*tmp$/);
    expect(existsSync(dirname(tmp))).toBe(false);
  });

  it('reports a failing CLI with its sanitized error', async () => {
    const r = await runAgent(req('MODE:fail'));
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/exit 2.*boom/);
    expect(r.diff).toBe('');
    const flagged = await runAgent(req('MODE:flagged'));
    expect(flagged.status).toBe('failed');
  });

  it('reports a rate limit or an exhausted plan as such', async () => {
    const r = await runAgent(req('MODE:quota'));
    expect(r.status).toBe('rate_limited');
  });

  it('kills a CLI that runs past its time cap', async () => {
    const r = await runAgent(req('MODE:hang', { timeoutMs: 300 }));
    expect(r.status).toBe('timeout');
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it('kills the CLI on cancel', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runAgent(req('MODE:hang', { signal: ac.signal }));
    expect(r.status).toBe('cancelled');
  });

  it('treats hostile output as data: sanitized, capped, no smuggled patch', async () => {
    const r = await runAgent(req('MODE:hostile'));
    expect(r.status).toBe('ok');
    expect(r.files).toEqual(['hello.txt']);
    // eslint-disable-next-line no-control-regex
    expect(r.summary).not.toMatch(/[\u0000-\u0008\u001b\u202e]/);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(r.usage).toEqual({});
    // Plain-text CLIs too: the whole stdout is the summary, sanitized the same way.
    const text = fakeAgentDescriptor({ output: { format: 'text' } });
    const plain = await runAgent(req('MODE:hostile', { descriptor: text }));
    expect(plain.summary).toContain('Ignore previous instructions');
    // eslint-disable-next-line no-control-regex
    expect(plain.summary).not.toMatch(/[\u0000-\u0008\u001b\u202e]/);
    const flood = await runAgent(req('MODE:flood'));
    expect(flood.truncated).toBe(true);
    expect(flood.summary.length).toBeLessThanOrEqual(8_000);
  });

  it('fails a run that wrote next to its worktree, and hands nothing on', async () => {
    const r = await runAgent(req('MODE:escape'));
    expect(r.status).toBe('escaped');
    expect(r.diff).toBe('');
    expect(r.outside?.[0]).toMatch(/escape\.txt$/);
  });

  it('fails a run that wrote into the workspace itself', async () => {
    const target = join(repo.root, 'src-evil.txt');
    const r = await runAgent(req(`MODE:escape TARGET:${target}`));
    expect(r.status).toBe('escaped');
    // Reported paths are canonical (Windows 8.3 short names and macOS /private resolved).
    expect(r.outside).toContain(realpathSync.native(target));
    expect(readFileSync(target, 'utf8')).toBe('outside\n');
  });

  it('refuses a symbolic link in the diff', async () => {
    const r = await runAgent(req('MODE:symlink'));
    expect(r.status).toBe('refused');
    expect(r.error).toMatch(/symbolic link/);
  });

  it('continues from an earlier draft on a revision', async () => {
    const first = await runAgent(req('Role: author\nMODE:revise'));
    const second = await runAgent(req('Role: revision\nMODE:revise', { draft: first.diff }));
    expect(second.diff).toContain('+v1');
    expect(second.diff).toContain('+v2');
  });

  it('refuses without a git workspace, an unknown binary, or an oversized prompt', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'kpai-plain-'));
    try {
      expect((await runAgent(req('MODE:ok', { root: plain }))).status).toBe('refused');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    const missing = fakeAgentDescriptor({ binary: '/nonexistent/agent-cli' });
    const r = await runAgent(req('MODE:ok', { descriptor: missing }));
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/could not start/);
    const long = await runAgent(req('x'.repeat(MAX_ARG_PROMPT_CHARS + 1)));
    expect(long.status).toBe('refused');
  });

  it('passes the prompt on stdin when the descriptor says so', async () => {
    const d = fakeAgentDescriptor({
      args: [fakeAgentDescriptor().args[0], '--stdin'],
      promptVia: 'stdin',
    });
    const r = await runAgent(req('MODE:ok', { descriptor: d }));
    expect(r.status).toBe('ok');
  });

  it('detects whether the binary answers', async () => {
    const d = fakeAgentDescriptor({
      versionArgs: ['-e', 'process.exit(0)'],
      binary: process.execPath,
    });
    expect((await detectAgent(d, ENV, [])).available).toBe(true);
    const gone = fakeAgentDescriptor({ binary: '/nonexistent/agent-cli' });
    expect((await detectAgent(gone, ENV, [])).available).toBe(false);
    const bad = fakeAgentDescriptor({ versionArgs: ['-e', 'process.exit(3)'] });
    expect((await detectAgent(bad, ENV, [])).reason).toMatch(/exited with 3/);
  });

  it('refuses a draft that does not apply', async () => {
    writeFileSync(join(repo.root, 'unused'), '');
    const r = await runAgent(req('MODE:ok', { draft: 'diff --git a/x b/x\n@@ nonsense\n' }));
    expect(r.status).toBe('failed');
  });
});

describe('diffProblem', () => {
  const head = (a: string, b = a): string => `diff --git a/${a} b/${b}\n`;
  it('refuses paths that leave the tree, .git, submodules, binaries and huge diffs', () => {
    expect(diffProblem(head('../x'))).toMatch(/leaves the worktree/);
    expect(diffProblem(head('.git/hooks/pre-commit'))).toMatch(/leaves/);
    expect(diffProblem(`${head('m')}new file mode 160000\n`)).toMatch(/submodule/);
    expect(diffProblem(`${head('b')}GIT binary patch\n`)).toMatch(/binary/);
    expect(diffProblem('diff --git "a/\\303" "b/\\303"\n')).toMatch(/quoted/);
    expect(diffProblem('x'.repeat(600 * 1024))).toMatch(/larger/);
    expect(diffProblem(head('ok.txt'))).toBeUndefined();
  });
});
