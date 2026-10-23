import * as packs from '@kernelpai/packs';
import { describe, expect, it } from 'vitest';
import { GradedPermissionPolicy } from './policy.js';
import { buildZoneSet, CREDENTIAL_SAMPLES, relaxationProblem } from './zone-set.js';
import {
  CREDENTIAL_ZONES,
  DEFAULT_ZONES,
  HEURISTIC_ZONES,
  inForbiddenZone,
  relaxationFor,
  tierOf,
  zoneHit,
  zoneSetFromGlobs,
  type ZoneSet,
} from './zones.js';

const defaults = zoneSetFromGlobs(DEFAULT_ZONES, false);

function relaxed(...allow: string[]): ZoneSet {
  return buildZoneSet({
    heuristics: true,
    policyPaths: [],
    callerPaths: [],
    packs: {
      added: [],
      relaxed: allow.map((a) => ({ pack: 'p', allow: a, reason: 'r' })),
      pending: [],
      refused: [],
    },
    caseInsensitive: false,
  });
}

/** Measured false positives of the old defaults (audit F2), with the folder a pack relaxes. */
const AUDIT_F2 = [
  'rules/aws_secret_access.yml',
  'client_secret_rotation_runbook.md',
  'credentials_policy.md',
  'detections/secretsdump.yml',
  'writeups/ctf-secret-flag.md',
  'tools/credentials-scanner/README.md',
];

describe('credential tier (WI-S7-01)', () => {
  it.each([
    '.env',
    'app/.env.local',
    '.env.production',
    '.envrc',
    'certs/server.pem',
    'tls.key',
    'AuthKey_ABC.p8',
    'store.p12',
    'cert.pfx',
    'home/id_rsa',
    'id_ed25519.pub',
    'id_ecdsa',
    '.aws',
    '.aws/credentials',
    'x/.ssh/config',
    '.gnupg/pubring.kbx',
    '.kube/config',
    'ops/kubeconfig',
    'prod.kubeconfig',
    '.config/gcloud/application_default_credentials.json',
    '.docker/config.json',
    '.npmrc',
    '.netrc',
    '_netrc',
    '.git-credentials',
    '.pgpass',
    'config/credentials.json',
    'src/client_secret_123.apps.googleusercontent.com.json',
    'config/secrets.yml',
  ])('forbids %s, even inside a relaxed folder', (p) => {
    expect(inForbiddenZone(p, defaults)).toBe(true);
    const r = relaxed('detections/**', 'writeups/**');
    expect(inForbiddenZone(`detections/${p}`, r)).toBe(true);
    expect(zoneHit(`detections/${p}`, r)?.tier).toBe('credential');
  });

  it('every credential zone has a sample a relaxation may never match', () => {
    for (const glob of CREDENTIAL_ZONES) {
      expect(
        CREDENTIAL_SAMPLES.some((s) => zoneHit(s, defaults)?.glob === glob),
        glob,
      ).toBe(true);
    }
  });

  it('lets placeholder env files through, and only those', () => {
    for (const p of ['.env.example', 'app/.env.sample', '.env.template']) {
      expect(inForbiddenZone(p, defaults), p).toBe(false);
    }
    for (const p of ['.env.example.local', '.env.examples', '.env.dist', '.env.Example']) {
      expect(inForbiddenZone(p, defaults), p).toBe(true);
    }
    expect(inForbiddenZone('.env.Example', zoneSetFromGlobs([], true))).toBe(false);
    // An explicit addition is never exempt.
    expect(inForbiddenZone('.env.example', zoneSetFromGlobs(['.env.example'], false))).toBe(true);
  });

  it('keeps *.key name-based without a probe, and asks the probe for each .key item', () => {
    expect(inForbiddenZone('slides/Pitch.key', defaults)).toBe(true);
    const keynote = (rel: string) => rel.endsWith('Pitch.key');
    expect(inForbiddenZone('slides/Pitch.key', defaults, keynote)).toBe(false);
    expect(inForbiddenZone('slides/Pitch.key/Data/a.png', defaults, keynote)).toBe(false);
    expect(inForbiddenZone('slides/Pitch.key/server.key', defaults, keynote)).toBe(true);
    expect(inForbiddenZone('slides/Pitch.key/id_rsa', defaults, keynote)).toBe(true);
  });

  it('is always in force: a flat list or switched-off defaults cannot drop it', () => {
    expect(inForbiddenZone('.env', zoneSetFromGlobs([]))).toBe(true);
    const off = new GradedPermissionPolicy({ defaultForbiddenPaths: false });
    expect(inForbiddenZone('id_rsa', off.zoneSet())).toBe(true);
    expect(inForbiddenZone('credentials_policy.md', off.zoneSet())).toBe(false);
    expect(tierOf('*.pem')).toBe('credential');
    expect(tierOf('**/*secret*')).toBe('heuristic');
    expect(tierOf('private/**')).toBe('added');
  });
});

