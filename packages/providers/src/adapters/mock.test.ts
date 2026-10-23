import { describe, expect, it } from 'vitest';
import type { ProviderDescriptor, StreamEvent } from '@kernelpai/core';
import { MockAdapter } from './mock.js';
import { BUILTIN_DESCRIPTOR_DIR, loadDescriptors } from '../registry.js';

const descriptor = loadDescriptors([BUILTIN_DESCRIPTOR_DIR]).find(
  (d) => d.id === 'mock',
) as ProviderDescriptor;

async function collect(a: MockAdapter, content: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of a.send({ model: 'echo', messages: [{ role: 'user', content }] }))
    out.push(ev);
  return out;
}

describe('MockAdapter', () => {
  it('echoes deterministically', async () => {
    const a = new MockAdapter(descriptor);
    expect(await a.detect()).toMatchObject({ available: true });
    const text = (await collect(a, 'ping'))
      .flatMap((e) => (e.type === 'text' ? [e.delta] : []))
      .join('');
    expect(text).toBe('[mock/echo] You asked: ping');
  });

  it('simulates failures from the prompt or from configuration', async () => {
    const a = new MockAdapter(descriptor);
    await expect(collect(a, 'x [[fail:unavailable]]')).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(await collect(a, 'x [[fail:unavailable@other]]')).toContainEqual({
      type: 'end',
      stopReason: 'end',
    });
    await expect(collect(a, 'x [[fail:refusal@mock]]')).rejects.toMatchObject({ kind: 'refusal' });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const ev of a.send({
          model: 'echo',
          messages: [{ role: 'user', content: 'a b c d [[midfail:malformed@mock]]' }],
        }))
          if (ev.type === 'text') seen.push(ev.delta);
      })(),
    ).rejects.toMatchObject({ kind: 'malformed' });
    expect(seen.length).toBeGreaterThan(0);
    a.behaviour = { failWith: 'rate_limit' };
    await expect(collect(a, 'x')).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('can be slowed down and cancelled', async () => {
    const a = new MockAdapter(descriptor);
    a.behaviour = { delayMs: 20 };
    const run = (async () => {
      for await (const ev of a.send(
        { model: 'echo', messages: [{ role: 'user', content: 'a b c d' }] },
        { requestId: 'm' },
      ))
        if (ev.type === 'text') a.cancel('m');
    })();
    await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
