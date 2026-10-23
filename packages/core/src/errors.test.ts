import { describe, expect, it } from 'vitest';
import { ProviderError, isAbortError, kindFromStatus } from './errors.js';

describe('errors', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [408, 'unavailable'],
    [500, 'unavailable'],
    [529, 'unavailable'],
    [400, 'bad_request'],
    [422, 'bad_request'],
    [402, 'unavailable'],
    [404, 'unavailable'],
    [413, 'unavailable'],
  ] as const)('maps HTTP %i to %s', (status, kind) => {
    expect(kindFromStatus(status)).toBe(kind);
  });

  it('marks only recoverable failures as fallback-eligible', () => {
    expect(new ProviderError('rate_limit', 'p', 'x').fallbackEligible).toBe(true);
    expect(new ProviderError('unavailable', 'p', 'x').fallbackEligible).toBe(true);
    expect(new ProviderError('refusal', 'p', 'x').fallbackEligible).toBe(true);
    expect(new ProviderError('auth', 'p', 'x').fallbackEligible).toBe(false);
    expect(new ProviderError('cancelled', 'p', 'x').fallbackEligible).toBe(false);
    expect(new ProviderError('budget', 'p', 'x').fallbackEligible).toBe(false);
  });

  it('keeps provider, status and cause', () => {
    const cause = new Error('root');
    const e = new ProviderError('auth', 'anthropic', 'bad key', { status: 401, cause });
    expect(e).toMatchObject({ provider: 'anthropic', status: 401, name: 'ProviderError' });
    expect(e.cause).toBe(cause);
  });

  it('recognises abort errors', () => {
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});
