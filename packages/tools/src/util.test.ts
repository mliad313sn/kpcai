import { describe, expect, it } from 'vitest';
import { isSecretName, redact, scrubEnv, secretValues } from './env.js';
import { validateInput } from './schema.js';
import { stripControls, summarize, summarizeInput, truncateBytes } from './text.js';

describe('env scrubbing', () => {
  it.each([
    'ANTHROPIC_API_KEY',
    'openai_api_key',
    'MISTRAL_API_TOKEN',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'NPM_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AZURE_CLIENT_SECRET',
    'MY_SECRET_THING',
    'DB_PASSWORD',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'SSH_AUTH_SOCK',
    'STRIPE_KEY',
    'ACCESS_TOKEN',
  ])('treats %s as a secret', (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each(['PATH', 'HOME', 'LANG', 'TERM', 'KPAI_HOME', 'TOKENIZERS_PARALLELISM', 'NODE_ENV'])(
    'keeps %s',
    (name) => {
      expect(isSecretName(name)).toBe(false);
    },
  );

  it('scrubEnv always keeps what Windows needs to start a process', () => {
    const win = {
      Path: 'C:\\Windows',
      PATHEXT: '.COM;.EXE',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      ComSpec: 'cmd.exe',
      TEMP: 't',
      TMP: 't',
      SystemDrive: 'C:',
      GITHUB_TOKEN: 'x',
    };
    expect(Object.keys(scrubEnv(win)).sort()).toEqual(
      ['ComSpec', 'PATHEXT', 'Path', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'windir'].sort(),
    );
  });

  it('scrubEnv drops secrets and undefined values', () => {
    const out = scrubEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', AWS_REGION: 'eu', EMPTY: undefined });
    expect(out).toEqual({ PATH: '/bin' });
  });

  it('redacts secret values and known token shapes', () => {
    const env = { FOO_API_KEY: 'supersecretvalue123', SHORT_TOKEN: 'abc', PATH: '/usr/bin/xx' };
    const secrets = secretValues(env);
    expect(secrets).toEqual(['supersecretvalue123']);
    const text = `k=supersecretvalue123 sk-${'a'.repeat(24)} ghp_${'b'.repeat(36)} AKIA${'C'.repeat(16)} /usr/bin/xx`;
    const out = redact(text, secrets);
    expect(out).not.toMatch(/supersecret|sk-a|ghp_b|AKIAC/);
    expect(out).toContain('/usr/bin/xx');
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toBe(
      '[redacted]',
    );
  });
});

describe('text helpers', () => {
  it('truncates on UTF-8 boundaries', () => {
    expect(truncateBytes('abc', 10)).toEqual({ text: 'abc', truncated: false });
    const t = truncateBytes('ééé', 3);
    expect(t.truncated).toBe(true);
    expect(t.text.startsWith('é\n[truncated: 4 more bytes]')).toBe(true);
  });

  it('strips escape sequences and control characters', () => {
    expect(stripControls('a\x1b[2Jb\x1b]52;c;ZXZpbA==\x07c\x00d\te\nf\x9b')).toBe('abcd\te\nf');
  });

  it('summarizes long text and nested inputs', () => {
    expect(summarize('short')).toEqual({ preview: 'short', chars: 5 });
    const long = 'x'.repeat(500);
    const s = summarize(long);
    expect(s.chars).toBe(500);
    expect(String(s.preview).length).toBeLessThan(210);
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    const nested = summarizeInput({ a: [long, 1], b: { c: long }, d: null }) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(nested)).not.toContain(long);
    expect(nested.d).toBeNull();
  });
});

describe('validateInput', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 5 },
      n: { type: 'integer', minimum: 1, maximum: 3 },
      ratio: { type: 'number' },
      mode: { enum: ['a', 'b'] },
      fixed: { const: 1 },
      list: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
      either: { type: ['string', 'null'] },
    },
    required: ['path'],
    additionalProperties: false,
  };

  it('accepts a valid input', () => {
    expect(validateInput(schema, { path: 'a', n: 2, ratio: 1, list: ['x'], either: null })).toEqual(
      [],
    );
  });

  it('reports each violation with its location', () => {
    const errors = validateInput(schema, {
      n: 1.5,
      mode: 'c',
      fixed: 2,
      list: [1, 'a', 'b'],
      extra: true,
      either: 3,
    });
    expect(errors.join('\n')).toMatch(/path: is required/);
    expect(errors.join('\n')).toMatch(/n: expected "integer", got number/);
    expect(errors.join('\n')).toMatch(/mode: must be one of/);
    expect(errors.join('\n')).toMatch(/fixed: must equal 1/);
    expect(errors.join('\n')).toMatch(/list\[0\]: expected "string"/);
    expect(errors.join('\n')).toMatch(/extra: is not allowed/);
    expect(errors.length).toBeLessThanOrEqual(10);
  });

  it('checks bounds', () => {
    const errors = validateInput(schema, { path: '', n: 9, list: [] });
    expect(errors).toHaveLength(3);
    expect(validateInput(schema, { path: 'toolong', n: 0, list: ['a', 'b', 'c'] })).toHaveLength(3);
  });

  it('requires an object input and tolerates unknown keywords', () => {
    expect(validateInput(schema, 'x')[0]).toMatch(/must be an object, got string/);
    expect(validateInput(schema, null)[0]).toMatch(/got null/);
    expect(validateInput(schema, [])[0]).toMatch(/got array/);
    expect(validateInput({ type: 'object', patternProperties: {} }, { a: 1 })).toEqual([]);
    expect(
      validateInput({ type: 'object', additionalProperties: { type: 'number' } }, { a: 'x' }),
    ).toHaveLength(1);
  });

  it('stops at absurd nesting depth', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { a: deep };
    const s: Record<string, unknown> = { type: 'object' };
    let cur = s;
    for (let i = 0; i < 40; i++) {
      const next: Record<string, unknown> = { type: i === 39 ? 'number' : 'object' };
      cur.properties = { a: next };
      cur = next;
    }
    expect(validateInput(s, deep).join()).toMatch(/nested too deeply/);
  });
});
