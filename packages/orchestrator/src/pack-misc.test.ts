import { beforeAll, describe, expect, it } from 'vitest';
import { loadPacks, type Pack } from '@kernelpai/packs';
import { nodeProblems, planChanges } from './plan.js';
import { ModelPlanner, parsePlan, plannerPrompt } from './planner/model.js';
import { GraphRunner } from './runner.js';
import { checkRunScope, scopePayloads } from './scope-gate.js';
import { nodeTools } from './tool-loop.js';
import { FakeToolBus, RoleAdapter, gnode, graph, setup, toolDef } from './test-helpers/fakes.js';
import type { PlannedNode } from './types.js';

let all: Pack[] = [];
const pack = (id: string): Pack => all.find((p) => p.id === id) as Pack;

beforeAll(async () => {
  all = (await loadPacks({ home: '/nonexistent-kpai-home', env: {} })).packs.map((l) => l.pack);
});

describe('plan edits with pack fields', () => {
  it('validates the orchestrator-local fields sent by the UI', () => {
    const bad = {
      ...gnode(),
      deliverable: 'hologram',
      pack: 3,
      guidance: {},
      reviewCriteria: [1],
    } as unknown as PlannedNode;
    expect(nodeProblems(bad, [])).toEqual([
      'node "n1": unknown deliverable "hologram"',
      'node "n1": pack must be a string',
      'node "n1": guidance must be a string',
      'node "n1": reviewCriteria must list strings',
    ]);
    const good: PlannedNode = { ...gnode(), deliverable: 'map', guidance: 'g', reviewCriteria: [] };
    expect(nodeProblems(good, [])).toEqual([]);
  });

  it('lists deliverable and guidance edits', () => {
    const before: PlannedNode = { ...gnode(), deliverable: 'report', guidance: 'a' };
    const after: PlannedNode = { ...gnode(), deliverable: 'checklist', guidance: 'b' };
    expect(planChanges(graph([before]), graph([after]))).toEqual([
      'n1: deliverable report → checklist',
      'n1: prompt edited',
    ]);
  });
});

describe('nodeTools namespace wildcards', () => {
  const bus = new FakeToolBus([
    toolDef('fs.read'),
    toolDef('mcp.ghidra.decompile'),
    toolDef('mcp.ghidra.xrefs'),
    toolDef('shell.run', 'destructive'),
  ]);

  it('expands `<ns>.*` and never grants with a bare `*`', () => {
    const r = nodeTools(bus, gnode({ tools: ['mcp.ghidra.*', 'fs.read', 'mcp.r2.*', '*', 'fs*'] }));
    expect(r.defs.map((d) => d.name)).toEqual([
      'mcp.ghidra.decompile',
      'mcp.ghidra.xrefs',
      'fs.read',
    ]);
    expect(r.unknown).toEqual(['mcp.r2.*', '*', 'fs*']);
  });
});

describe('scope gate helpers', () => {
  it('no scope-requiring pack: ok without a boundary or journal payload', () => {
    const c = checkRunScope([pack('data-science')], [gnode()], undefined, new Date());
    expect(c).toEqual({ ok: true, required: [], problems: [] });
    expect(scopePayloads([pack('data-science')], c)).toEqual([]);
  });

  it('two scope-requiring packs check the scope against each', () => {
    const scope = {
      targets: [{ kind: 'binary', value: 'firmware.bin' }],
      engagementRef: 'CTF-1',
      authorisedBy: 'organiser',
      expires: '2026-11-30',
    };
    const packs = [pack('reverse-engineering'), pack('security-offensive')];
    const c = checkRunScope(packs, [], scope, new Date('2026-10-23T00:00:00Z'));
    expect(c.ok).toBe(false);
    expect(c.problems).toHaveLength(1);
    expect(c.problems[0]).toMatch(
      /^target kind "binary" is not used by .+ \(host, network, url\)$/,
    );
    const re = checkRunScope([packs[0] as Pack], [], scope, new Date('2026-10-23T00:00:00Z'));
    expect(re.boundary).toContain('in scope: binary firmware.bin');
    expect(scopePayloads([packs[0] as Pack], re)).toHaveLength(1);
  });
});

describe('ModelPlanner with pack-proposed types', () => {
  const PLAN = {
    reason: 'pack types',
    nodes: [
      {
        id: 'triage',
        title: 'Triage',
        type: 'firmware_triage',
        protocol: 'solo',
        prompt: 'look',
      },
      {
        id: 'sum',
        title: 'Sum',
        type: 'writing',
        protocol: 'solo',
        prompt: 'write',
        dependsOn: ['triage'],
      },
    ],
  };

  it('maps proposed types via mapsTo and journals the proposed name on routing', async () => {
    const aliases = new Map([['firmware_triage', 'analysis' as const]]);
    const p = parsePlan(JSON.stringify(PLAN), 'req', [], aliases);
    expect(p.ok && p.nodes.map((n) => [n.type, (n as PlannedNode).proposedType])).toEqual([
      ['analysis', 'firmware_triage'],
      ['writing', undefined],
    ]);
    expect(parsePlan(JSON.stringify(PLAN), 'req', []).ok).toBe(false);
    expect(plannerPrompt('r', ['firmware_triage'])).toContain('firmware_triage');

    const a = new RoleAdapter('a', () => JSON.stringify(PLAN));
    const s = setup([a]);
    const base = pack('reverse-engineering');
    const re: Pack[] = [
      {
        ...base,
        proposedTaskTypes: [
          { id: 'firmware_triage', description: 'Triage a firmware image', mapsTo: 'analysis' },
        ],
      },
    ];
    const planner = new ModelPlanner({ ...s.options, budget: () => true }, { packs: re });
    const g = await planner.plan('triage this crackme', { root: '/w' });
    expect(g.createdBy).toBe('model');
    expect(a.seen[0]?.prompt).toContain('firmware_triage');
    await new GraphRunner(s.options).run(g);
    const routing = s.journal
      .events()
      .find((e) => e.type === 'routing' && e.nodeId === 'triage' && e.payload['role'] === 'solo');
    expect(routing?.payload).toMatchObject({
      taskType: 'analysis',
      proposedType: 'firmware_triage',
    });
  });

  it('falls back to a template planner that knows the packs', async () => {
    const s = setup([new RoleAdapter('a', () => 'no plan')]);
    const planner = new ModelPlanner(
      { ...s.options, budget: () => true },
      { packs: [pack('data-science')] },
    );
    const g = await planner.plan('explore the dataset', { root: '/w' });
    expect(g.reason).toMatch(/^model plan rejected .*; pack data-science/);
  });
});
