import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '@kernelpai/journal';
import { describe, expect, it } from 'vitest';
import { main } from './main.js';
import { fakeIo } from './test-helpers/fake-io.js';

const SERVER = fileURLToPath(
  new URL('../../../packages/tools/src/test-helpers/mcp-pinned-server.mjs', import.meta.url),
);

function configure(home: string, env: Record<string, string> = {}): void {
  const servers = { p: { command: process.execPath, args: [SERVER], env, egress: ['127.0.0.1'] } };
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({ servers }));
}

describe('kpai mcp', () => {
  it('lists, approves after a confirmation (journaled), blocks a change, removes', async () => {
    const io = fakeIo();
    configure(io.home);
    expect(await main(['mcp', 'list'], io)).toBe(1);
    expect(io.stdout).toMatch(
      /^p\s+unapproved\s+v1\.0\.0\s+[0-9a-f]{12}\s+3 tool\(s\)\s+egress: 127\.0\.0\.1/,
    );
    io.confirmAnswers.push(false);
    expect(await main(['mcp', 'approve', 'p'], io)).toBe(1);
    expect(io.stderr).toMatch(/stays blocked/);
    io.confirmAnswers.push(true);
    expect(await main(['mcp', 'approve', 'p'], io)).toBe(0);
    expect(io.questions[1]).toMatch(/Approve MCP server "p"[\s\S]*echo: Echo the text back/);
    io.stdout = '';
    expect(await main(['mcp', 'list'], io)).toBe(0);
    expect(io.stdout).toMatch(/^p\s+approved/);
    configure(io.home, { KPAI_FAKE_ECHO_DESC: 'changed text' });
    io.stdout = '';
    expect(await main(['mcp', 'list'], io)).toBe(1);
    expect(io.stdout).toMatch(
      /changed[\s\S]*- the description of tool "echo" changed[\s\S]*is blocked/,
    );
    const j = Journal.open(join(io.home, 'journal.db'));
    const actions = j
      .events()
      .filter((e) => e.type === 'intervention')
      .map((e) => e.payload['action']);
    j.close();
    expect(actions).toEqual(['mcp approval declined', 'mcp approved']);
    expect(await main(['mcp', 'remove', 'p'], io)).toBe(0);
    expect(await main(['mcp', 'remove', 'p'], io)).toBe(1);
    io.stdout = '';
    expect(await main(['mcp', 'list'], io)).toBe(0);
    expect(io.stdout).toMatch(/no MCP server/);
  }, 60_000);

  it('prints usage for anything else', async () => {
    const io = fakeIo();
    expect(await main(['mcp'], io)).toBe(2);
    expect(await main(['mcp', 'approve'], io)).toBe(2);
    expect(io.stderr).toMatch(/kpai mcp approve <server>/);
  });
});
