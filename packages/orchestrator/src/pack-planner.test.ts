import { beforeAll, describe, expect, it } from 'vitest';
import { loadPacks, type Pack } from '@kernelpai/packs';
import {
  packCriticality,
  proposedTypeAliases,
  proposedTypeFor,
  resolveTaskType,
} from './planner/packs.js';
import { TemplatePlanner, inferCriticality } from './planner/template.js';
import type { PlannedNode } from './types.js';

const ctx = { root: '/work' };
let all: Pack[] = [];
const pack = (id: string): Pack => {
  const p = all.find((x) => x.id === id);
  if (!p) throw new Error(`no pack ${id}`);
  return p;
};

beforeAll(async () => {
  const r = await loadPacks({ home: '/nonexistent-kpai-home', env: {} });
  all = r.packs.map((l) => l.pack);
  expect(r.problems).toEqual([]);
});

async function planWith(ids: string[], request: string) {
  const planner = new TemplatePlanner({ packs: ids.map(pack), newId: () => 'g' });
  const g = await planner.plan(request, ctx);
  const nodes = g.nodes as PlannedNode[];
  return { g, nodes, seq: nodes.map((n) => [n.id, n.type, n.protocol, n.deliverable]) };
}

describe('TemplatePlanner with domain packs (WI-S4-01)', () => {
  it.each([
    [
      'data-science',
      'explore this dataset and train a baseline classification model',
      [
        ['explore', 'analysis', 'solo', 'report'],
        ['experiment', 'code_generation', 'author_critic', 'notebook'],
        ['report', 'writing', 'author_critic', 'report'],
      ],
    ],
    [
      'game-dev',
      'write the game design document for the quest and dialogue system',
      [
        ['outline', 'writing', 'solo', 'report'],
        ['draft', 'writing', 'author_critic', 'report'],
      ],
    ],
    [
      'cad-3d-printing',
      'design a parametric wall bracket in openscad with 0.2 mm tolerance',
      [
        ['spec', 'analysis', 'solo', 'report'],
        ['build', 'code_generation', 'author_critic', 'model3d'],
      ],
    ],
    [
      'smart-home',
      'create an automation that turns on the hallway light when the motion sensor fires',
      [
        ['design', 'analysis', 'solo', 'report'],
        ['write', 'code_generation', 'author_critic', 'config'],
        ['dryrun', 'analysis', 'solo', 'checklist'],
      ],
    ],
    [
      'geospatial',
      'buffer the rivers layer by 100 m and draw a heatmap with geopandas',
      [
        ['inspect', 'analysis', 'solo', 'report'],
        ['analyse', 'code_generation', 'author_critic', 'patch'],
        ['map', 'writing', 'solo', 'map'],
      ],
    ],
    [
      'security-defensive',
      'write a sigma rule to detect suspicious powershell downloads',
      [
        ['research', 'analysis', 'solo', 'report'],
        ['rule', 'code_generation', 'author_critic', 'patch'],
        ['cases', 'test', 'author_critic', 'patch'],
      ],
    ],
    [
      'security-defensive',
      'build the incident timeline from these logs and write the postmortem',
      [
        ['timeline', 'analysis', 'author_critic', 'report'],
        ['report', 'writing', 'author_critic', 'report'],
      ],
    ],
  ])('%s: %s', async (id, request, expected) => {
    const { g, seq, nodes } = await planWith([id, 'general'], request);
    expect(seq).toEqual(expected);
    expect(g.createdBy).toBe('template');
    expect(g.reason).toMatch(new RegExp(`^pack ${id}, plan "[^"]+" \\(matched .+\\); criticality`));
    for (const n of nodes) {
      expect(n.pack).toBe(id);
      expect(n.messages).toEqual([{ role: 'user', content: request }]);
    }
  });

  it('keeps dependencies, tools, guidance and review criteria apart from the request', async () => {
    const { nodes } = await planWith(['data-science'], 'explore the dataset');
    const [explore, experiment, report] = nodes;
    expect(experiment?.dependsOn).toEqual(['explore']);
    expect(report?.dependsOn).toEqual(['experiment']);
    expect(explore?.tools).toEqual(['fs.list', 'fs.read']);
    expect(report?.tools).toBeUndefined();
    expect(explore?.guidance).toMatch(/^Describe columns/);
    expect(explore?.reviewCriteria).toHaveLength(3);
    expect(explore?.proposedType).toBe('data_analysis');
    expect(experiment?.proposedType).toBeUndefined();
    expect(explore?.criticality).toBe('normal');
  });

  it('picks the right domain among all 19 built-in packs', async () => {
    const { g, nodes } = await planWith(
      all.map((p) => p.id),
      'explore the dataset, then train and evaluate a baseline forecast model',
    );
    expect(g.reason).toMatch(/^pack data-science/);
    expect(nodes.map((n) => n.id)).toEqual(['explore', 'experiment', 'report']);
  });

  it('keeps the software template when no pack cue matches', async () => {
    const { g, nodes } = await planWith(
      ['data-science', 'general'],
      'implement a function that adds numbers',
    );
    expect(nodes.map((n) => n.id)).toEqual(['architecture', 'implementation', 'tests', 'review']);
    expect(g.reason).toMatch(/^template "code"/);
    expect(nodes[1]?.deliverable).toBeUndefined();
  });

  it('keeps a closed choice as a vote even when a domain cue matches', async () => {
    const { nodes } = await planWith(
      ['data-science'],
      'which model should we use: xgboost or lightgbm?',
    );
    expect(nodes.map((n) => [n.id, n.protocol])).toEqual([['choice', 'vote']]);
  });

  it('the generic pack gives a first run only where no template fits', async () => {
    const first = await planWith(['general'], 'help me understand what is in this folder');
    expect(first.seq).toEqual([
      ['look', 'analysis', 'solo', 'report'],
      ['propose', 'analysis', 'solo', 'answer'],
    ]);
    expect(first.g.reason).toMatch(/^pack general/);
    const code = await planWith(['general'], 'implement a login endpoint, see how it works');
    expect(code.nodes.map((n) => n.id)).toEqual([
      'architecture',
      'implementation',
      'tests',
      'review',
    ]);
    const writing = await planWith(['general'], 'draft a blog post about our launch');
    expect(writing.nodes.map((n) => n.id)).toEqual(['draft']);
    const none = await planWith(['general'], 'list the prime numbers below 20');
    expect(none.nodes.map((n) => n.id)).toEqual(['answer']);
  });

  it('a pack that requires a scope raises criticality; an explicit override still wins', async () => {
    const { g, nodes } = await planWith(['security-offensive'], 'plan the retest of the findings');
    expect(nodes.map((n) => n.id)).toEqual(['review_scope', 'analyse', 'write']);
    expect(nodes.every((n) => n.criticality === 'critical')).toBe(true);
    expect(g.reason).toMatch(/criticality critical$/);
    expect(packCriticality([pack('data-science')], 'low')).toBe('low');
    const low = new TemplatePlanner({ packs: [pack('security-offensive')], criticality: 'low' });
    expect((await low.plan('plan the retest of the findings', ctx)).nodes[0]?.criticality).toBe(
      'low',
    );
  });

  it('caps guidance and review criteria from the pack', async () => {
    const big = structuredClone(pack('data-science'));
    const hint = big.plans[0];
    if (!hint?.nodes[0]) throw new Error('fixture');
    hint.nodes[0].instruction = 'x'.repeat(5000);
    big.reviewCriteria = Array.from({ length: 20 }, (_, i) => `${i}:${'y'.repeat(900)}`);
    const g = await new TemplatePlanner({ packs: [big] }).plan('explore the dataset', ctx);
    const n = g.nodes[0] as PlannedNode;
    expect(n.guidance?.length).toBe(600);
    expect(n.reviewCriteria).toHaveLength(8);
    expect(n.reviewCriteria?.every((c) => c.length <= 300)).toBe(true);
  });
});

