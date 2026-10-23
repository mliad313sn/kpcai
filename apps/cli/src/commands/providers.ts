import { formatUsd } from '@kernelpai/core';
import { Kernel } from '@kernelpai/kernel';
import { kernelHost } from '../host.js';
import type { Io } from '../io.js';

/** `kpai providers`: detected providers, their models and price sheet. */
export async function providersCommand(io: Io): Promise<number> {
  const kernel = new Kernel(kernelHost(io));
  for (const p of await kernel.providers()) {
    const mark = p.available ? 'ok ' : '-- ';
    io.out(`${mark} ${p.id.padEnd(10)} ${p.name} [${p.kind}, ${p.jurisdiction}] — ${p.reason}\n`);
    for (const m of p.models) {
      const price = `${formatUsd(m.price.inputPerMTok)}/${formatUsd(m.price.outputPerMTok)} per MTok`;
      io.out(`      ${p.id}/${m.id}  ctx ${m.contextWindow}  ${price}\n`);
    }
  }
  return 0;
}
