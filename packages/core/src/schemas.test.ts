import { describe, expect, it } from 'vitest';
import { ChatRequestSchema, ProviderDescriptorSchema } from './schemas.js';

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
