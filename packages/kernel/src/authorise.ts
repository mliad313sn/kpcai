/** Run-start checks of D-020: the workspace (with pack opt-in) and the authorised scope. */
import type { Journal } from '@kernelpai/journal';
import type { Confirm } from './confirm.js';
import type { Env } from './env.js';
import { KernelError } from './errors.js';
import {
  folderKey,
  readZoneDecisions,
  relaxKey,
  saveZoneDecisions,
  type SelectedPacks,
} from './packs.js';
import { SCOPE_FILE } from './scope.js';
import type { Plan } from './types.js';
import { saveOptIns, workspaceVerdict } from './workspace.js';

/**
 * WI-S1-01: refuses a folder that is not a workspace. When only opt-in pack files (a lone
 * binary, a capture) were found, asks the human once and remembers a yes.
 */
export async function guardWorkspace(env: Env, cwd: string, confirm: Confirm): Promise<void> {
  const v = await workspaceVerdict(cwd, env);
  if (v.ok) return;
  if (v.askOptIn.length > 0) {
    const question = `Only files that need your opt-in were found in ${cwd} (packs: ${v.askOptIn.join(', ')}). Treat this folder as a workspace for them from now on?`;
    if (await confirm({ kind: 'tool', question, risk: 'read' })) {
      await saveOptIns(env, cwd, v.askOptIn);
      return;
    }
  }
  throw new KernelError('workspace', v.problem ?? 'not a workspace');
}

/**
 * WI-S1-03: the scope to hand to the runner, which validates it again and journals its
 * acceptance or refusal (S4). The kernel refuses early, before any budget question or
 * worktree, when the plan's check already fails; that refusal is journaled here once,
 * since the runner is then never reached. A scope from the repository file is used only
 * after the human confirms it.
 */
export async function gatherScope(journal: Journal, confirm: Confirm, p: Plan): Promise<unknown> {
  const s = p.scope;
  if (s.required.length === 0 && s.problems.length === 0) return undefined;
  const refuse = (why: string): never => {
    const payload = {
      action: 'run refused',
      reason: 'authorised scope',
      packs: s.required,
      problems: [why],
    };
    journal.append({ sessionId: p.sessionId, type: 'intervention', payload });
    throw new KernelError('refused', `authorised scope needed: ${why}`);
  };
  if (s.problems.length > 0) refuse(s.problems.join('; '));
  if (s.source === 'file') {
    const question = `Use the authorised scope declared in ${SCOPE_FILE} (a repository file) for this run?\n${s.lines.join('\n')}`;
    if (!(await confirm({ kind: 'tool', question, risk: 'write' })))
      refuse(`the scope in ${SCOPE_FILE} was not confirmed`);
  }
  return s.scope;
}

/**
 * Pack zone relaxations waiting for approval are asked once each (D-020, S7): the answer
 * is stored as a `relaxKey` for this folder, a no is not asked again. Only the name
 * heuristics can be relaxed; S7's bus journals each relaxation before it applies.
 */
export async function askZoneRelaxations(
  env: Env,
  cwd: string,
  confirm: Confirm,
  packs: SelectedPacks,
): Promise<SelectedPacks> {
  if (packs.pending.length === 0) return packs;
  const { declined } = await readZoneDecisions(env, await folderKey(cwd));
  const answers: Array<{ key: string; approved: boolean }> = [];
  for (const r of packs.pending) {
    const key = relaxKey(r.pack, r.allow);
    if (declined.includes(key)) continue;
    const question = `Pack ${r.pack} asks to exempt ${r.allow} from the name heuristics (*secret*, credentials*): ${r.reason}. Credential files stay forbidden. Allow it in this folder?`;
    answers.push({ key, approved: await confirm({ kind: 'tool', question, risk: 'read' }) });
  }
  if (answers.length === 0) return packs;
  await saveZoneDecisions(env, cwd, answers);
  const yes = new Set(answers.filter((a) => a.approved).map((a) => a.key));
  const isYes = (r: { pack: string; allow: string }): boolean => yes.has(relaxKey(r.pack, r.allow));
  return {
    ...packs,
    approved: [...packs.approved, ...yes],
    relaxed: [...packs.relaxed, ...packs.pending.filter(isYes)],
    pending: packs.pending.filter((r) => !isYes(r)),
  };
}
