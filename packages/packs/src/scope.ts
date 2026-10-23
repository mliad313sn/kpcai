import { z } from 'zod';
import { ScopeKindSchema, type Pack } from './schema.js';

/**
 * The authorised scope a security pack needs before any node runs: what may be touched,
 * under which engagement, until when. Shown in the plan and journaled (WI-S1-03).
 */
export const AuthorisedScopeSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            kind: ScopeKindSchema,
            value: z.string().min(1).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    /** Contract, ticket, rules-of-engagement or CTF event reference. */
    engagementRef: z.string().min(3).max(200),
    /** Who authorised the work (person or organisation). */
    authorisedBy: z.string().min(2).max(200),
    /** ISO date or date-time; the scope is refused after it. */
    expires: z.iso.datetime({ offset: true }).or(z.iso.date()),
    notes: z.string().max(1000).optional(),
  })
  .strict();
export type AuthorisedScope = z.infer<typeof AuthorisedScopeSchema>;

/** Targets that would cover everyone: never an authorised scope. */
const UNBOUNDED = [
  /^\*$/,
  /^\*\.\*$/,
  /^0\.0\.0\.0(\/0)?$/,
  /^::\/0$/,
  /^\*\.[a-z]{2,}$/i, // *.com
  /^https?:\/\/\*/i,
];

function expiryOf(expires: string): number {
  // A bare date means "until the end of that day" in UTC.
  return /^\d{4}-\d{2}-\d{2}$/.test(expires)
    ? Date.parse(`${expires}T23:59:59.999Z`)
    : Date.parse(expires);
}

export const MAX_SCOPE_DAYS = 366;

/** Problems with a declared scope for this pack; empty when it may be used now. */
export function scopeProblems(pack: Pack, scope: unknown, now: Date = new Date()): string[] {
  if (!pack.safety.requiresScope) return [];
  const parsed = AuthorisedScopeSchema.safeParse(scope);
  if (!parsed.success) {
    return [`${pack.name} needs a declared authorised scope: ${z.prettifyError(parsed.error)}`];
  }
  const s = parsed.data;
  const out: string[] = [];
  const end = expiryOf(s.expires);
  if (end <= now.getTime()) out.push(`the scope expired on ${s.expires}`);
  if (end - now.getTime() > MAX_SCOPE_DAYS * 86_400_000) {
    out.push(`the scope runs more than ${MAX_SCOPE_DAYS} days; renew it per engagement`);
  }
  for (const t of s.targets) {
    if (UNBOUNDED.some((re) => re.test(t.value.trim()))) {
      out.push(`target "${t.value}" is unbounded; name the hosts, ranges or files in scope`);
    }
    if (!pack.safety.scopeKinds.includes(t.kind)) {
      out.push(
        `target kind "${t.kind}" is not used by ${pack.name} (${pack.safety.scopeKinds.join(', ')})`,
      );
    }
  }
  return out;
}

/** Lines for the plan view, so the scope is visible before anything runs. */
export function describeScope(scope: AuthorisedScope): string[] {
  return [
    `authorised scope: ${scope.engagementRef} (by ${scope.authorisedBy}, until ${scope.expires})`,
    ...scope.targets.map((t) => `  in scope: ${t.kind} ${t.value}`),
  ];
}

/** Journal payload for the scope (no free-text notes: they may hold client data). */
export function scopeJournalPayload(pack: Pack, scope: AuthorisedScope): Record<string, unknown> {
  return {
    pack: pack.id,
    engagementRef: scope.engagementRef,
    authorisedBy: scope.authorisedBy,
    expires: scope.expires,
    targets: scope.targets.map((t) => `${t.kind}:${t.value}`),
  };
}
