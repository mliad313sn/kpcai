import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PackSchema, type Pack } from '@kernelpai/packs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolBus } from './create.js';
import { describePackZones, journalPackZones, planPackZones, relaxKey } from './pack-zones.js';
import { GradedPermissionPolicy } from './policy.js';
import { call, makeCtx, RecordingJournal, tempDir } from './test-helpers/ctx.js';

function pack(id: string, zones: { add?: string[]; relax?: string[] }): Pack {
  return PackSchema.parse({
    id,
    version: 1,
    name: id,
    description: 'test pack',
    profiles: ['test'],
    zones: {
      add: zones.add ?? [],
      relax: (zones.relax ?? []).map((allow) => ({ allow, reason: `${id} needs ${allow}` })),
    },
  });
}

function git(cwd: string, ...args: string[]): string {
  const opts = ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'core.autocrlf=false'];
  return execFileSync('git', [...opts, ...args], { cwd, encoding: 'utf8' });
}

const defensive = pack('sec', { relax: ['detections/**'], add: ['**/pii/**'] });
const approved = [relaxKey('sec', 'detections/**')];
const SHELL = { name: 'shell.run', risk: 'destructive' as const };

describe('red team: a pack cannot relax credential zones', () => {
  it.each(['.env', 'id_rsa', '**/.aws/**', '*.pem', 'keys/server.pem', '**/.ssh/**'])(
    'refuses relax %s with a clear error, even when "approved"',
    async (allow) => {
      const evil = pack('evil', { relax: [allow] });
      const journal = new RecordingJournal();
      const { packZones, activePolicy } = await createToolBus({
        journal,
        packs: { enabled: [evil], approved: [relaxKey('evil', allow)] },
      });
      expect(packZones.relaxed).toEqual([]);
      expect(packZones.refused[0]?.problem).toMatch(/credential|broad/);
      expect(activePolicy?.relaxations).toEqual([]);
      expect(describePackZones(packZones)[0]).toMatch(/^refused \(evil\)/);
      const event = journal.events.find((e) => e.payload.action === 'zone relaxation refused');
      expect(event?.payload).toMatchObject({ pack: 'evil', allow });
    },
  );
});

