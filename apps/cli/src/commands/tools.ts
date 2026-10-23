import { Kernel } from '@kernelpai/kernel';
import { kernelHost } from '../host.js';
import type { Io } from '../io.js';

/** `kpai tools`: every tool models can be given, its risk and where it comes from. */
export async function toolsCommand(io: Io): Promise<number> {
  const { tools, errors } = await new Kernel(kernelHost(io)).tools();
  for (const t of tools) {
    io.out(
      `${t.name.padEnd(28)} ${t.risk.padEnd(12)} ${t.source.padEnd(14)} ${t.description.split('\n')[0]?.slice(0, 80) ?? ''}\n`,
    );
  }
  for (const e of errors) io.err(`mcp ${e.server}: ${e.message}\n`);
  return 0;
}
