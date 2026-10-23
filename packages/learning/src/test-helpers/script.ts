/**
 * Scripted journals in the shapes the kernel, orchestrator, executor and tool bus write
 * (call/response with role tags, critic verdict JSON, shell.run and git.apply tool events,
 * run outcome, checkpoint, restore), so grading is tested against the real event shapes.
 */
import { Journal } from '@kernelpai/journal';

export const ref = (s: string): { provider: string; model: string } => {
  const [provider, model] = s.split('/') as [string, string];
  return { provider, model };
};

export const verdictText = (approve: boolean, major = !approve): string =>
  '```json\n' +
  JSON.stringify({
    approve,
    issues: major ? [{ severity: 'major', text: 'wrong' }] : [],
    summary: approve ? 'fine' : 'not fine',
  }) +
  '\n```';

export class Script {
  readonly j: Journal;
  sid: string;
  private n = 0;
  private t = Date.parse('2026-10-23T10:00:00Z');

  constructor(cwd = '/repo') {
    this.j = Journal.open(':memory:', { now: () => new Date((this.t += 1000)) });
    this.sid = this.j.startSession('scripted', cwd);
  }

  session(cwd = '/repo'): string {
    this.sid = this.j.startSession('scripted', cwd);
    return this.sid;
  }

  plan(nodes: Array<{ id: string; type: string }>, estimate: Record<string, unknown> = {}): void {
    this.j.append({
      sessionId: this.sid,
      type: 'routing',
      nodeId: 'g1',
      payload: { plan: { id: 'g1', nodes }, estimate },
    });
  }

  /** One model step: a `call` then its `response` (cost on the response). */
  answer(
    nodeId: string,
    model: string,
    role: string | undefined,
    text: string,
    o: { taskType?: string; costUsd?: number; stop?: string } = {},
  ): void {
    const requestId = `r${++this.n}`;
    const { provider, model: m } = ref(model);
    const tags = role ? { role } : {};
    const base = { sessionId: this.sid, nodeId, provider, model: m };
    this.j.append({
      ...base,
      type: 'call',
      payload: { ...tags, requestId, attempt: 0, taskType: o.taskType ?? 'code_generation' },
    });
    this.j.append({
      ...base,
      type: 'response',
      ...(o.costUsd !== undefined ? { costUsd: o.costUsd } : {}),
      payload: { ...tags, requestId, text, stopReason: o.stop ?? 'end', usageBasis: 'reported' },
    });
  }

  critic(nodeId: string, model: string, approve: boolean, major = !approve): void {
    this.answer(nodeId, model, 'critic', verdictText(approve, major), { taskType: 'critique' });
  }

  tool(nodeId: string, model: string, payload: Record<string, unknown>): void {
    const { provider, model: m } = ref(model);
    this.j.append({ sessionId: this.sid, type: 'tool', nodeId, provider, model: m, payload });
  }

  test(
    nodeId: string,
    model: string,
    exitCode: number | null,
    command = 'npx',
    args = ['vitest', 'run'],
  ): void {
    this.tool(nodeId, model, {
      tool: 'shell.run',
      decision: 'allow',
      isError: exitCode !== 0,
      input: { command, args },
      meta: { exitCode, timedOut: false, aborted: false },
    });
  }

  note(payload: Record<string, unknown>, nodeId?: string): void {
    this.j.append({
      sessionId: this.sid,
      type: 'intervention',
      ...(nodeId ? { nodeId } : {}),
      payload,
    });
  }

  outcome(runId: string, status = 'finished', cancelled = false): void {
    this.note({ action: 'run outcome', runId, status, cancelled });
  }

  /** A kernel write of a node's patch, after a checkpoint (as `applyAll` journals it). */
  apply(runId: string, nodeId: string, i: number, decision = 'confirmed', isError = false): string {
    const cp = `refs/kpai/checkpoints/${runId}/${++this.n}`;
    this.note({ action: 'checkpoint', runId, ref: cp, label: `before patch from ${nodeId}` });
    this.tool(`${nodeId}#patch-${i}`, 'kernel/apply', {
      tool: 'git.apply',
      decision,
      isError,
      input: { patch: { chars: 10, sha256: 'x' } },
    });
    return cp;
  }

  restore(runId: string, checkpoint: string): void {
    this.note({ action: 'restore', runId, ref: checkpoint, written: 1, deleted: 0, skipped: 0 });
  }

  /** A whole author+critic run of one node, ended by its outcome. */
  authorCritic(
    runId: string,
    o: { node?: string; type?: string; author: string; critic: string; approve: boolean },
  ): void {
    const node = o.node ?? 'n1';
    const type = o.type ?? 'test';
    this.plan([{ id: node, type }]);
    this.answer(node, o.author, 'author', `draft by ${o.author}`, { taskType: type });
    this.critic(node, o.critic, o.approve);
    this.outcome(runId);
  }
}
