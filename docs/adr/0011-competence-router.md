# ADR-0011 — Competence router: filters, score, reason

**Status:** Accepted (phase 1) · **Date:** 2026-10-23 · Built by S3, accepted by the PO

## Decision

- **Filters, in order** (each rejection is kept with its reason): provider kind (`excludeKinds`, default `["test"]` so mocks are never routed to by accident), denied providers, denied models, diversity exclusion (`excludeProviders`), local only, allowed jurisdictions, required modalities (all), context window (estimated input + output cap must fit).
- **Score** (spec §5.3): `w1·static + w2·measured − w3·costPenalty − w4·latencyPenalty`.
  - Static competence: `card.competence[type]`, else 0.5 ± 0.25 for a declared strength/weakness.
  - Measured competence blended with static by confidence `n/(n+10)`; without samples it equals static.
  - Cost penalty: expected cost ÷ node budget, capped at 1; without a budget, relative to the most expensive survivor.
  - Latency penalty: typical latency ÷ node max latency, capped at 1; unknown latency is 0.5.
- **Profiles** (static/measured/cost/latency): economy 0.30/0.20/0.40/0.10, balanced 0.40/0.25/0.20/0.15 (default), performance 0.55/0.35/0.05/0.05.
- **Tie-break:** score (ε = 1e-9), then cheaper, then name — deterministic.
- **Reason:** one line naming the winner, score, expected cost, the runner-up and the decisive factor; journaled with `elapsedMs`.
- `maxLatencyMs` is a penalty, not a filter, in phase 1.

## Consequences

p95 0.87 ms for 1,000 candidates (target < 50 ms), so TypeScript stays (ADR-0001's Rust trigger not met). Priors come from descriptor YAML; phase 4 supplies `MeasuredCompetence` from outcomes.
