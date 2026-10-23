# ADR-0004 — SQLite driver: `node:sqlite` behind the Journal API

**Status:** Accepted (phase 0) · **Date:** 2026-10-23

## Context

Journal, memory and capability sheets live in SQLite (spec §5.1). Options: `node:sqlite` (built in, no native build, still _experimental_ on Node 22, release candidate from Node 25.7) or `better-sqlite3` 13 (mature, native prebuilds per OS/ABI). The landscape scan also reported an unverified 2026-08 CVE about prepared-statement reuse in `node:sqlite`.

## Decision

- Use **`node:sqlite`** now: zero native dependencies makes Windows installs and a future single-file sidecar (Node SEA inside Tauri) much simpler.
- All SQL stays inside `packages/journal` (and later a `storage` package). Nothing else imports a driver, so switching to `better-sqlite3` (near-identical synchronous API) is a one-package change.
- Statements are prepared per call (no long-lived cached statements), which sidesteps the reported reuse issue.
- The CLI silences only the "SQLite is an experimental feature" warning.

## Consequences

Requires Node ≥ 22.13. WAL mode, foreign keys on, schema versioned with `PRAGMA user_version`.

## Revisit when

Phase 6 hardening (encryption at rest may require SQLCipher-capable drivers), or if the CVE is confirmed for our usage.
