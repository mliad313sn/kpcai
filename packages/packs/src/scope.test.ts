import { describe, expect, it } from 'vitest';
import { parsePack } from './load.js';
import {
  describeScope,
  scopeJournalPayload,
  scopeProblems,
  type AuthorisedScope,
} from './scope.js';
import type { Pack } from './schema.js';

function secPack(): Pack {
  const res = parsePack(
    'id: pt\nname: Pentest\ndescription: d\nprofiles: [pentester]\n' +
      'safety: { requiresScope: true, scopeKinds: [host, network] }',
  );
  if ('error' in res) throw new Error(res.error);
  return res.pack;
}

const now = new Date('2026-10-23T00:00:00Z');
const good: AuthorisedScope = {
  targets: [{ kind: 'host', value: '10.0.0.5' }],
  engagementRef: 'ENG-2026-014',
  authorisedBy: 'Acme Security',
  expires: '2026-11-30',
};

describe('scopeProblems', () => {
  it('passes a well-formed, in-kind, unexpired scope', () => {
    expect(scopeProblems(secPack(), good, now)).toEqual([]);
  });

  it('requires a scope when the pack does', () => {
    expect(scopeProblems(secPack(), undefined, now)[0]).toContain('authorised scope');
  });

  it('refuses an expired scope', () => {
    const s = { ...good, expires: '2026-01-01' };
    expect(scopeProblems(secPack(), s, now).some((m) => m.includes('expired'))).toBe(true);
  });

  it('refuses an unbounded target', () => {
    const s = { ...good, targets: [{ kind: 'network' as const, value: '0.0.0.0/0' }] };
    expect(scopeProblems(secPack(), s, now).some((m) => m.includes('unbounded'))).toBe(true);
  });

  it('refuses a target kind the pack does not use', () => {
    const s = { ...good, targets: [{ kind: 'url' as const, value: 'https://app.example.com' }] };
    expect(scopeProblems(secPack(), s, now).some((m) => m.includes('not used'))).toBe(true);
  });

  it('refuses a scope that runs too long', () => {
    const s = { ...good, expires: '2030-01-01' };
    expect(scopeProblems(secPack(), s, now).some((m) => m.includes('days'))).toBe(true);
  });

  it('ignores scope for a pack that does not require one', () => {
    const res = parsePack('id: x\nname: X\ndescription: d\nprofiles: [a]');
    if ('error' in res) throw new Error(res.error);
    expect(scopeProblems(res.pack, undefined, now)).toEqual([]);
  });
});

describe('describeScope / journal payload', () => {
  it('shows the engagement and targets, and journals without notes', () => {
    expect(describeScope(good).join('\n')).toContain('ENG-2026-014');
    const payload = scopeJournalPayload(secPack(), { ...good, notes: 'client contact: secret' });
    expect(JSON.stringify(payload)).not.toContain('secret');
    expect(payload.targets).toEqual(['host:10.0.0.5']);
  });
});
