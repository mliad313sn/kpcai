// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { studio } from '../store/store';
import { initialTools, serversFromTools, tools } from '../store/tools';
import type { FakeKernel } from '../test-helpers/fake-kernel';
import { renderStudio, teardown, until } from '../test-helpers/ui';

let kernel: FakeKernel | undefined;

const TOOLS = {
  tools: [
    { name: 'fs.read', risk: 'read', source: 'builtin', description: 'Read a file' },
    { name: 'mcp.gh.issue', risk: 'write', source: 'mcp:gh', description: 'Create an issue' },
    {
      name: 'mcp.evil.run',
      risk: 'destructive',
      source: 'mcp:evil',
      description:
        '[blocked] MCP server evil is not approved in its current form; calls are refused.',
    },
  ],
  errors: [
    { server: 'evil', message: 'MCP server "evil" is blocked: tool list changed' },
    { server: 'gone', message: 'spawn ENOENT' },
  ],
};

const EXT = {
  skills: [
    {
      name: 'refactor',
      description: 'Refactor <b>safely</b>',
      origin: 'repo',
      path: '.claude/skills/refactor/SKILL.md',
      trust: 'untrusted',
    },
  ],
  agents: [{ name: 'tester', description: '', origin: 'home', path: '~/a.md', trust: 'user' }],
  hooks: [
    {
      name: 'lint',
      event: 'after-patch',
      origin: 'repo',
      command: 'pnpm lint',
      allowListed: false,
    },
    { name: 'fmt', event: 'before-tool', origin: 'home', command: 'fmt', allowListed: true },
  ],
  problems: ['skill "x": no description'],
};

const TICKET = {
  id: 'T-1',
  path: '.kpstudio/tickets/T-1.md',
  title: 'Fix <login>',
  status: 'open',
  criteria: ['tests pass'],
  skill: 'refactor',
  trust: 'untrusted',
};

function handlers(extra: Record<string, (p: unknown) => unknown> = {}) {
  return {
    'tools.list': () => TOOLS,
    'extensions.list': () => EXT,
    'tickets.list': () => ({ tickets: [TICKET], problems: ['T-2.md: no title'] }),
    'tickets.show': () => ({
      ticket: TICKET,
      request: 'Ticket T-1 (untrusted):\n> Fix <login>',
      options: { skill: 'refactor' },
    }),
    ...extra,
  };
}

async function openTools(extra: Record<string, (p: unknown) => unknown> = {}) {
  ({ kernel } = await renderStudio(handlers(extra), { tier: 'regular' }));
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: 'Tools & skills' }));
  await until(() => tools.getState().loaded);
  return user;
}

beforeEach(() => tools.setState(initialTools(), true));
afterEach(async () => {
  await teardown(kernel);
  kernel = undefined;
});

describe('MCP servers from the tool list', () => {
  it('groups tools by server, marks blocked ones and failed servers', () => {
    const rows = serversFromTools(TOOLS as never);
    expect(rows.map((r) => [r.server, r.status, r.tools.length])).toEqual([
      ['evil', 'blocked', 1],
      ['gh', 'approved', 1],
      ['gone', 'unreachable', 0],
    ]);
    expect(rows[0]!.blockedTools).toEqual(['mcp.evil.run']);
    expect(rows[0]!.reason).toContain('tool list changed');
  });
});

describe('Tools & skills tab (R-501, R-502)', () => {
  it('lists servers read-only, skills, agents, hooks and tickets as text', async () => {
    await openTools();
    const evil = screen.getByRole('article', { name: 'evil' });
    expect(within(evil).getByText('blocked')).toBeTruthy();
    expect(within(evil).getByText(/does not say what changed/)).toBeTruthy();
    expect(within(evil).getByText('kpai mcp approve evil')).toBeTruthy();
    expect(within(evil).queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.getByText(/read-only/)).toBeTruthy();
    expect(screen.getByText('Refactor <b>safely</b>')).toBeTruthy();
    expect(screen.getByText('pnpm lint')).toBeTruthy();
    expect(screen.getByText(/asks you each time/)).toBeTruthy();
    expect(screen.getByText('skill "x": no description')).toBeTruthy();
    expect(screen.getByText('Fix <login>')).toBeTruthy();
    expect(screen.getByText('T-2.md: no title')).toBeTruthy();
  });

  it('opens a ticket and plans it with its skill, never running it', async () => {
    const user = await openTools();
    await user.click(screen.getByRole('button', { name: 'Open T-1' }));
    await until(() => !!screen.queryByText(/Ticket T-1 \(untrusted\)/));
    await user.click(screen.getByRole('button', { name: 'Plan this ticket' }));
    await until(() => kernel!.calls('plan').length === 1);
    expect(kernel!.calls('plan')[0]).toMatchObject({ options: { skill: 'refactor' } });
    expect(studio.getState().tab).toBe('conversation');
    await until(() => !!studio.getState().plan);
    expect(studio.getState().plan?.options).toMatchObject({ skill: 'refactor' });
    await user.click(screen.getByRole('button', { name: /^Run/ }));
    await until(() => kernel!.calls('run.start').length === 1);
    expect(kernel!.calls('run.start')[0]).toMatchObject({ options: { skill: 'refactor' } });
  });

  it('approves a changed server through the kernel when it offers mcp.status', async () => {
    const user = await openTools({
      'mcp.status': () => ({
        servers: [
          {
            server: 'evil',
            status: 'changed',
            version: '1.1.0',
            hash: 'abcdef0123456789abcdef',
            tools: 1,
            egress: ['api.example.com'],
            changes: ['run: description changed'],
          },
        ],
      }),
      'mcp.approve': () => ({ approved: true }),
    });
    const evil = screen.getByRole('article', { name: 'evil' });
    expect(within(evil).getByText('run: description changed')).toBeTruthy();
    expect(within(evil).getByText(/may reach api\.example\.com/)).toBeTruthy();
    await user.click(within(evil).getByRole('button', { name: 'Review and approve…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Approve MCP server evil?' });
    expect(within(dialog).getByText(/abcdef0123456789/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Approve this version' }));
    await until(() => kernel!.calls('mcp.approve').length === 1);
    expect(kernel!.calls('mcp.approve')[0]).toEqual({
      server: 'evil',
      hash: 'abcdef0123456789abcdef',
    });
    await until(() => studio.getState().announcement.text === 'MCP server evil approved');
  });

  it('shows what failed to load, keeps the rest, and refreshes', async () => {
    const user = await openTools({
      'extensions.list': () => {
        throw new Error('no extensions');
      },
      'tickets.show': () => {
        throw new Error('missing');
      },
    });
    expect(screen.getByText(/no extensions/)).toBeTruthy();
    expect(screen.getByRole('article', { name: 'gh' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open T-1' }));
    await until(() => studio.getState().logs.some((l) => l.message.includes('missing')));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await until(() => kernel!.calls('tools.list').length === 2);
  });

  it('says when nothing is configured', async () => {
    await openTools({
      'tools.list': () => ({ tools: [], errors: [] }),
      'extensions.list': () => ({ skills: [], agents: [], hooks: [], problems: [] }),
      'tickets.list': () => ({ tickets: [], problems: [] }),
    });
    expect(screen.getByText(/No MCP server is allowed/)).toBeTruthy();
    expect(screen.getByText('No skill or named agent in this workspace.')).toBeTruthy();
    expect(screen.getByText(/No ticket/)).toBeTruthy();
  });
});
