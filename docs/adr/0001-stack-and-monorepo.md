# ADR-0001 — Stack and monorepo layout

**Status:** Accepted (phase 0) · **Date:** 2026-10-23

## Context

The master prompt recommends TypeScript on Node 22+, Tauri + React, a TUI sharing the kernel, MCP, SQLite and OpenTelemetry. Windows 11 is the first target. The method requires short files/functions, 80 % coverage and green CI.

## Decision

- **TypeScript 5.9, ESM, Node ≥ 22.13** (`node:sqlite` without a flag). TypeScript 7 (native) is available but typescript-eslint support lags; revisit in phase 3.
- **pnpm workspaces**, `tsc -b` project references. Packages:
  - `packages/core` — contracts (zod schemas, `ProviderAdapter`, `BaseAdapter`), errors, cost.
  - `packages/journal` — SQLite session journal.
  - `packages/providers` — YAML descriptors, registry, adapters.
  - `apps/cli` — `kpai`. Phase 3 adds `apps/desktop` (Tauri) and `apps/tui` (Ink) on the same packages.
- **Vitest** with v8 coverage, thresholds 80 % lines/branches/functions/statements, tests next to sources.
- **ESLint** enforces `max-lines: 400` and `max-lines-per-function: 50` (tests exempt from the latter) and bans literal API keys; Prettier for format.
- **CI** on windows-latest, ubuntu-latest, macos-latest, Node 22, running format, lint, build, coverage and the offline demo.

## Consequences

- The size rules are machine-checked rather than reviewed by hand.
- Packages export compiled `dist/`; tests resolve sources via Vitest aliases, so tests never need a build.
- No Turborepo/Nx: three packages do not justify it yet.

## Revisit when

Build time exceeds ~30 s, or the router's measured latency exceeds 50 ms p95 (then consider Rust for the router only).
