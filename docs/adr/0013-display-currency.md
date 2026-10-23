# ADR-0013 — Display currency

**Status:** Accepted (phase 1) · **Date:** 2026-10-23

## Context

The success criterion shows "0,40 €"; providers bill in USD; ADR-0005 stores USD.

## Decision

- Storage and limits stay in USD (`KPAI_BUDGET_*_USD`).
- `KPAI_CURRENCY` (ISO 4217, default USD) changes display only. Any currency other than USD requires `KPAI_USD_RATE` (units per 1 USD). KernelPAI never ships or fetches an exchange rate: a wrong rate would silently misstate costs, and fetching one would add a network call to the critical path.
- Tiny amounts keep two significant digits (`$0.000042`), others two decimals.

## Consequences

French users set `KPAI_CURRENCY=EUR KPAI_USD_RATE=<today's rate>`; a stale rate is their explicit choice, visible in config.
