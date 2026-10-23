import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KernelError } from './errors.js';
import { Kernel } from './kernel.js';
import { REQ, TEST_OPTIONS, recordingHost, type RecordingHost } from './test-helpers/fixture.js';
import { saveOptIns, workspaceVerdict } from './workspace.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };

const code = (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e instanceof KernelError ? e.code : String(e)),
  );

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kpai-pack-ws-'));
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, rel), text);
  return dir;
}

const home = (): Record<string, string> => ({
  KPAI_HOME: mkdtempSync(join(tmpdir(), 'kpai-pack-home-')),
});

describe('pack-aware workspace guard (WI-S1-01)', () => {
  it('accepts data, firmware-project, game and GIS folders by their pack markers', async () => {
    const env = home();
    for (const f of ['sales.csv', 'platformio.ini', 'project.godot', 'parcels.gpkg']) {
      const v = await workspaceVerdict(folder({ [f]: 'x' }), env, '/nowhere');
      expect(v, f).toMatchObject({ ok: true, by: { path: f } });
    }
  });

  it('asks before a lone binary counts; remembers the opt-in; home and roots stay refused', async () => {
    const env = home();
    const dir = folder({ 'firmware.bin': 'x' });
    const v = await workspaceVerdict(dir, env, '/nowhere');
    expect(v).toMatchObject({ ok: false, askOptIn: ['reverse-engineering'] });
    expect(v.problem).toMatch(/need your opt-in/);
    await saveOptIns(env, dir, ['reverse-engineering']);
    await saveOptIns(env, dir, ['reverse-engineering']);
    expect((await workspaceVerdict(dir, env, '/nowhere')).ok).toBe(true);
    const fakeHome = folder({ 'sales.csv': 'x' });
    expect((await workspaceVerdict(fakeHome, env, fakeHome)).problem).toMatch(/home folder/);
    expect((await workspaceVerdict(parse(fakeHome).root, env)).problem).toMatch(/filesystem root/);
    expect((await workspaceVerdict(folder({ 'a.zzz': 'x' }), env, '/nowhere')).problem).toMatch(
      /no project marker/,
    );
  });

  it('the kernel asks the opt-in question once and keeps the answer', async () => {
    const host = recordingHost(CHEAP);
    host.cwd = folder({ 'dump.bin': 'x' });
    host.answers = [false];
    const k = new Kernel(host);
    expect(await code(k.checkWorkspace())).toBe('workspace');
    host.answers = [true];
    await k.checkWorkspace();
    expect(host.asked.at(-1)?.question).toMatch(/packs: reverse-engineering/);
    const before = host.asked.length;
    await k.checkWorkspace();
    expect(host.asked.length).toBe(before);
    await k.close();
  });
});

/** A user pack in $KPAI_HOME/packs, matched by `marker`. */
function userPack(host: RecordingHost, id: string, marker: string, extra: string[] = []): void {
  mkdirSync(join(host.home, 'packs'), { recursive: true });
  const yaml = [
    `id: ${id}`,
    `name: Test ${id}`,
    'description: A pack used by the kernel tests.',
    'profiles: [tests]',
    'markers:',
    `  - { glob: ${marker} }`,
    ...extra,
    '',
  ].join('\n');
  writeFileSync(join(host.home, 'packs', `${id}.yaml`), yaml);
  writeFileSync(join(host.cwd, marker), 'x\n');
}

describe('packs and zones in the plan (D-020)', () => {
  it('lists the packs with their reason and every zone with its origin; pack zones bind', async () => {
    const host = recordingHost(CHEAP);
    host.fallback = true;
    writeFileSync(join(host.home, 'policy.json'), JSON.stringify({ forbiddenPaths: ['*.log'] }));
    userPack(host, 'zonetest', 'zone.marker', [
      'zones:',
      '  add: ["src/**"]',
      '  relax: [{ allow: "detections/**", reason: "rules about secrets, not secrets" }]',
    ]);
    const k = new Kernel(host);
    const p = await k.plan(REQ, TEST_OPTIONS);
    expect(p.packs.packs.find((x) => x.id === 'zonetest')).toMatchObject({
      reason: 'found zone.marker',
      evidence: ['zone.marker'],
    });
    expect(p.packs.zones).toEqual(
      expect.arrayContaining([
        { glob: '.env', tier: 'credential', origin: 'default' },
        { glob: '**/*secret*', tier: 'heuristic', origin: 'default' },
        { glob: '*.log', tier: 'added', origin: 'policy.json' },
        { glob: 'src/**', tier: 'added', origin: 'pack:zonetest' },
      ]),
    );
    const relax = {
      pack: 'zonetest',
      allow: 'detections/**',
      reason: 'rules about secrets, not secrets',
    };
    expect(p.packs.pending).toEqual([relax]);
    expect(p.packs.lines).toContain('zone added by zonetest: src/**');
    // Run start asks about the relaxation once and remembers the answer (relaxKey).
    host.answers = [true];
    const h = await k.startRun({ request: REQ, planId: p.planId, options: { isolated: false } });
    expect(host.asked[0]?.question).toMatch(/exempt detections\/\*\* from the name heuristics/);
    await h.done;
    const res = await k.applyPatches(h.runId, { nodeIds: ['implementation'] });
    expect(res[0]).toMatchObject({ ok: false, message: expect.stringMatching(/forbidden zone/) });
    const routing = k.events(h.sessionId).find((e) => e.type === 'routing' && e.nodeId);
    expect(JSON.stringify(routing?.payload)).toMatch(/"id":"zonetest"/);
    const actions = k.events(h.sessionId).map((e) => (e.payload as { action?: string }).action);
    expect(actions).toContain('zone relaxed');
    const again = await k.plan(REQ, TEST_OPTIONS);
    expect(again.packs).toMatchObject({ pending: [], relaxed: [relax] });
    await k.close();
  });
});

