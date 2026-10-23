import { describe, expect, it } from 'vitest';
import { parseDescriptor } from './registry.js';
import { isLoopbackUrl, localHostProblem, mayCarryCredentials } from './env.js';

describe('isLoopbackUrl', () => {
  it.each([
    'http://127.0.0.1:11434',
    'http://127.1.2.3/v1',
    'http://127.1:8080',
    'http://localhost:8080/v1',
    'http://LOCALHOST',
    'http://[::1]:11434',
    'http://[::ffff:127.0.0.1]:80',
    'https://127.0.0.1',
  ])('accepts %s', (url) => expect(isLoopbackUrl(url)).toBe(true));

  it.each([
    'http://10.0.0.5:11434',
    'http://192.168.1.20:11434',
    'http://0.0.0.0:11434',
    'http://128.0.0.1',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'http://[::2]',
    'http://[::ffff:10.0.0.1]',
    'https://api.openai.com/v1',
    'not a url',
  ])('rejects %s', (url) => expect(isLoopbackUrl(url)).toBe(false));
});

describe('mayCarryCredentials', () => {
  it('allows https anywhere and plain http only on loopback', () => {
    expect(mayCarryCredentials('https://api.example.com/v1')).toBe(true);
    expect(mayCarryCredentials('http://127.0.0.1:8080/v1')).toBe(true);
    expect(mayCarryCredentials('http://10.0.0.5:8080/v1')).toBe(false);
    expect(mayCarryCredentials('http://api.example.com/v1')).toBe(false);
  });
});

describe('localHostProblem', () => {
  const local = parseDescriptor(
    'id: x\nname: X\nkind: local\nadapter: mock\njurisdiction: l\nretention: r\nbaseUrlEnv: X_HOST',
    'x',
  );

  it('accepts a loopback local provider and ignores non-local kinds', () => {
    expect(localHostProblem(local, 'http://127.0.0.1:1')).toBeUndefined();
    expect(localHostProblem({ ...local, kind: 'cloud' }, 'http://10.0.0.5')).toBeUndefined();
  });

  it('refuses a remote or missing base URL for a local provider', () => {
    expect(localHostProblem(local, 'http://10.0.0.5:11434')).toMatch(
      /host is not local: http:\/\/10\.0\.0\.5:11434 .*check X_HOST/,
    );
    expect(localHostProblem({ ...local, baseUrlEnv: undefined }, undefined)).toMatch(
      /host is not local: the SDK's default endpoint/,
    );
  });
});
