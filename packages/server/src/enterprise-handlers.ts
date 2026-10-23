/**
 * Protocol handlers for Enterprise mode (`program.*`, `enterprise.*`; design §14, ADR-0035).
 * The local user holding the server token is the Sponsor: every answer, approval and pause
 * from a client is stamped `sponsor` by the runtime, never read from the request.
 */
import type { EnterpriseRuntime } from '@kernelpai/enterprise';
import { EnterpriseMethods, ErrorCodes, type MethodName } from '@kernelpai/kernel/protocol';
import type { Handlers } from './handlers.js';
import { RpcError } from './handlers.js';

export type EnterpriseMethod = Extract<MethodName, `program.${string}` | `enterprise.${string}`>;
type H = Pick<Handlers, EnterpriseMethod>;
const OK = { ok: true } as const;

function programHandlers(
  rt: EnterpriseRuntime,
): Pick<H, Extract<EnterpriseMethod, `program.${string}`>> {
  const s = rt.sponsor;
  return {
    'program.create': (p) => rt.create(p),
    'program.list': () => ({ programs: rt.list() }),
    'program.get': (p) => rt.get(p.programId),
    'program.approve': async (p) => (
      await s.act(p.programId, { type: 'approve', charterHash: p.charterHash }),
      OK
    ),
    'program.reject': async (p) => (
      await s.act(p.programId, { type: 'reject', reason: p.reason }),
      OK
    ),
    'program.pause': async (p) => (await s.act(p.programId, { type: 'pause' }), OK),
    'program.resume': async (p) => (await s.act(p.programId, { type: 'resume' }), OK),
    'program.stop': async (p) => (
      await s.stop(p.programId, p.reason ?? 'stopped by the Sponsor'),
      OK
    ),
    'program.answer': async (p) => (await s.answer(p.programId, p.escalationId, p.answer), OK),
    'program.answerBatch': (p) => s.answerBatch(p.programId, p.escalationIds, p.answer),
    'program.viewed': async (p) => (await s.viewed(p.programId, p.ref, p.escalationId), OK),
    'program.reports': (p) => ({ reports: rt.reports(p.programId, p.since) }),
  };
}

export function enterpriseHandlers(rt: EnterpriseRuntime | undefined): H {
  if (!rt) {
    const off = (): never => {
      throw new RpcError(ErrorCodes.unsupported, 'Enterprise mode is not enabled on this server');
    };
    return Object.fromEntries(Object.keys(EnterpriseMethods).map((m) => [m, off])) as unknown as H;
  }
  return {
    ...programHandlers(rt),
    'enterprise.snapshot': () => rt.snapshot(),
    'enterprise.activity': (p) => rt.activity(p?.since ?? 0, p?.limit ?? 200),
    'enterprise.heartbeat': () => rt.heartbeat(),
    'enterprise.kill': async () => ({ cancelled: await rt.daemon.kill(true) }),
    'enterprise.unkill': async () => ({ cancelled: await rt.daemon.kill(false) }),
  };
}
