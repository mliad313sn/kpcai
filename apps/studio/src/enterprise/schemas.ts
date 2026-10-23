/**
 * Enterprise protocol types for the console, from the kernel's protocol module (S1:
 * packages/kernel/src/protocol-enterprise.ts, design §14, ADR-0035). The RPC client already
 * validates every `enterprise.*` notification and method result against these schemas;
 * the store validates again (`parseNotice`) so it never trusts a caller.
 *
 * Every string may be model or repository text (goals, questions, seat titles): the view
 * renders it as text, quoted, never as markup.
 */
import {
  AssuranceLabelSchema,
  EnterpriseNotifications,
  type EnterpriseSnapshot,
} from '@kernelpai/kernel/protocol';
import type { z } from 'zod';

export type { EnterpriseSnapshot };
export type NoticeName = keyof typeof EnterpriseNotifications;
export type Notice<N extends NoticeName> = z.infer<(typeof EnterpriseNotifications)[N]>;
export type AnyNotice = { [N in NoticeName]: { name: N; params: Notice<N> } }[NoticeName];

export type SeatView = EnterpriseSnapshot['seats'][number];
export type SeatState = SeatView['state'];
export type Source = NonNullable<SeatView['source']>;
export type Gauge = EnterpriseSnapshot['gauges'][number];
export type ProgramCard = EnterpriseSnapshot['programs'][number];
export type InboxItem = EnterpriseSnapshot['inbox'][number];
export type EvidenceRef = InboxItem['evidence'][number];
export type ReportEntry = NonNullable<EnterpriseSnapshot['reports']>[number];
export type ResultEntry = NonNullable<EnterpriseSnapshot['results']>[number];
export type QueueEntry = NonNullable<EnterpriseSnapshot['queue']>[number];
export type Heartbeat = NonNullable<EnterpriseSnapshot['heartbeat']>;
export type Health = ProgramCard['health'];
export type Assurance = z.infer<typeof AssuranceLabelSchema>;
export type WpState = Notice<'enterprise.wp'>['state'];
export type Activity = Notice<'enterprise.activity'>;

export const ASSURANCE_LABELS: readonly Assurance[] = AssuranceLabelSchema.options;

export function isNoticeName(name: string): name is NoticeName {
  return Object.hasOwn(EnterpriseNotifications, name);
}

/** Validates one notification; undefined when the name is unknown or the params invalid. */
export function parseNotice(name: string, params: unknown): AnyNotice | undefined {
  if (!isNoticeName(name)) return undefined;
  const r = EnterpriseNotifications[name].safeParse(params);
  return r.success ? ({ name, params: r.data } as AnyNotice) : undefined;
}
