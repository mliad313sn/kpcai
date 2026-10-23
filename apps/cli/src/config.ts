import type { BudgetLimits, RoutingProfile } from '@kernelpai/core';
import type { Env } from '@kernelpai/providers';
import { confirmThreshold } from './context.js';

const PROFILES: readonly RoutingProfile[] = ['economy', 'balanced', 'performance'];

export interface Money {
  currency: string;
  /** Display units per USD. 1 for USD. */
  rate: number;
}

function nonNegative(env: Env, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return n;
}

export function routingProfile(env: Env, flag?: string): RoutingProfile {
  const raw = (flag ?? env['KPAI_PROFILE'] ?? 'balanced').trim();
  if (!PROFILES.includes(raw as RoutingProfile)) {
    throw new Error(`Profile must be one of ${PROFILES.join(', ')}, got "${raw}"`);
  }
  return raw as RoutingProfile;
}

/** Budget limits from env (USD). Unset limits are not enforced. */
export function budgetLimits(env: Env): BudgetLimits {
  const limits: BudgetLimits = { confirmAboveUsd: confirmThreshold(env) };
  const scopes = { task: 'TASK', session: 'SESSION', project: 'PROJECT', month: 'MONTH' } as const;
  for (const [scope, key] of Object.entries(scopes) as Array<[keyof typeof scopes, string]>) {
    const v = nonNegative(env, `KPAI_BUDGET_${key}_USD`);
    if (v !== undefined) limits[scope] = v;
  }
  return limits;
}

/**
 * Display currency. Amounts are stored in USD (ADR-0005); another currency needs an
 * explicit rate because exchange rates are facts KernelPAI must not invent.
 */
export function money(env: Env): Money {
  const currency = (env['KPAI_CURRENCY'] ?? 'USD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new Error(`KPAI_CURRENCY must be an ISO code, got "${currency}"`);
  if (currency === 'USD') return { currency, rate: 1 };
  const rate = nonNegative(env, 'KPAI_USD_RATE');
  if (!rate)
    throw new Error(`KPAI_CURRENCY=${currency} needs KPAI_USD_RATE (${currency} per 1 USD)`);
  return { currency, rate };
}

export function formatMoney(usd: number, m: Money): string {
  const v = usd * m.rate;
  const digits = v !== 0 && v < 0.01 ? Math.max(2, 1 - Math.floor(Math.log10(v))) : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(v);
}
