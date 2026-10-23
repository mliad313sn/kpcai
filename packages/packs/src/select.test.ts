import { describe, expect, it } from 'vitest';
import { BUILTIN_PACK_DIR, loadPacks } from './load.js';
import type { Pack } from './schema.js';
import { fold, hintReason, hintToNodes, pickPlanHint } from './select.js';

async function builtins(): Promise<Pack[]> {
  const res = await loadPacks({ builtinDir: BUILTIN_PACK_DIR, home: '/nonexistent' });
  return res.packs.map((p) => p.pack);
}

describe('fold', () => {
  it('lower-cases and strips accents', () => {
    expect(fold('Rétro-INGÉNIERIE')).toBe('retro-ingenierie');
  });
});

describe('pickPlanHint', () => {
  it('picks the data-science plan for an exploration request', async () => {
    const choice = pickPlanHint(await builtins(), 'explore the dataset and train a baseline');
    expect(choice?.pack).toBe('data-science');
    expect(choice?.hint.id).toBe('explore-experiment-report');
  });

  it('picks the infosec detection plan', async () => {
    const choice = pickPlanHint(await builtins(), 'write a Sigma detection rule for lsass access');
    expect(choice?.pack).toBe('security-defensive');
    expect(choice?.hint.id).toBe('detection');
  });

  it('returns undefined when no cue matches', async () => {
    expect(pickPlanHint(await builtins(), 'zzzzz qqqqq')).toBeUndefined();
  });

  it('matches whole words, not substrings', () => {
    const packs: Pack[] = [
      {
        id: 'p',
        version: 1,
        name: 'P',
        description: 'd',
        profiles: ['x'],
        markers: [],
        plans: [
          {
            id: 'h',
            title: 'H',
            when: ['cat'],
            nodes: [
              {
                id: 'n',
                title: 'N',
                type: 'analysis',
                protocol: 'solo',
                dependsOn: [],
                tools: [],
                deliverable: 'answer',
              },
            ],
          },
        ],
        proposedTaskTypes: [],
        reviewCriteria: [],
        tools: [],
        zones: { add: [], relax: [] },
        safety: {
          requiresScope: false,
          scopeKinds: [],
          preferLocal: false,
          physicalEffects: false,
          personalData: false,
          limits: [],
        },
        glossary: [],
        tips: [],
      },
    ];
    expect(pickPlanHint(packs, 'the concatenation')).toBeUndefined();
    expect(pickPlanHint(packs, 'my cat sleeps')).toBeDefined();
  });
});

describe('hintToNodes', () => {
  it('turns a hint into graph nodes with the request and instruction', async () => {
    const choice = pickPlanHint(await builtins(), 'explore the dataset');
    const nodes = hintToNodes(choice!.hint, 'explore the dataset', 'normal');
    expect(nodes[0]?.id).toBe('explore');
    expect(nodes[0]?.messages[0]?.content).toContain('explore the dataset');
    expect(nodes.find((n) => n.dependsOn.length > 0)).toBeDefined();
    expect(hintReason(choice!)).toContain('data-science');
  });
});
