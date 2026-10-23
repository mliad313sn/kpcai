import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphNode } from '@kernelpai/core';
import type { AgentDescriptor } from '@kernelpai/providers';
import { fakeAgentDescriptor, tempRepo } from '../../../providers/src/test-helpers/agent-repo.js';
import type { AgentOptions, PlannedNode } from '../types.js';
import { gnode } from './fakes.js';

export { fakeAgentDescriptor, tempRepo };

/** A parent environment holding KernelPAI keys that must never reach the agent. */
export const PARENT_ENV = {
  PATH: process.env['PATH'],
  HOME: process.env['HOME'],
  ANTHROPIC_API_KEY: 'sk-test-anthropic-secret',
  OPENAI_API_KEY: 'sk-test-openai-secret',
};

/** Agent options over the fake CLI; `log` lists each invocation's mode and role. */
export function agentOptions(
  over: Partial<AgentOptions> = {},
  descriptor: AgentDescriptor = fakeAgentDescriptor(),
): { agents: AgentOptions; calls: () => string[] } {
  const log = join(mkdtempSync(join(tmpdir(), 'kpai-agent-log-')), 'calls.log');
  return {
    agents: {
      descriptors: [descriptor],
      budget: { maxRuns: 5, maxMinutes: 5 },
      env: { ...PARENT_ENV, FAKE_AGENT_LOG: log },
      scrub: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
      ...over,
    },
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
        : [],
  };
}

/** A code node whose author is the fake agent; `mode` picks its behaviour. */
export function agentNode(mode: string, over: Partial<PlannedNode> = {}): GraphNode {
  return {
    ...gnode({
      id: 'n1',
      title: 'Agent work',
      type: 'code_generation',
      protocol: 'author_critic',
      messages: [{ role: 'user', content: `MODE:${mode} please do the work` }],
    }),
    agent: { id: 'fake-agent' },
    ...over,
  } as GraphNode;
}
