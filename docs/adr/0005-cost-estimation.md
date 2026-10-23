# ADR-0005 — Cost estimation and currency

**Status:** Accepted (phase 0) · **Date:** 2026-10-23

## Context

Principle 6: estimate before running, confirm above a threshold. Exact token counts need provider tokenizers or count endpoints (network on the critical path).

## Decision

- Phase 0 estimate is local and instant: input ≈ characters / 4 + 4 tokens per message; output cap = request cap (default 16 000) clipped to the model's `maxOutput`.
- Two numbers: **max** (full output cap) and **expected** (a quarter of the cap, minimum 256 tokens). The confirmation threshold compares the _expected_ cost; both are shown.
- Real cost is computed from the provider-reported usage and the descriptor price. A cancelled call with no reported usage is billed from estimates and marked `usageBasis: estimated` — never shown as free.
- Amounts are stored in **USD** (providers price in USD). Display currency (the spec's € example) becomes a configurable rate in phase 1.

## Consequences

The heuristic can be off by tens of percent on code-heavy prompts; phase 1 measures the estimate/real gap (target < 15 %) and calibrates per model, using `count_tokens` where available.

## Revisit when

Phase 1 budget governor.

## Addendum (phase 3, 2026-10-23): estimate band, calibrated by role

Accepted by the PO; implemented by S3 in `packages/orchestrator/src/band.ts` and
`band-history.ts`. Since D-021 / ADR-0026 the band's top is the approved cap, so the band must
contain real costs.

- Every step, node and graph estimate carries `expected` and a band `low ≤ expected ≤ high`
  (tested invariant).
- Calibrated from the journal: output by role (fallback: model and task type) with 5–95 %
  quantiles; the text a step reads (dependency outputs, the author's work for a critic or judge)
  from the producing step's learned range instead of a fixed 4,000 tokens; tool rounds per step;
  the reported/estimated input ratio per model.
- Cold start (`basis: heuristic`): output from 1 % to 2× expected, input 0.8–1.25×, up to one
  extra tool round; a step without full history has its high capped at 3× its expected cost.
- Measured on a deterministic mock benchmark run in CI: calibrated hit rate 89 % (was 29 %),
  cold start 3/3, cold-start median high ÷ expected 2.98. Cold-start factors come from mock runs
  and must be re-checked on live traffic (Q-2).
