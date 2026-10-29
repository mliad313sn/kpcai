/**
 * What the Sponsor does (design §14.1, ADR-0035): approve a charter by its hash, pause,
 * resume, stop, open evidence, answer questions. The host stamps the actor `sponsor`; the
 * request never says who it is. S10 R8: a consequential question is answered alone and only
 * after its evidence was opened; trivial ones may go in a batch. Each answer is journaled
 * with its ask and answer times and whether the evidence was viewed (S10 R6 J2, B-28).
 */
import { KernelError } from '@kernelpai/kernel';
import { answerBlocker, approvalClass } from '@kernelpai/program';
import type { Ctx } from './context.js';
import { guardRuns } from './guard.js';
import type { ProgramMeta, Ref } from './meta.js';

function must(ok: boolean, code: 'refused' | 'not_found', message: string): void {
  if (!ok) throw new KernelError(code, message);
}

export class Sponsor {
  constructor(private readonly c: Ctx) {}

  private exists(id: string): void {
    must(this.c.store.has(id), 'not_found', `no program ${id.slice(0, 80)}`);
  }

  /** One Sponsor event through the machine; a refusal is an error the client sees. */
  async act(id: string, event: Record<string, unknown>): Promise<void> {
    this.exists(id);
    const now = this.c.clock();
    const t = await this.c.store.apply(id, event, 'sponsor', now);
    must(t.ok, 'refused', t.ok ? '' : t.reason);
    this.c.fact(id, { action: `sponsor ${String(event['type'])}`, programId: id });
    this.c.feed.notify('enterprise.program', { programId: id, status: t.ok ? t.state.status : '' });
    this.c.feed.line(`the Sponsor: ${String(event['type'])}`, id, [], now);
    guardRuns(this.c);
  }

  /**
   * Stop also cancels the program's live runs; the program stays readable. Here at once for
   * this process's runs; a daemon in another process cancels its own on its next guard
   * check (P5-F1). A pause pauses them the same way (`act`).
   */
  async stop(id: string, reason: string): Promise<void> {
    await this.act(id, { type: 'stop', reason });
  }

  /** The Sponsor opened evidence: a run, a diff, a report, an escalation's evidence. */
  async viewed(id: string, ref: Ref, escalationId?: string): Promise<void> {
    this.exists(id);
    const now = this.c.clock();
    await this.c.store.locked(() => {
      const { state } = this.c.store.read(id);
      if (escalationId)
        must(
          state.escalations.some((e) => e.id === escalationId),
          'not_found',
          `no question ${escalationId}`,
        );
      if (ref.kind === 'run')
        must(
          state.runs.some((r) => r.runId === ref.id),
          'not_found',
          `no run ${ref.id} in ${id}`,
        );
      this.c.store.updateMeta(id, (m) => {
        m.viewed.push({ ref, ...(escalationId ? { escalationId } : {}), at: now.toISOString() });
      });
    });
    this.c.fact(id, {
      action: 'evidence viewed',
      programId: id,
      ref,
      escalationId,
      at: now.toISOString(),
    });
  }

  /**
   * Why a run's question cannot be answered now (P5-R1, D-035): a paused program keeps it
   * (pause is resumable) but takes no answer until it runs again; a stop or the kill switch
   * ends it (the run guard expires it, this covers the moment before the guard acts).
   */
  private held(m: ProgramMeta['escalations'][string] | undefined, status: string): string | false {
    if (m?.expired) return 'expired';
    if (m?.kind !== 'confirm') return false;
    if (status === 'paused') return 'waits: the program is paused, answer after it resumes';
    if (status === 'stopped' || status === 'delivered') return `ended: the program is ${status}`;
    if (this.c.store.config().portfolio.killSwitch) return 'ended: the kill switch is on';
    return false;
  }

  async answer(
    id: string,
    escalationId: string,
    answer: 'yes' | 'no',
    batch = false,
  ): Promise<void> {
    this.exists(id);
    const now = this.c.clock();
    const record = await this.c.store.locked(() => {
      const { state, meta } = this.c.store.read(id);
      const e = state.escalations.find((x) => x.id === escalationId);
      must(!!e && !e.answer, 'not_found', `no open question ${escalationId}`);
      const held = this.held(meta.escalations[escalationId], state.status);
      must(!held, 'refused', `question ${escalationId} ${held || ''}`);
      const seen = meta.viewed.filter((v) => v.escalationId === escalationId).at(-1);
      const why = answerBlocker(e!, { viewed: !!seen, batch });
      must(!why, 'refused', `${escalationId}: ${why ?? ''}`);
      const event = { type: 'answer', id: escalationId, answer };
      const t = this.c.store.applyLocked(id, event, 'sponsor', now);
      must(t.ok, 'refused', t.ok ? '' : t.reason);
      const rec = {
        escalationId,
        rule: e!.rule,
        answer,
        askedAt: e!.at,
        answeredAt: now.toISOString(),
        viewed: !!seen,
        ...(seen ? { viewedAt: seen.at } : {}),
        ...(batch ? { batch: true } : {}),
      };
      this.c.store.updateMeta(id, (m) => void m.answers.push(rec));
      return rec;
    });
    this.c.fact(id, {
      action: 'sponsor answer',
      programId: id,
      ...record,
      class: approvalClass(record),
    });
    this.c.feed.notify('enterprise.inbox', { programId: id, escalationId, state: 'answered' });
    this.c.feed.line(
      `the Sponsor answered ${answer} (${record.rule})`,
      id,
      [{ kind: 'escalation', id: escalationId }],
      now,
    );
  }

  /** Trivial questions in one go; consequential ones are refused, each with its reason. */
  async answerBatch(id: string, ids: string[], answer: 'yes' | 'no') {
    const answered: string[] = [];
    const refused: Array<{ escalationId: string; reason: string }> = [];
    for (const escalationId of ids) {
      try {
        await this.answer(id, escalationId, answer, true);
        answered.push(escalationId);
      } catch (err) {
        refused.push({ escalationId, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { answered, refused };
  }
}
