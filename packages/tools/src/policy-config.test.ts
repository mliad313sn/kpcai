import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsTools } from './builtins/fs.js';
import { LocalToolBus } from './bus.js';
import { createToolBus } from './create.js';
import { redact } from './env.js';
import { DEFAULT_FORBIDDEN_PATHS, GradedPermissionPolicy } from './policy.js';
import { buildPolicy, loadPolicyConfig } from './policy-config.js';
import { call, makeCtx, tempDir } from './test-helpers/ctx.js';

describe('default forbidden paths (P2-F10)', () => {
  const policy = new GradedPermissionPolicy();
  const bus = new LocalToolBus({ tools: fsTools, policy });

  it.each([
    '.env',
    'app/.env.local',
    'certs/server.pem',
    'tls.key',
    'home/id_rsa',
    'id_ed25519.pub',
    '.aws',
    '.aws/credentials',
    'x/.ssh/config',
    '.gnupg/pubring.kbx',
    '.npmrc',
    '.netrc',
    'config/credentials.json',
    'src/client_secret.json',
  ])('refuses %s by default', async (p) => {
    const r = await bus.call(call('fs.read', { path: p }), makeCtx('/ws'));
    expect(r.content).toMatch(/forbidden zone/);
  });

  it('leaves ordinary files alone and can be switched off', async () => {
    const r = await bus.call(call('fs.read', { path: 'src/env.ts' }), makeCtx('/ws'));
    expect(r.content).not.toMatch(/forbidden zone/);
    const off = new GradedPermissionPolicy({ defaultForbiddenPaths: false });
    expect(off.describe().forbiddenPaths).toEqual([]);
    expect(policy.describe().forbiddenPaths).toEqual([...DEFAULT_FORBIDDEN_PATHS]);
  });
});

describe('batch confirmation is per model (P2-F14)', () => {
  it('a write approved for the author does not cover the critic (batch.mjs)', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const bus = new LocalToolBus({ tools: fsTools });
      const asked: string[] = [];
      const ctx = (provider: string) =>
        makeCtx(dir, {
          model: { provider, model: 'm' },
          nodeId: 'implementation',
          confirm: async (q) => {
            asked.push(q);
            return true;
          },
        });
      await bus.call(call('fs.write', { path: 'src/a.ts', content: 'x' }), ctx('author'));
      await bus.call(call('fs.write', { path: 'src/b.ts', content: 'y' }), ctx('author'));
      await bus.call(call('fs.write', { path: 'package.json', content: '{}' }), ctx('critic'));
      expect(asked).toHaveLength(2);
      expect(asked[1]).toMatch(
        /for critic\/m on node implementation\?\ncreate package\.json \(2 bytes, 1 lines\)\n\{\}$/,
      );
    } finally {
      await cleanup();
    }
  });
});

describe('$KPAI_HOME/policy.json', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir: home, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  it('is optional and extends the defaults', async () => {
    expect(await loadPolicyConfig(home)).toEqual({
      config: { forbiddenPaths: [], denyByModel: {} },
    });
    expect(await loadPolicyConfig(path.join(home, 'missing'))).toMatchObject({
      config: { forbiddenPaths: [] },
    });
    await writeFile(
      path.join(home, 'policy.json'),
      JSON.stringify({ forbiddenPaths: ['private/**'], denyByModel: { 'cheap/*': ['shell.*'] } }),
    );
    const loaded = await loadPolicyConfig(home);
    const policy = buildPolicy(loaded.config, {
      forbiddenPaths: ['x'],
      denyByModel: { 'cheap/*': ['fs.delete'] },
    });
    const active = policy.describe();
    expect(active.forbiddenPaths).toEqual([...DEFAULT_FORBIDDEN_PATHS, 'private/**', 'x']);
    expect(active.denyByModel).toEqual({ 'cheap/*': ['shell.*', 'fs.delete'] });
    expect(active.batchScope).toMatch(/model/);
  });

  it.each([
    ['{ not json', /invalid/],
    [JSON.stringify({ forbiddenPaths: 'x' }), /invalid/],
    [JSON.stringify({ forbidenPaths: ['typo'] }), /invalid/],
  ])('reports a broken file and keeps the defaults: %s', async (content, re) => {
    await writeFile(path.join(home, 'policy.json'), content);
    const { bus, activePolicy, policyError } = await createToolBus({ kpaiHome: home });
    expect(policyError).toMatch(re);
    expect(activePolicy?.forbiddenPaths).toEqual([...DEFAULT_FORBIDDEN_PATHS]);
    const r = await bus.call(call('fs.read', { path: '.env' }), makeCtx(home));
    expect(r.content).toMatch(/forbidden zone/);
  });

  it('reports an unreadable policy.json', async () => {
    await mkdir(path.join(home, 'policy.json'));
    expect((await loadPolicyConfig(home)).error).toMatch(/policy\.json/);
  });

  it('createToolBus applies defaults without a home and exposes the active policy', async () => {
    const { activePolicy, policyError } = await createToolBus();
    expect(activePolicy?.forbiddenPaths).toContain('.env');
    expect(policyError).toBeUndefined();
    const custom = await createToolBus({ policy: new GradedPermissionPolicy() });
    expect(custom.activePolicy).toBeUndefined();
  });
});

describe('redaction of key/value secrets and key blocks (P2-F10)', () => {
  it.each([
    [
      'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'aws_secret_access_key = [redacted]',
    ],
    ['"client_secret": "a1b2c3d4e5f6g7h8i9j0"', '"client_secret": "[redacted]"'],
    ['DB_PASSWORD=Sup3rS3cretPassw0rd!', 'DB_PASSWORD=[redacted]!'],
    ['github_token: ghx1234567890abcdefXYZ', 'github_token: [redacted]'],
  ])('redacts %s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('keeps code that only names a secret', () => {
    const code = 'const password = process.env.DB_PASSWORD; const token = getToken();';
    expect(redact(code)).toBe(code);
    expect(redact('api_key = "abcdefghijklmnopqrst"')).toBe('api_key = "abcdefghijklmnopqrst"');
  });

  it('redacts any private key block', () => {
    const pgp =
      'a\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nxyz\n-----END PGP PRIVATE KEY BLOCK-----\nb';
    expect(redact(pgp)).toBe('a\n[redacted]\nb');
    expect(redact('-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc')).toBe('[redacted]');
  });
});
