import { describe, expect, it } from 'vitest';
import {
  CORE_CREDENTIAL_ZONES,
  describeZones,
  isForbidden,
  planZones,
  relaxKey,
  relaxProblem,
} from './zones.js';
import type { Pack } from './schema.js';

function pack(over: Partial<Pack>): Pack {
  return {
    id: over.id ?? 'p',
    version: 1,
    name: 'P',
    description: 'd',
    profiles: ['x'],
    markers: [],
    plans: [],
    proposedTaskTypes: [],
    reviewCriteria: [],
    tools: [],
    zones: over.zones ?? { add: [], relax: [] },
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
    ...over,
  };
}

describe('relaxProblem', () => {
  it('refuses a relaxation that would expose credentials', () => {
    expect(relaxProblem('**')).toBeDefined();
    expect(relaxProblem('.env*')).toBeDefined();
    expect(relaxProblem('**/credentials*')).toBeDefined();
    expect(relaxProblem('config/**')).toContain('credential');
  });

  it('accepts a narrow folder relaxation', () => {
    expect(relaxProblem('detections/**')).toBeUndefined();
    expect(relaxProblem('sigma/**')).toBeUndefined();
  });
});

describe('planZones + isForbidden', () => {
  it('always forbids credential files, whatever a pack asks', () => {
    const p = pack({ zones: { add: [], relax: [{ allow: 'detections/**', reason: 'r' }] } });
    const plan = planZones([p], new Set([relaxKey('p', 'detections/**')]));
    for (const sample of ['.env', 'id_rsa', 'app.pem', '.ssh/config']) {
      expect(isForbidden(sample, plan)).toBe(true);
    }
  });

  it('relaxes a heuristic zone only after approval', () => {
    const p = pack({ zones: { add: [], relax: [{ allow: 'detections/**', reason: 'r' }] } });
    const before = planZones([p], new Set());
    expect(before.pending).toHaveLength(1);
    expect(isForbidden('detections/aws_secret_access.yml', before)).toBe(true);
    const after = planZones([p], new Set([relaxKey('p', 'detections/**')]));
    expect(after.relaxed).toHaveLength(1);
    expect(isForbidden('detections/aws_secret_access.yml', after)).toBe(false);
    // A secret elsewhere is still blocked.
    expect(isForbidden('src/my_secret.txt', after)).toBe(true);
  });

  it('refuses an over-broad relaxation and reports it', () => {
    const p = pack({ zones: { add: [], relax: [{ allow: 'config/**', reason: 'r' }] } });
    const plan = planZones([p], new Set([relaxKey('p', 'config/**')]));
    expect(plan.refused).toHaveLength(1);
    expect(isForbidden('config/secrets.yml', plan)).toBe(true);
    expect(describeZones(plan).some((l) => l.startsWith('refused'))).toBe(true);
  });

  it('applies pack-added zones unconditionally', () => {
    const p = pack({ zones: { add: ['loot/**'], relax: [] } });
    const plan = planZones([p], new Set());
    expect(isForbidden('loot/creds.txt', plan)).toBe(true);
    expect(describeZones(plan)).toContain('zone added: loot/**');
  });

  it('keeps the policy default credential list in sync', () => {
    expect(CORE_CREDENTIAL_ZONES).toContain('.env');
    expect(CORE_CREDENTIAL_ZONES).toContain('**/.ssh/**');
  });
});
