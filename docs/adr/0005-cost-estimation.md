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
