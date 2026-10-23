# ADR-0014 — Budget governor and spend ledger

**Status:** Accepted (phase 1) · **Date:** 2026-10-23 · Built by S3, accepted by the PO

## Decision

- Limits per scope in USD from `KPAI_BUDGET_{TASK,SESSION,PROJECT,MONTH}_USD`; unset scopes are not enforced. Check order task → session → project → month; the first scope where spent + expected estimate exceeds the limit blocks and offers `reduce_scope`, `cheaper_models`, `continue`. Equal to the limit is allowed.
- Not blocked and expected estimate above `KPAI_CONFIRM_ABOVE_USD` → confirmation (non-interactive declines unless `--yes`).
- Spend is read from the journal (`Journal.spend`): session = this session, project = sessions with the same working directory, month = all sessions since the first of the calendar month (UTC).
- Only `response` events carry a cost, so nothing is counted twice. Failed attempts are not billed in phase 1 (backlog: estimated cost of partial output on failed attempts).
- Journal schema v2 adds indexes only; the hash chain is untouched.

## Consequences

A blocked run is journaled as an `intervention` with the verdict, so every refusal to spend is auditable.
