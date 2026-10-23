import type { Journal } from '@kernelpai/journal';
import { createToolBus } from '@kernelpai/tools';
import type { Confirm } from './confirm.js';
import { kpaiHome } from './env.js';
import type { Patch } from './patches.js';
import type { ApplyResult, KernelHost } from './types.js';

export interface ApplyContext {
  host: KernelHost;
  journal: Journal;
  confirm: Confirm;
  sessionId: string;
  runId: string;
  /** Approve the git.apply write without asking (separate from `yes`, review P2-F15). */
  yesApply?: boolean;
}

/**
 * Applies patches through the tool bus (`git.apply`: jailed, checked, forbidden zones of
 * `$KPAI_HOME/policy.json` included). Each write is confirmed with the exact patch unless
 * `yesApply`; the caller has already checked that the patches are critic-approved,
 * hidden-byte-free and that the run was not cancelled.
 */
export async function applyAll(c: ApplyContext, patches: Patch[]): Promise<ApplyResult[]> {
  const { bus } = await createToolBus({
    kpaiHome: kpaiHome(c.host.env),
    journal: c.journal,
    env: c.host.env,
  });
  try {
    const results: ApplyResult[] = [];
    for (const p of patches) {
      const r = await bus.call(
        { id: `apply-${p.nodeId}`, name: 'git.apply', input: { patch: p.patch } },
        {
          model: { provider: 'kernel', model: 'apply' },
          root: c.host.cwd,
          sessionId: c.sessionId,
          nodeId: p.nodeId,
          confirm: (question) =>
            c.yesApply
              ? Promise.resolve(true)
              : c.confirm({
                  kind: 'patch',
                  question,
                  patch: p.patch,
                  risk: 'write',
                  runId: c.runId,
                }),
        },
      );
      results.push({ nodeId: p.nodeId, ok: !r.isError, message: r.content.slice(0, 300) });
    }
    return results;
  } finally {
    await bus.close();
  }
}
