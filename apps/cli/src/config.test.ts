import { describe, expect, it } from 'vitest';
import { budgetLimits, formatMoney, money, routingProfile } from './config.js';

describe('cli config', () => {
  it('reads the routing profile from flag, env or default', () => {
    expect(routingProfile({})).toBe('balanced');
    expect(routingProfile({ KPAI_PROFILE: 'economy' })).toBe('economy');
    expect(routingProfile({ KPAI_PROFILE: 'economy' }, 'performance')).toBe('performance');
    expect(() => routingProfile({}, 'cheap')).toThrow(/Profile must be one of/);
  });

  it('reads budget limits per scope', () => {
    expect(budgetLimits({})).toEqual({ confirmAboveUsd: 0.1 });
    expect(
      budgetLimits({
        KPAI_BUDGET_TASK_USD: '0.5',
        KPAI_BUDGET_MONTH_USD: '20',
        KPAI_CONFIRM_ABOVE_USD: '0',
      }),
    ).toEqual({ confirmAboveUsd: 0, task: 0.5, month: 20 });
    expect(() => budgetLimits({ KPAI_BUDGET_SESSION_USD: '-1' })).toThrow(/non-negative/);
  });

  it('needs an explicit rate for a non-USD display currency', () => {
    expect(money({})).toEqual({ currency: 'USD', rate: 1 });
    expect(() => money({ KPAI_CURRENCY: 'EUR' })).toThrow(/needs KPAI_USD_RATE/);
    expect(() => money({ KPAI_CURRENCY: 'euro' })).toThrow(/ISO code/);
    expect(money({ KPAI_CURRENCY: 'eur', KPAI_USD_RATE: '0.9' })).toEqual({
      currency: 'EUR',
      rate: 0.9,
    });
  });

  it('formats amounts, keeping two significant digits for tiny ones', () => {
    const eur = { currency: 'EUR', rate: 0.5 };
    expect(formatMoney(0.8, eur)).toBe('€0.40');
    expect(formatMoney(0, eur)).toBe('€0.00');
    expect(formatMoney(0.000042, { currency: 'USD', rate: 1 })).toBe('$0.000042');
  });
});
