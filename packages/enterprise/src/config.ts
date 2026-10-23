/**
 * The portfolio's settings, `$KPAI_HOME/enterprise/portfolio.json` (strict: an unknown key
 * is an error, so a typo never silently drops a limit). Defaults are small on purpose: two
 * workers, a $25 portfolio cap and a $5/hour spend-rate cap (S10 R3); the heartbeat every
 * 60 s is stale after three missed beats (S10 R2).
 */
import {
  PortfolioSchema,
  WATCH_DEFAULTS,
  type Portfolio,
  type WatchThresholds,
} from '@kernelpai/program';
import { z } from 'zod';

export const EnterpriseConfigSchema = z.strictObject({
  portfolio: PortfolioSchema,
  /** S10 R3: band tops started plus costs settled in the last hour, whole portfolio. */
  usdPerHour: z.number().finite().positive().optional(),
  heartbeatSec: z.number().int().min(1).max(3_600),
  /** How often the daemon looks for work, in milliseconds. */
  tickMs: z.number().int().min(50).max(60_000),
  /** How long a run waits for the Sponsor's answer to one of its questions. */
  confirmWaitMinutes: z
    .number()
    .min(0.01)
    .max(7 * 24 * 60),
  watch: z
    .strictObject({
      programStallMinutes: z.number().positive(),
      runStallMinutes: z.number().positive(),
      askHours: z.number().positive(),
      reportOverdueFactor: z.number().positive(),
      queueBlockedMinutes: z.number().positive(),
    })
    .partial()
    .default({}),
});
export type EnterpriseConfig = z.infer<typeof EnterpriseConfigSchema>;
export type ConfigInput = z.input<typeof EnterpriseConfigSchema>;

export const DEFAULT_CONFIG: EnterpriseConfig = {
  portfolio: PortfolioSchema.parse({
    id: 'default',
    capUsd: 25,
    limits: { total: 2, perProgram: 2, defaultPerProvider: 2 },
  }),
  usdPerHour: 5,
  heartbeatSec: 60,
  tickMs: 2_000,
  confirmWaitMinutes: 60,
  watch: {},
};

/** The file's settings over the defaults; a file that does not parse is an error. */
export function configFrom(raw: unknown): EnterpriseConfig {
  const given = (raw ?? {}) as Partial<ConfigInput>;
  const portfolio = { ...DEFAULT_CONFIG.portfolio, ...(given.portfolio ?? {}) } as Portfolio;
  return EnterpriseConfigSchema.parse({ ...DEFAULT_CONFIG, ...given, portfolio });
}

export function thresholds(c: EnterpriseConfig): WatchThresholds {
  return { ...WATCH_DEFAULTS, ...c.watch };
}

/** Seconds after which a heartbeat is stale: three missed beats. */
export function staleAfterSec(c: EnterpriseConfig): number {
  return c.heartbeatSec * 3;
}
