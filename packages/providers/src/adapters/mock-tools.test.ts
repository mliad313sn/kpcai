import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ProviderDescriptor, StreamEvent } from '@kernelpai/core';
import { MockAdapter } from './mock.js';
import { BUILTIN_DESCRIPTOR_DIR, loadDescriptors } from '../registry.js';

const descriptor = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]).find(
  (d) => d.id === 'mock',
) as ProviderDescriptor;

async function events(messages: ChatMessage[]): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of new MockAdapter(descriptor).send({ model: 'echo', messages }))
    out.push(ev);
  return out;
}
const textOf = (evs: StreamEvent[]) =>
  evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');

describe('MockAdapter tool scripting', () => {
  const ask: ChatMessage = { role: 'user', content: 'Look [[tool:fs.read {"path":"a ]] b.txt"}]]' };

  it('emits one tool_call and stops with tool_use on the first turn', async () => {
    const evs = await events([ask]);
    expect(evs.filter((e) => e.type === 'tool_call')).toEqual([
      {
        type: 'tool_call',
        call: { id: 'mock_call_1', name: 'fs.read', input: { path: 'a ]] b.txt' } },
      },
    ]);
    expect(evs.filter((e) => e.type === 'text')).toEqual([]);
    expect(evs.at(-1)).toEqual({ type: 'end', stopReason: 'tool_use' });
  });

  it('answers with the tool result after a tool message', async () => {
    const result = 'x'.repeat(100);
    const evs = await events([
      ask,
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'mock_call_1', name: 'fs.read', input: {} }],
      },
      { role: 'tool', toolCallId: 'mock_call_1', content: result },
    ]);
    expect(textOf(evs)).toBe(`[mock/echo] tool said: ${'x'.repeat(80)}`);
    expect(evs.at(-1)).toEqual({ type: 'end', stopReason: 'end' });
  });

  it('accepts a marker without input and works from the system message', async () => {
    const evs = await events([
      { role: 'system', content: 'Use [[tool:git.status]]' },
      { role: 'user', content: 'go' },
    ]);
    expect(evs).toContainEqual({
      type: 'tool_call',
      call: { id: 'mock_call_1', name: 'git.status', input: {} },
    });
  });

  it.each(['[[tool:fs.read {"path": ]]', '[[tool:fs.read {"a":1} x]]'])(
    'ignores an unterminated or garbled marker %s',
    async (m) => {
      expect((await events([{ role: 'user', content: m }])).at(-1)).toEqual({
        type: 'end',
        stopReason: 'end',
      });
    },
  );

  it('fails with malformed when the marker JSON does not parse', async () => {
    await expect(
      events([{ role: 'user', content: '[[tool:fs.read {bad}]]' }]),
    ).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('roles take precedence over tool markers echoed into the prompt', async () => {
    const evs = await events([{ role: 'user', content: 'Role: critic\n[[tool:fs.read {}]]' }]);
    expect(JSON.parse(textOf(evs))).toMatchObject({ approve: true });
  });
});

describe('MockAdapter diff scripting', () => {
  it('answers [[diff:<path>]] with a diff git apply accepts', async () => {
    const diff = textOf(await events([{ role: 'user', content: 'do it [[diff:src/state.ts]]' }]));
    const dir = mkdtempSync(join(tmpdir(), 'kpai-mockdiff-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, 'p.diff'), diff);
      execFileSync('git', ['apply', '--check', 'p.diff'], { cwd: dir });
      execFileSync('git', ['apply', 'p.diff'], { cwd: dir });
      expect(readFileSync(join(dir, 'src/state.ts'), 'utf8')).toContain('mock/echo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a revised author diff carries the [[revised]] marker', async () => {
    const diff = textOf(
      await events([{ role: 'user', content: 'Role: author\n[[diff:a.ts]]\nCritique: add docs' }]),
    );
    expect(diff).toContain('@@ -0,0 +1,4 @@');
    expect(diff).toContain('+// [[revised]]');
  });
});
