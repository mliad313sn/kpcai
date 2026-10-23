import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DESCRIPTOR_DIR,
  ProviderRegistry,
  loadDescriptors,
  parseDescriptor,
} from './registry.js';
import { resolveBaseUrl } from './env.js';

describe('provider registry', () => {
  it('loads the built-in descriptors', () => {
    const ids = loadDescriptors([BUILTIN_DESCRIPTOR_DIR])
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual(['anthropic', 'mock', 'ollama']);
  });

  it('lets a user directory override or add providers with YAML only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kpai-prov-'));
    writeFileSync(
      join(dir, 'mock.yaml'),
      'id: mock\nname: My mock\nkind: test\nadapter: mock\njurisdiction: local\nretention: none\nmodels:\n  - { id: other, contextWindow: 10, maxOutput: 5, modalities: [text], price: { inputPerMTok: 0, outputPerMTok: 0 } }\n',
    );
    writeFileSync(join(dir, 'README.txt'), 'ignored');
    const ds = loadDescriptors([BUILTIN_DESCRIPTOR_DIR, dir, join(dir, 'missing')]);
    const mock = ds.find((d) => d.id === 'mock');
    expect(mock?.name).toBe('My mock');
    const reg = new ProviderRegistry(ds, {});
    expect(
      reg
        .resolve('mock/other')
        .adapter.capabilities()
        .map((m) => m.id),
    ).toEqual(['other']);
  });

  it('rejects invalid descriptors with a precise message', () => {
    expect(() => parseDescriptor('id: BAD\nname: x', 'x.yaml')).toThrow(
      /Invalid provider descriptor x.yaml: id:/,
    );
  });

  it('rejects descriptors naming an unknown adapter', () => {
    const d = parseDescriptor(
      'id: x\nname: X\nkind: cloud\nadapter: nope\njurisdiction: US\nretention: r',
      'x',
    );
    expect(() => new ProviderRegistry([d], {})).toThrow(/no adapter named "nope"/);
  });

  it('resolves provider/model references, including model ids with slashes', () => {
    const reg = new ProviderRegistry(loadDescriptors([BUILTIN_DESCRIPTOR_DIR]), {});
    expect(reg.resolve('ollama/hf.co/org/model:q4').model).toBe('hf.co/org/model:q4');
    expect(() => reg.resolve('echo')).toThrow(/provider\/model/);
    expect(() => reg.resolve('mock/')).toThrow(/provider\/model/);
    expect(() => reg.resolve('nobody/x')).toThrow(/Unknown provider/);
    expect(reg.list()).toHaveLength(3);
  });

  it('resolves base URLs from env with a scheme default', () => {
    const d = parseDescriptor(
      'id: x\nname: X\nkind: local\nadapter: mock\njurisdiction: l\nretention: r\nbaseUrl: http://a:1/\nbaseUrlEnv: X_HOST',
      'x',
    );
    expect(resolveBaseUrl(d, {})).toBe('http://a:1');
    expect(resolveBaseUrl(d, { X_HOST: 'b:2' })).toBe('http://b:2');
    expect(resolveBaseUrl({ ...d, baseUrl: undefined }, {})).toBeUndefined();
  });
});