const SCOPE_PACK = ['safety:', '  requiresScope: true', '  scopeKinds: [binary]'];
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const SCOPE = {
  targets: [{ kind: 'binary', value: 'sample.bin' }],
  engagementRef: 'CTF-2026-7',
  authorisedBy: 'Event organisers',
  expires: tomorrow,
  notes: 'client secret detail',
};

describe('authorised scope (WI-S1-03)', () => {
  it('refuses the run without a valid scope; journals the scope without notes', async () => {
    const host = recordingHost(CHEAP);
    userPack(host, 'scoped', 'scoped.marker', SCOPE_PACK);
    const k = new Kernel(host);
    const p = await k.plan(REQ, TEST_OPTIONS);
    expect(p.scope).toMatchObject({
      required: ['scoped'],
      problems: [expect.stringMatching(/--scope/)],
    });
    expect(await code(k.startRun({ request: REQ, planId: p.planId }))).toBe('refused');
    const bad = { ...SCOPE, targets: [{ kind: 'binary', value: '*' }] };
    expect(await code(k.startRun({ request: REQ, options: { ...TEST_OPTIONS, scope: bad } }))).toBe(
      'refused',
    );
    const ok = await k.startRun({
      request: REQ,
      planId: p.planId,
      options: { ...TEST_OPTIONS, scope: SCOPE, isolated: false },
    });
    await ok.done;
    const notes = k.events(ok.sessionId).filter((e) => e.type === 'intervention');
    const action = (e: (typeof notes)[number]): unknown =>
      (e.payload as { action?: string }).action;
    // Journaled once, by the runner (S4), not again by the kernel.
    const scoped = notes.filter((e) => action(e) === 'scope accepted');
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.payload).toEqual({
      action: 'scope accepted',
      pack: 'scoped',
      engagementRef: 'CTF-2026-7',
      authorisedBy: 'Event organisers',
      expires: tomorrow,
      targets: ['binary:sample.bin'],
    });
    expect(JSON.stringify(notes)).not.toMatch(/client secret detail/);
    // The two early refusals were journaled by the kernel (the runner was never reached).
    expect(notes.filter((e) => action(e) === 'run refused')).toHaveLength(2);
    await k.close();
  });

  it('a scope declared in the repository is confirmed by the human first', async () => {
    const host = recordingHost(CHEAP);
    userPack(host, 'scoped', 'scoped.marker', SCOPE_PACK);
    mkdirSync(join(host.cwd, '.kpstudio'));
    const yaml = [
      'targets: [{ kind: binary, value: sample.bin }]',
      'engagementRef: CTF-2026-7',
      'authorisedBy: Event organisers',
      `expires: "${tomorrow}"`,
    ].join('\n');
    writeFileSync(join(host.cwd, '.kpstudio/scope.yaml'), yaml);
    const k = new Kernel(host);
    const p = await k.plan(REQ, TEST_OPTIONS);
    expect(p.scope).toMatchObject({ source: 'file', problems: [] });
    expect(p.scope.lines[0]).toMatch(/authorised scope: CTF-2026-7/);
    host.answers = [false];
    expect(await code(k.startRun({ request: REQ, planId: p.planId }))).toBe('refused');
    expect(host.asked.at(-1)?.question).toMatch(/scope declared in \.kpstudio\/scope\.yaml/);
    host.answers = [true];
    const h = await k.startRun({ request: REQ, planId: p.planId, options: { isolated: false } });
    expect((await h.done).status).toBe('finished');
    writeFileSync(join(host.cwd, '.kpstudio/scope.yaml'), 'targets: [');
    const broken = await k.plan(REQ, TEST_OPTIONS);
    expect(broken.scope.problems.join(' ')).toMatch(/needs a declared authorised scope/);
    await k.close();
  });
});