describe('criticality keywords (WI-S4-03)', () => {
  it.each([
    ['report the token counts of the tokenizer', 'normal'],
    ['train a tokenizer on the dataset and report the token counts', 'normal'],
    ['chart crypto prices for the last year', 'normal'],
    ['author a short story about a lighthouse', 'normal'],
    ['store the auth token securely', 'critical'],
    ['rotate the refresh token on logout', 'critical'],
    ['encrypt the backups at rest', 'critical'],
    ['rotate the payment token', 'critical'],
    ['move the api key out of the code', 'critical'],
    ['revoir la sécurité du module', 'critical'],
    ['add OAuth login', 'critical'],
    ['rename a variable', 'normal'],
  ])('%s → %s', (request, expected) => {
    expect(inferCriticality(request)).toBe(expected);
  });
});

describe('pack-proposed task types', () => {
  it('maps proposed ids onto core types through mapsTo', () => {
    const packs = [pack('reverse-engineering'), pack('game-dev'), pack('cad-3d-printing')];
    expect(resolveTaskType(packs, 'analysis')).toEqual({ type: 'analysis' });
    expect(resolveTaskType(packs, 'reverse_engineering')).toEqual({
      type: 'analysis',
      proposed: 'reverse_engineering',
      pack: 'reverse-engineering',
    });
    expect(resolveTaskType(packs, 'game_design')?.type).toBe('writing');
    expect(resolveTaskType(packs, 'cad_modelling')?.type).toBe('code_generation');
    expect(resolveTaskType(packs, 'astrology')).toBeUndefined();
    expect([...proposedTypeAliases(all).keys()].sort()).toEqual([
      'cad_modelling',
      'creative_writing',
      'data_analysis',
      'design',
      'game_design',
      'geospatial_analysis',
      'reverse_engineering',
      'security_assessment',
      'translation',
    ]);
    expect(proposedTypeFor(pack('cad-3d-printing'), 'code_generation')).toBe('cad_modelling');
    expect(proposedTypeFor(pack('smart-home'), 'analysis')).toBeUndefined();
  });
});
