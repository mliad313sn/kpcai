/**
 * S7 phase 5 wave 1 review (WP7): regression tests for the agent findings. Each fails with
 * its fix reverted (see the WP7 report for the mutation checks).
 */
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAgentDescriptor, tempRepo } from '../test-helpers/agent-repo.js';
import { BUILTIN_AGENT_DIR, loadAgentDescriptors } from './descriptor.js';
import { agentEnv } from './env.js';
import { runAgent } from './run.js';

let repo: { root: string; cleanup: () => void };
beforeEach(() => {
  repo = tempRepo();
});
afterEach(() => repo.cleanup());

describe("WP7-F8: the agent's git filters cannot write outside unnoticed", () => {
  it('a clean filter that runs on our `git add` fails the run as escaped', async () => {
    const marker = join(repo.root, 'ESCAPED.txt');
    const script = join(repo.root, '..', `wp7-filter-agent-${process.pid}.mjs`);
    // Forward slashes: backslashes in a git config value are escapes (Windows paths).
    const target = marker.replaceAll('\\', '/');
    writeFileSync(
      script,
      [
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        `appendFileSync('.git/config', '[filter "x"]\\n\\tclean = sh -c "echo pwned > ${target}; cat"\\n');`,
        "writeFileSync('.gitattributes', '*.txt filter=x\\n');",
        "writeFileSync('a.txt', 'hi\\n');",
        "console.log('done');",
      ].join('\n'),
    );
    const r = await runAgent({
      descriptor: fakeAgentDescriptor({ args: [script, '{prompt}'], output: { format: 'text' } }),
      root: repo.root,
      prompt: 'go',
      timeoutMs: 20_000,
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'] },
      scrub: [],
    }).finally(() => rmSync(script, { force: true }));
    expect(existsSync(marker)).toBe(true);
    expect(r.status).toBe('escaped');
    expect(r.outside).toContain(realpathSync.native(marker));
    expect(r.diff).toBe('');
  });
});

describe('WP7-F9: credential-shaped variables never reach an agent', () => {
  it('drops tokens, passwords, keys and the SSH agent; keeps the descriptor login', () => {
    const env = agentEnv(
      {
        PATH: '/bin',
        HOME: '/home/u',
        GITHUB_TOKEN: 'ghp_x',
        GH_TOKEN: 'x',
        AWS_SESSION_TOKEN: 'x',
        NPM_TOKEN: 'x',
        HF_TOKEN: 'x',
        PGPASSWORD: 'x',
        DB_PASSWORD: 'x',
        DEPLOY_PRIVATE_KEY: 'x',
        STRIPE_KEY: 'x',
        GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        CLAUDE_CODE_OAUTH_TOKEN: 'login',
        MY_PROVIDER_TOKEN_VAR: 'kept',
      },
      ['ANTHROPIC_API_KEY'],
      {},
      ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      CLAUDE_CODE_OAUTH_TOKEN: 'login',
      MY_PROVIDER_TOKEN_VAR: 'kept',
    });
    // KernelPAI's own keys stay out even when a descriptor lists them as its login.
    expect(
      agentEnv({ ANTHROPIC_API_KEY: 'k' }, ['ANTHROPIC_API_KEY'], {}, ['ANTHROPIC_API_KEY']),
    ).toEqual({});
  });

  it('only the Claude Code descriptor keeps its OAuth token', () => {
    const keep = Object.fromEntries(
      loadAgentDescriptors([BUILTIN_AGENT_DIR]).map((d) => [d.id, d.keepEnv]),
    );
    expect(keep).toEqual({
      'claude-code': ['CLAUDE_CODE_OAUTH_TOKEN'],
      codex: [],
      'gemini-cli': [],
      opencode: [],
    });
  });
});
