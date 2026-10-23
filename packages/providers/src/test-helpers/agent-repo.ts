import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDescriptorSchema, type AgentDescriptor } from '../agents/descriptor.js';

/** The fake agent CLI (a node script); see fake-agent.mjs for its modes. */
export const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

/** A descriptor that runs the fake CLI like `claude -p <prompt> --output-format json`. */
export function fakeAgentDescriptor(over: Record<string, unknown> = {}): AgentDescriptor {
  return AgentDescriptorSchema.parse({
    id: 'fake-agent',
    name: 'Fake agent',
    binary: process.execPath,
    args: [FAKE_AGENT, '-p', '{prompt}', '--output-format', 'json'],
    provider: 'anthropic',
    jurisdiction: 'US',
    output: {
      format: 'json',
      text: 'result',
      error: 'is_error',
      costUsd: 'total_cost_usd',
      inputTokens: 'usage.input_tokens',
      outputTokens: 'usage.output_tokens',
    },
    rateLimit: { patterns: ['usage limit reached'], cooldownMinutes: 30 },
    timeoutMinutes: 1,
    ...over,
  });
}

/** A git repository with one commit (README.md), in a fresh temp directory. */
export function tempRepo(): { root: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kpai-agent-repo-')));
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  run('init', '-q');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), '# repo\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'init');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
