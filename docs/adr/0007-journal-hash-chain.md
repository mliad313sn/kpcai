# ADR-0007 — Append-only hash-chained journal

**Status:** Accepted (phase 0) · **Date:** 2026-10-23

## Context

Spec §3.5 (structured, replayable journal) and §6 (tamper-evident audit of outgoing calls).

## Decision

- Tables `sessions` and `events`. Event types: `routing`, `call`, `response`, `tool`, `intervention`, `error` (CHECK-constrained).
- Each event stores `prev_hash` and `hash = sha256(JSON([prev_hash, id, session, ts, node, provider, model, type, payload, cost]))`. The chain is global across sessions, so deleting a whole session is also detected.
- `kpai verify` recomputes the chain and reports the first broken event.
- The `call` event stores the full request (local only, principle 5); `response` stores text, usage, stop reason, duration and cost.

## Consequences

Tamper-_evident_, not tamper-_proof_: an attacker with write access can rebuild the chain. Phase 6 adds periodic anchoring (signed checkpoint outside the DB) and encryption at rest.
