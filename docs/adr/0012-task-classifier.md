# ADR-0012 — Heuristic task classifier

**Status:** Accepted (phase 1) · **Date:** 2026-10-23 · Built by S4, accepted by the PO

## Context

The router needs a task type per node. Options: an LLM call (cost, latency, network on the critical path), a local classifier model such as Arch-Router-1.5B (licence not cleared, charter §5), or transparent rules.

## Decision

- Phase 1 uses transparent EN + FR keyword rules (24 rules over the 7 types), accent-insensitive, weighted, with a specificity tie-break (test > critique > code_generation > decision > research > writing > analysis).
- Confidence = clamp(0.4 + 0.2·top − 0.15·runner-up, 0.3, 0.95); no match → `analysis` at 0.2.
- The classification and its reason are shown in the plan and journaled; `--type` overrides it.

## Consequences

Instant, offline, explainable; wrong on ambiguous prompts, which the user sees before anything runs. Phase 2's planner classifies each node it creates; an embedding or local-model classifier can replace the rules behind the same `classify()` signature.