describe('pack zones in the tool bus (WI-S5-01)', () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: root, cleanup } = await tempDir());
    git(root, 'init', '-q');
    await mkdir(path.join(root, 'detections', 'pii'), { recursive: true });
    await mkdir(path.join(root, 'detections', '.aws'));
    const files: Record<string, string> = {
      'detections/aws_secret_access.yml': 'title: base\n',
      'detections/.env': 'X=base\n',
      'detections/server.pem': 'base\n',
      'detections/.aws/credentials': 'base\n',
      'detections/pii/people.csv': 'base\n',
      'src/my_secret.txt': 'base\n',
      'src/app.ts': 'base\n',
      '.env': 'X=base\n',
    };
    await mkdir(path.join(root, 'src'));
    for (const [p, c] of Object.entries(files)) await writeFile(path.join(root, p), c);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
    for (const p of Object.keys(files)) {
      await writeFile(path.join(root, p), `changed LEAK_${p.replace(/\W/g, '_')}\n`);
    }
    await writeFile(path.join(root, 'detections', 'untracked_secret_rule.yml'), 'new\n');
  });
  afterEach(() => cleanup());

  const make = (journal = new RecordingJournal(), ok = approved) =>
    createToolBus({ journal, packs: { enabled: [defensive], approved: ok, sessionId: 'S' } });

  it('applies an approved relaxation to the heuristics only, and journals it', async () => {
    const journal = new RecordingJournal();
    const { bus, activePolicy, packZones } = await make(journal);
    expect(packZones.relaxed).toHaveLength(1);
    const ev = journal.events.find((e) => e.payload.action === 'zone relaxed');
    expect(ev).toMatchObject({ sessionId: 'S', type: 'intervention' });
    expect(activePolicy?.zones.find((z) => z.glob === '**/pii/**')?.origin).toBe('pack:sec');
    expect(activePolicy?.zones.find((z) => z.glob === '.env')?.tier).toBe('credential');
    expect(activePolicy?.relaxations).toEqual([
      { pack: 'sec', allow: 'detections/**', reason: 'sec needs detections/**' },
    ]);
    const ctx = makeCtx(root);
    const ok = await bus.call(call('fs.read', { path: 'detections/aws_secret_access.yml' }), ctx);
    expect(ok.content).toContain('changed');
    expect(journal.last().payload.relaxedZones).toEqual([
      { path: 'detections/aws_secret_access.yml', pack: 'sec', allow: 'detections/**' },
    ]);
    for (const p of [
      '.env',
      'detections/.env',
      'detections/server.pem',
      'detections/.aws/credentials',
      'detections/pii/people.csv',
      'src/my_secret.txt',
    ]) {
      const r = await bus.call(call('fs.read', { path: p }), ctx);
      expect(r.content, p).toMatch(/forbidden zone/);
    }
  });

  it('git.diff / git.status show the relaxed rule and hide credentials (with diff.noprefix)', async () => {
    const { bus } = await make();
    git(root, 'config', 'diff.noprefix', 'true');
    const ctx = makeCtx(root);
    for (const input of [{}, { path: 'detections' }]) {
      const diff = await bus.call(call('git.diff', input), ctx);
      expect(diff.content).toContain('LEAK_detections_aws_secret_access_yml');
      expect(diff.content).not.toMatch(/LEAK_(_env|detections__env|.*pem|.*aws_cred|.*pii|src_my)/);
      expect(diff.content).not.toMatch(/\.env|server\.pem|\.aws|pii|my_secret/);
    }
    const status = await bus.call(call('git.status', {}), ctx);
    expect(status.content).toContain('detections/aws_secret_access.yml');
    expect(status.content).toContain('detections/untracked_secret_rule.yml');
    expect(status.content).not.toMatch(/\.env|server\.pem|\.aws|pii|my_secret/);
  });

  it('shell path arguments use the same zones', async () => {
    const { bus } = await make();
    const policy = bus.policy as GradedPermissionPolicy;
    const ctx = makeCtx(root);
    const reason = (...args: string[]) =>
      policy.reason(
        { ...SHELL, description: '', inputSchema: {}, source: 'builtin' },
        call('shell.run', { command: 'cat', args }),
        ctx,
      );
    expect(reason('detections/aws_secret_access.yml')).toBeUndefined();
    expect(reason('detections/.env')).toMatch(/credential file/);
    expect(reason('--file=detections/.aws/credentials')).toMatch(/forbidden zone/);
    expect(reason('src/my_secret.txt')).toMatch(/name heuristic/);
  });

  it('keeps redacting secret-shaped content in relaxed files', async () => {
    await writeFile(
      path.join(root, 'detections', 'aws_secret_access.yml'),
      'example: aws_secret_access_key = wJalrXUtnFEMI2K7MDENGbPxRfiCYEXAMPLEKEY\nid: AKIAIOSFODNN7EXAMPLE\n',
    );
    const { bus } = await make();
    const r = await bus.call(
      call('fs.read', { path: 'detections/aws_secret_access.yml' }),
      makeCtx(root),
    );
    expect(r.content).not.toMatch(/wJalrXUtnFEMI|AKIAIOSFODNN7/);
    expect(r.content).toContain('[redacted]');
  });

  it('does not apply a relaxation that was not approved, or cannot be journaled', async () => {
    const pending = await make(new RecordingJournal(), []);
    expect(pending.packZones.pending).toHaveLength(1);
    expect(describePackZones(pending.packZones)).toContain(
      'needs your approval (sec): detections/** — sec needs detections/**',
    );
    const ctx = makeCtx(root);
    const r = await pending.bus.call(
      call('fs.read', { path: 'detections/aws_secret_access.yml' }),
      ctx,
    );
    expect(r.content).toMatch(/forbidden zone.*a domain pack can exempt a folder/);
    const unjournaled = await createToolBus({ packs: { enabled: [defensive], approved } });
    expect(unjournaled.packZones.relaxed).toEqual([]);
    expect(unjournaled.packZones.refused[0]?.problem).toMatch(/could not be journaled/);
    const broken = {
      append: () => {
        throw new Error('disk full');
      },
    };
    expect(
      journalPackZones(planPackZones({ enabled: [defensive], approved }), broken).relaxed,
    ).toEqual([]);
  });

  it('a custom policy ignores pack zones and says so', async () => {
    const { packZones, activePolicy } = await createToolBus({
      policy: new GradedPermissionPolicy(),
      journal: new RecordingJournal(),
      packs: { enabled: [defensive], approved },
    });
    expect(activePolicy).toBeUndefined();
    expect(packZones.refused[0]?.problem).toMatch(/custom permission policy/);
  });

  it('shows each zone with its origin (default / policy.json / pack)', async () => {
    const { dir: home, cleanup: rmHome } = await tempDir();
    try {
      await writeFile(
        path.join(home, 'policy.json'),
        JSON.stringify({ forbiddenPaths: ['ops/**'] }),
      );
      const { activePolicy } = await createToolBus({
        kpaiHome: home,
        journal: new RecordingJournal(),
        packs: { enabled: [defensive], approved },
      });
      const origins = new Set(activePolicy?.zones.map((z) => z.origin));
      expect([...origins].sort()).toEqual(['default', 'pack:sec', 'policy.json']);
      expect(activePolicy?.forbiddenPaths).toContain('ops/**');
    } finally {
      await rmHome();
    }
  });
});
