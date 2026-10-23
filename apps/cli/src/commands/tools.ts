import { createToolBus } from '@kernelpai/tools';
import { kpaiHome } from '../context.js';
import type { Io } from '../io.js';

/** `kpai tools`: every tool models can be given, its risk and where it comes from. */
export async function toolsCommand(io: Io): Promise<number> {
  const { bus, mcpErrors } = await createToolBus({ kpaiHome: kpaiHome(io.env), env: io.env });
  try {
    for (const t of bus.list()) {
      io.out(
        `${t.name.padEnd(28)} ${t.risk.padEnd(12)} ${t.source.padEnd(14)} ${t.description.split('\n')[0]?.slice(0, 80) ?? ''}\n`,
      );
    }
    for (const e of mcpErrors) io.err(`mcp ${e.server}: ${e.message}\n`);
    return 0;
  } finally {
    await bus.close();
  }
}
