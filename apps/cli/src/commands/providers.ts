import { formatUsd } from '@kernelpai/core';
import { buildRegistry } from '../context.js';
import type { Io } from '../io.js';

/** `kpai providers`: detected providers, their models and price sheet. */
export async function providersCommand(io: Io): Promise<number> {
  const registry = buildRegistry(io.env);
  const adapters = registry.list();
  const detections = await Promise.all(adapters.map((a) => a.detect()));
  adapters.forEach((a, i) => {
    const d = a.descriptor;
    const det = detections[i];
    const mark = det?.available ? 'ok ' : '-- ';
    io.out(
      `${mark} ${d.id.padEnd(10)} ${d.name} [${d.kind}, ${d.jurisdiction}] — ${det?.reason ?? ''}\n`,
    );
    for (const m of a.capabilities()) {
      const price = `${formatUsd(m.price.inputPerMTok)}/${formatUsd(m.price.outputPerMTok)} per MTok`;
      io.out(`      ${d.id}/${m.id}  ctx ${m.contextWindow}  ${price}\n`);
    }
  });
  return 0;
}
