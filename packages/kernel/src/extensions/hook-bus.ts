/**
 * Hooks outside a run's own bus (R-502, ADR-0033): `before-plan` (before any planner call)
 * and the zones a loaded bus enforces. A `before-plan` hook runs a program in the
 * workspace, so the workspace is guarded first, like a run's.
 */
import type { Journal } from '@kernelpai/journal';
import {
  DEFAULT_ZONES,
  createToolBus,
  zoneSetFromGlobs,
  type LocalToolBus,
  type PackZoneOptions,
  type ZoneSet,
} from '@kernelpai/tools';
import { guardWorkspace } from '../authorise.js';
import type { GateHost } from '../budget-gate.js';
import { KernelError } from '../errors.js';
import { policyFor } from '../packs.js';
import { runHooks } from './hook-run.js';
import type { LoadedHooks } from './hooks.js';

/** The forbidden zones a bus enforces (its graded policy's), else the defaults. */
export function busZones(bus: Pick<LocalToolBus, 'policy'>): ZoneSet {
  const own = (bus.policy as { zoneSet?: () => ZoneSet }).zoneSet?.();
  return own ?? zoneSetFromGlobs(DEFAULT_ZONES);
}

/**
 * Runs the `before-plan` hooks; throws `refused` on a veto (the plan is not made). The bus
 * has the policy of `$KPAI_HOME/policy.json`, the home zone and the packs' zones; no MCP
 * server is started for it.
 */
export async function beforePlan(
  host: GateHost,
  journal: Journal,
  sessionId: string,
  hooks: LoadedHooks,
  request: string,
  packs?: PackZoneOptions,
): Promise<void> {
  if (hooks.broken.length === 0 && !hooks.hooks.some((h) => h.event === 'before-plan')) return;
  await guardWorkspace(host.env, host.cwd, host.confirm);
  const { policy } = await policyFor(host.env, packs, undefined, host.cwd);
  const { bus } = await createToolBus({ policy, journal, env: host.env });
  try {
    const v = await runHooks(
      bus,
      hooks,
      'before-plan',
      { request },
      {
        root: host.cwd,
        sessionId,
        nodeId: 'planner',
        env: host.env,
        confirm: (question) =>
          host.confirm({ kind: 'tool', question, risk: 'destructive', inWorktree: false }),
      },
    );
    if (v.ok) return;
    const reason = v.reason ?? 'vetoed by a hook';
    journal.append({
      sessionId,
      type: 'intervention',
      payload: { action: 'plan vetoed by hook', reason },
    });
    throw new KernelError('refused', `plan ${reason}`);
  } finally {
    await bus.close();
  }
}
