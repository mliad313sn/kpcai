import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ZONES, zoneSetFromGlobs } from '@kernelpai/tools';
import { AGENT_PLACES, discoverAgents } from './agents.js';
import { hookMatches, loadHooks } from './hooks.js';
import { extensionsSummary, loadExtensions, plannerCatalog } from './load.js';
import { frontMatter, listField } from './read.js';
import { SKILL_PLACES, discoverSkills, mapAllowedTools } from './skills.js';

const zones = zoneSetFromGlobs([...DEFAULT_ZONES, 'secret-zone/**']);
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const skill = (name: string, extra = '', body = 'Do the steps.') =>
  `---\nname: ${name}\ndescription: ${name} procedure\n${extra}---\n${body}\n`;

describe('front matter', () => {
  it('reads YAML front matter and the body; refuses aliases and non-mappings', () => {
    expect(frontMatter('---\na: 1\n---\nbody')).toEqual({ data: { a: 1 }, body: 'body' });
    expect(frontMatter('no front matter')).toEqual({ data: {}, body: 'no front matter' });
    expect(() => frontMatter('---\na: &x [1]\nb: *x\n---\n')).toThrow();
    expect(() => frontMatter('---\n- a\n---\n')).toThrow(/mapping/);
    expect(listField('Read, Grep')).toEqual(['Read', 'Grep']);
    expect(listField(['a', ' '])).toEqual(['a']);
  });
});

