# ADR-0016 — Sessions, budget-checked fallbacks, stall timeouts, calibration

**Status:** Accepted (phase 1, after gate review F1/F3/F4/F5/F7) · **Date:** 2026-10-23

## Decision

- **Session** = consecutive runs in the same working directory until idle for `KPAI_SESSION_IDLE_MIN` minutes (default 30); `--new-session` forces a new one. Node ids are unique per run.
- **Every spend point is gated:** the first choice and each fallback go through the governor; a block stops the chain (journaled), `--over-budget` overrides (journaled), confirmation applies to fallbacks too.
- **Billing:** the event that closes an attempt (`response` or `error`) carries its cost, from reported usage, else from estimates of streamed text; nothing is billed for an attempt that produced nothing and reported nothing.
- **Stalls:** per attempt, no first output within 30 s or no new output for 60 s aborts that attempt as `unavailable` and falls back; a user cancel still stops the whole task.
- **Calibration:** typical output per provider/model/task type = median of the last 20 reported outputs (≥ 3 samples), used by router and executor estimates; `stats` reports cost, output and input estimate errors.

## Consequences

The < 15 % estimate target (spec §7) is now measurable but can only be measured on real traffic; it stays open until the Sponsor authorises live calls (Q-2).
