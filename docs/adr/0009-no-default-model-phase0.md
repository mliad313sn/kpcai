# ADR-0009 — No default model and a budget gate in phase 0

**Status:** Accepted (phase 0) · **Date:** 2026-10-23

## Context

Principle 1 forbids routing "because it's the default", but the competence router is phase 1. Principle 6 requires confirmation above a threshold, but the governor is phase 1.

## Decision

- `kpai ask` requires `-m provider/model`. Without it, it refuses (exit 2) and says why. The journal records the routing reason "explicit user choice".
- A minimal gate already applies: if the expected cost exceeds `KPAI_CONFIRM_ABOVE_USD` (default $0.10), the CLI asks; non-interactive runs decline unless `--yes`. A decline is journaled as an `intervention` (exit 4).
- Ctrl+C cancels the in-flight call through `adapter.cancel(id)`, keeps the partial answer, journals the intervention (exit 130).

## Consequences

Phase 0 already honours principles 1, 3 (in the CLI's footer), 4 and 6 in their simplest form; phase 1 replaces `-m` as the only option with `kpai run`.