describe('skills (SKILL.md)', () => {
  it('maps Claude Code tool names to KernelPAI tools and drops unknown ones', () => {
    expect(mapAllowedTools(['Read', 'Grep', 'Bash(git:*)', 'fs.list', 'WebSearch'])).toEqual([
      'fs.read',
      'shell.run',
      'fs.list',
    ]);
  });

  it('finds skills in .kpstudio/skills, .claude/skills and $KPAI_HOME; home wins a name', async () => {
    const root = tmp('kpai-skills-repo-');
    const home = tmp('kpai-skills-home-');
    put(root, '.kpstudio/skills/tdd/SKILL.md', skill('tdd', 'allowed-tools: Read, Grep\n'));
    put(root, '.claude/skills/review/SKILL.md', skill('review'));
    put(root, '.claude/skills/shadow/SKILL.md', skill('shadow', '', 'REPO BODY'));
    put(home, 'skills/shadow/SKILL.md', skill('shadow', '', 'HOME BODY'));
    put(root, '.claude/skills/BadName/SKILL.md', '---\ndescription: x\n---\n');
    put(root, '.claude/skills/nodesc/SKILL.md', '---\nname: nodesc\n---\n');
    const r = await discoverSkills(SKILL_PLACES(root, home), zones);
    const byName = new Map(r.skills.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual(['review', 'shadow', 'tdd']);
    expect(byName.get('tdd')).toMatchObject({ origin: 'repo', allowedTools: ['fs.read'] });
    expect(byName.get('shadow')).toMatchObject({ origin: 'home', body: 'HOME BODY' });
    expect(r.problems.join('\n')).toMatch(/invalid skill name/);
    expect(r.problems.join('\n')).toMatch(/needs a description/);
    expect(r.problems.join('\n')).toMatch(/shadow already defined/);
  });

  it('never reads a skill through a link that leaves the repository or from a zone', async () => {
    const root = tmp('kpai-skills-jail-');
    const outside = tmp('kpai-skills-outside-');
    put(outside, 'SKILL.md', skill('escape'));
    mkdirSync(join(root, '.kpstudio/skills/escape'), { recursive: true });
    symlinkSync(join(outside, 'SKILL.md'), join(root, '.kpstudio/skills/escape/SKILL.md'));
    // A linked folder: the file itself is regular, its real path is outside the repository.
    mkdirSync(join(outside, 'dir'));
    put(outside, 'dir/SKILL.md', skill('linked-dir'));
    symlinkSync(join(outside, 'dir'), join(root, '.kpstudio/skills/linked-dir'));
    const zoned = zoneSetFromGlobs(['.kpstudio/skills/zoned/**']);
    put(root, '.kpstudio/skills/zoned/SKILL.md', skill('zoned'));
    put(root, '.kpstudio/skills/ok/SKILL.md', skill('ok'));
    const r = await discoverSkills(SKILL_PLACES(root, tmp('kpai-h-')), zoned);
    expect(r.skills.map((s) => s.name)).toEqual(['ok']);
  });
});

describe('named agents', () => {
  it('reads name, description, tools and model hint from .claude/agents/*.md', async () => {
    const root = tmp('kpai-agents-');
    put(
      root,
      '.claude/agents/sec.md',
      '---\nname: security-reviewer\ndescription: Reviews auth code\ntools: Read, Grep\nmodel: sonnet\n---\nYou review security.\n',
    );
    put(root, '.claude/agents/notes.txt', 'ignored');
    put(root, '.kpstudio/agents/broken.md', '---\nname: [\n---\n');
    const r = await discoverAgents(AGENT_PLACES(root, tmp('kpai-h-')), zones);
    expect(r.agents).toEqual([
      expect.objectContaining({
        name: 'security-reviewer',
        tools: ['fs.read'],
        model: 'sonnet',
        body: 'You review security.',
        origin: 'repo',
      }),
    ]);
    expect(r.problems).toHaveLength(1);
  });
});

describe('hooks configuration', () => {
  const hook = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    event: 'before-tool',
    command: 'node',
    args: ['guard.mjs'],
    ...extra,
  });

  it('allow-lists only from $KPAI_HOME; a repository allow list is ignored', async () => {
    const root = tmp('kpai-hooks-repo-');
    const home = tmp('kpai-hooks-home-');
    put(
      root,
      '.kpstudio/hooks.json',
      JSON.stringify({
        hooks: [hook('repo-guard'), hook('repo-self', { args: ['self.mjs'] })],
        allow: [{ command: 'node', args: ['self.mjs'] }],
      }),
    );
    put(
      home,
      'hooks.json',
      JSON.stringify({ hooks: [hook('mine')], allow: [{ command: 'node', args: ['guard.mjs'] }] }),
    );
    const l = await loadHooks(home, root, zones);
    const by = Object.fromEntries(l.hooks.map((h) => [h.name, h]));
    expect(by['mine']).toMatchObject({ origin: 'home', allowListed: true, timeoutMs: 10_000 });
    expect(by['repo-guard']).toMatchObject({ origin: 'repo', allowListed: true });
    expect(by['repo-self']?.allowListed).toBe(false);
    expect(l.problems.join()).toMatch(/"allow" is ignored in a repository/);
    expect(l.broken).toEqual([]);
  });

  it('marks a broken hooks file (bad JSON, unknown key, too large) and keeps the rest', async () => {
    const root = tmp('kpai-hooks-bad-');
    const home = tmp('kpai-hooks-badhome-');
    put(root, '.kpstudio/hooks.json', JSON.stringify({ hooks: [hook('x', { shell: true })] }));
    put(home, 'hooks.json', '{ not json');
    const l = await loadHooks(home, root, zones);
    expect(l.broken).toEqual(['~kpai/hooks.json', '.kpstudio/hooks.json']);
    expect(l.hooks).toEqual([]);
    const dup = tmp('kpai-hooks-dup-');
    put(dup, '.kpstudio/hooks.json', JSON.stringify({ hooks: [hook('a'), hook('a')] }));
    expect((await loadHooks(tmp('kpai-h-'), dup, zones)).problems.join()).toMatch(/already/);
    const big = tmp('kpai-hooks-big-');
    put(big, '.kpstudio/hooks.json', `{"hooks": [], "x": "${'a'.repeat(70_000)}"}`);
    expect((await loadHooks(tmp('kpai-h-'), big, zones)).broken).toHaveLength(1);
  });

  it('matches tools by exact name or prefix', () => {
    expect(hookMatches({}, 'fs.read')).toBe(true);
    expect(hookMatches({ tools: ['fs.*'] }, 'fs.write')).toBe(true);
    expect(hookMatches({ tools: ['fs.read'] }, 'fs.write')).toBe(false);
  });
});

describe('loaded extensions', () => {
  it('summarises names and descriptions; the planner never sees a body', async () => {
    const root = tmp('kpai-ext-');
    put(root, '.kpstudio/skills/tdd/SKILL.md', skill('tdd', '', 'SECRET PROCEDURE BODY'));
    put(root, '.claude/agents/a.md', '---\nname: a\ndescription: an "agent"\n---\nAGENT BODY\n');
    const env = { KPAI_HOME: tmp('kpai-exth-') };
    const e = await loadExtensions(env, root, zones);
    const catalog = plannerCatalog(e);
    expect(catalog).toContain('tdd procedure');
    expect(catalog).toContain('an &#34;agent&#34;');
    expect(catalog).not.toMatch(/SECRET PROCEDURE BODY|AGENT BODY/);
    const summary = JSON.stringify(extensionsSummary(e));
    expect(summary).not.toMatch(/SECRET PROCEDURE BODY|AGENT BODY/);
    expect(extensionsSummary(e).skills[0]).toMatchObject({ trust: 'untrusted', origin: 'repo' });
    expect(plannerCatalog({ ...e, skills: [], agents: [] })).toBe('');
  });
});