describe('heuristic tier and relaxations (WI-S5-01)', () => {
  it('blocks the audit F2 names by default', () => {
    for (const p of AUDIT_F2) expect(inForbiddenZone(p, defaults), p).toBe(true);
  });

  it('opens a heuristic name only under an approved folder relaxation', () => {
    const r = relaxed('rules/**', 'detections/**', 'writeups/**', 'tools/**', 'policies/**');
    for (const p of ['rules/aws_secret_access.yml', 'detections/secretsdump.yml']) {
      expect(inForbiddenZone(p, r), p).toBe(false);
      expect(relaxationFor(p, r)?.pack).toBe('p');
    }
    expect(inForbiddenZone('writeups/ctf-secret-flag.md', r)).toBe(false);
    expect(inForbiddenZone('tools/credentials-scanner/README.md', r)).toBe(false);
    expect(inForbiddenZone('credentials_policy.md', r)).toBe(true);
    expect(inForbiddenZone('src/my_secret.txt', r)).toBe(true);
    expect(relaxationFor('detections/plain.yml', r)).toBeUndefined();
  });

  it('never opens a heuristic-named folder above the relaxed one', () => {
    const r = relaxed('writeups/**');
    expect(inForbiddenZone('writeups/secret/flag.md', r)).toBe(false);
    expect(inForbiddenZone('my-secrets/writeups/flag.md', r)).toBe(true);
    expect(zoneHit('my-secrets/writeups/flag.md', r)?.glob).toBe('**/*secret*');
  });

  it('does not relax additions, even when they repeat a heuristic', () => {
    const z = buildZoneSet({
      heuristics: true,
      policyPaths: ['**/*secret*'],
      callerPaths: ['private/**'],
      packs: {
        added: [{ pack: 'ds', glob: '**/pii/**' }],
        relaxed: [{ pack: 'p', allow: 'detections/**', reason: 'r' }],
        pending: [],
        refused: [],
      },
      caseInsensitive: false,
    });
    expect(inForbiddenZone('detections/aws_secret.yml', z)).toBe(true);
    expect(zoneHit('detections/aws_secret.yml', z)?.origin).toBe('policy.json');
    expect(zoneHit('detections/pii/x.csv', z)?.origin).toBe('pack:ds');
    expect(zoneHit('private/a', z)?.origin).toBe('caller');
  });

  it('matches case-insensitively when asked', () => {
    const ci = zoneSetFromGlobs(DEFAULT_ZONES, true);
    expect(inForbiddenZone('Config/MY_SECRET.txt', ci)).toBe(true);
    expect(inForbiddenZone('ID_RSA', ci)).toBe(true);
    expect(inForbiddenZone('.', ci)).toBe(false);
  });
});

describe('relaxationProblem (red team)', () => {
  it.each([
    ['.env', /credential.*cannot be relaxed/],
    ['.env*', /credential/],
    ['id_rsa', /credential/],
    ['**/.aws/**', /credential/],
    ['.aws/**', /credential/],
    ['*.pem', /credential/],
    ['certs/server.pem', /credential/],
    ['deploy/*.key', /credential/],
    ['keys/id_*', /credential/],
    ['ops/**/kubeconfig', /credential/],
    ['config/**', /credential/],
    ['**/credentials*', /credential/],
    ['**', /credential|broad/],
    ['**/*.md', /folder name/],
    ['writeups', /folder name/],
    ['ir/**', /too broad/],
    ['/etc/**', /workspace-relative/],
    ['a/../.env', /workspace-relative/],
  ])('refuses %s', (glob, why) => {
    expect(relaxationProblem(glob)).toMatch(why);
  });

  it.each(['detections/**', 'sigma/**', 'policies/**', 'runbooks/**', 'writeups/**'])(
    'accepts the shipped folder relaxation %s',
    (glob) => expect(relaxationProblem(glob)).toBeUndefined(),
  );

  it('throws when a hand-built plan smuggles in a bad relaxation', () => {
    expect(() => relaxed('**/.ssh/**')).toThrow(/refused: .*credential/);
  });

  it('heuristics are the only relaxable zones', () => {
    expect(HEURISTIC_ZONES).toEqual(['**/credentials*', '**/*secret*']);
    expect(DEFAULT_ZONES.filter((g) => tierOf(g) === 'heuristic')).toEqual(HEURISTIC_ZONES);
  });
});

describe('@kernelpai/packs mirror', () => {
  it('stays a subset of the tools tiers (drift guard)', () => {
    for (const g of packs.CORE_CREDENTIAL_ZONES) expect(CREDENTIAL_ZONES, g).toContain(g);
    expect([...packs.HEURISTIC_ZONES].sort()).toEqual([...HEURISTIC_ZONES].sort());
    for (const sample of packs.CREDENTIAL_SAMPLES) {
      expect(inForbiddenZone(sample, defaults), sample).toBe(true);
    }
  });
});
