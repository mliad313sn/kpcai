import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatRequest, ProviderAdapter, StreamEvent, TaskGraph } from '@kernelpai/core';
import { describe, expect, it } from 'vitest';
import { policyFor } from './packs.js';
import { loadRules, NO_RULES, rulesResolver, summarizeRules, withNodeContext } from './rules.js';

const graph = (messages: unknown): TaskGraph =>
  ({
    id: 'g',
    request: 'r',
    createdBy: 'template',
    reason: '',
    nodes: [
      {
        id: 'n',
        title: 'Title',
        type: 'analysis',
        protocol: 'solo',
        dependsOn: [],
        criticality: 'normal',
        messages,
      },
    ],
  }) as unknown as TaskGraph;

describe('withNodeContext', () => {
  it('puts the untrusted rules (user) before the request', () => {
    const g = withNodeContext(graph([{ role: 'user', content: 'do it' }]), { rules: 'RULES' });
    expect(g.nodes[0]?.messages).toEqual([
      { role: 'user', content: 'RULES' },
      { role: 'user', content: 'do it' },
    ]);
  });

  it('keeps the request slot when a node has no user message; leaves malformed nodes alone', () => {
    const g = withNodeContext(graph([]), { rules: 'R' });
    expect(g.nodes[0]?.messages).toEqual([
      { role: 'user', content: 'R' },
      { role: 'user', content: 'Title' },
    ]);
    const bad = graph('nope');
    expect(withNodeContext(bad, { rules: 'R' }).nodes[0]).toBe(bad.nodes[0]);
    const plain = graph([]);
    expect(withNodeContext(plain, { rules: '' })).toBe(plain);
  });
});

describe('rules loading', () => {
  it('reads rule files with zones from policy.json and summarizes without content', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kpai-rules-home-'));
    writeFileSync(join(home, 'policy.json'), JSON.stringify({ forbiddenPaths: ['CLAUDE.md'] }));
    const repo = mkdtempSync(join(tmpdir(), 'kpai-rules-repo-'));
    writeFileSync(join(repo, 'AGENTS.md'), 'agents\n');
    writeFileSync(join(repo, 'CLAUDE.md'), 'hidden\n');
    const { policy } = await policyFor({ KPAI_HOME: home });
    const zones = policy.zoneSet();
    expect(zones.entries).toContainEqual({
      glob: 'CLAUDE.md',
      tier: 'added',
      origin: 'policy.json',
    });
    const r = await loadRules(repo, zones, () => undefined);
    expect(r.text).toMatch(/<repo-rules path="AGENTS.md"/);
    expect(r.text).not.toMatch(/hidden/);
    const s = summarizeRules(r.rules);
    expect(s).toMatchObject({ skippedForbidden: 1, files: [{ path: 'AGENTS.md', bytes: 7 }] });
    expect(JSON.stringify(s)).not.toMatch(/agents\\n/);
  });

  it('a workspace that cannot be read gives no rules and says why', async () => {
    const said: string[] = [];
    const { policy } = await policyFor({});
    const r = await loadRules('/definitely/not/here', policy.zoneSet(), (t) => void said.push(t));
    expect(r).toBe(NO_RULES);
    expect(said.join('')).toMatch(/repository rules not read/);
  });
});

describe('rulesResolver', () => {
  it('prepends the rules to every request of the wrapped adapter', async () => {
    const seen: ChatRequest[] = [];
    const inner = {
      descriptor: { id: 'p' },
      capabilities: () => [],
      estimate: (req: ChatRequest) => (seen.push(req), { inputTokens: 1 }),
      send: (req: ChatRequest) => {
        seen.push(req);
        return (async function* (): AsyncIterable<StreamEvent> {})();
      },
      cancel: () => true,
      detect: () => Promise.resolve({ available: true }),
    } as unknown as ProviderAdapter;
    const plain = () => inner;
    expect(rulesResolver(plain, '')).toBe(plain);
    const a = rulesResolver(plain, 'RULES')({ provider: 'p', model: 'm' });
    const req = { model: 'm', messages: [{ role: 'user' as const, content: 'plan' }] };
    a.estimate(req);
    for await (const _ of a.send(req)) void _;
    expect(seen.map((r) => r.messages[0]?.content)).toEqual(['RULES', 'RULES']);
    expect(a.descriptor.id).toBe('p');
    expect(a.capabilities()).toEqual([]);
    expect(a.cancel('x')).toBe(true);
    expect((await a.detect()).available).toBe(true);
  });
});
