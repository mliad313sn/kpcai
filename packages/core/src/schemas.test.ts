import { describe, expect, it } from 'vitest';
import type { GraphNode } from './graph.js';
import {
  ChatRequestSchema,
  DeliverableSchema,
  ModelCardSchema,
  ProviderDescriptorSchema,
  TASK_TYPE_BASE,
  TaskTypeSchema,
} from './schemas.js';

describe('schemas', () => {
  it('rejects descriptors with unsafe ids or env names', () => {
    const base = { name: 'X', kind: 'cloud', adapter: 'x', jurisdiction: 'US', retention: 'r' };
    expect(ProviderDescriptorSchema.safeParse({ ...base, id: 'Bad Id' }).success).toBe(false);
    expect(
      ProviderDescriptorSchema.safeParse({ ...base, id: 'ok', auth: { env: 'lower' } }).success,
    ).toBe(false);
    expect(
      ProviderDescriptorSchema.safeParse({ ...base, id: 'ok', baseUrl: 'not a url' }).success,
    ).toBe(false);
    const ok = ProviderDescriptorSchema.parse({ ...base, id: 'ok-1' });
    expect(ok.models).toEqual([]);
    expect(ok.discoverModels).toBe(false);
  });

  it('accepts only credential-shaped auth env names (review F8)', () => {
    const base = {
      id: 'ok',
      name: 'X',
      kind: 'cloud',
      adapter: 'x',
      jurisdiction: 'US',
      retention: 'r',
    };
    const env = (name: string) =>
      ProviderDescriptorSchema.safeParse({ ...base, auth: { env: name } }).success;
    expect(env('AWS_SECRET_ACCESS_KEY')).toBe(false);
    expect(env('HOME')).toBe(false);
    expect(env('lower_API_KEY')).toBe(false);
    expect(env('XAI_API_KEY')).toBe(true);
    expect(env('GOOGLE_GENERATIVE_AI_API_KEY')).toBe(true);
  });

  it('requires at least one message and a sane output cap', () => {
    expect(ChatRequestSchema.safeParse({ model: 'm', messages: [] }).success).toBe(false);
    expect(
      ChatRequestSchema.safeParse({
        model: 'm',
        maxOutputTokens: -1,
        messages: [{ role: 'user', content: 'x' }],
      }).success,
    ).toBe(false);
  });
});

describe('deliverables and domain task types (ADR-0022, ADR-0024)', () => {
  it('a node may carry any pack deliverable; default stays absent', () => {
    expect(DeliverableSchema.options).toEqual([
      'answer',
      'report',
      'patch',
      'notebook',
      'design',
      'build',
      'checklist',
      'model3d',
      'map',
      'config',
      'asset',
    ]);
    const node: GraphNode = {
      id: 'n',
      title: 'Report',
      type: 'data_analysis',
      protocol: 'solo',
      dependsOn: [],
      criticality: 'normal',
      messages: [],
      deliverable: 'checklist',
    };
    expect(DeliverableSchema.parse(node.deliverable)).toBe('checklist');
    expect(DeliverableSchema.safeParse('movie').success).toBe(false);
  });

  it('every task type parses and has a base type the original seven can score', () => {
    for (const t of ['reverse_engineering', 'geospatial_analysis', 'translation'])
      expect(TaskTypeSchema.parse(t)).toBe(t);
    const base = new Set([
      'analysis',
      'code_generation',
      'writing',
      'research',
      'test',
      'critique',
      'decision',
    ]);
    for (const t of TaskTypeSchema.options) expect(base.has(TASK_TYPE_BASE[t])).toBe(true);
    for (const b of base) expect(TASK_TYPE_BASE[b as keyof typeof TASK_TYPE_BASE]).toBe(b);
    expect(ModelCardSchema.shape.competence.safeParse({ reverse_engineering: 0.8 }).success).toBe(
      true,
    );
  });
});
