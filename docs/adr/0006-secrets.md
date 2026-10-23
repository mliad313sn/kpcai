# ADR-0006 — Secrets until phase 6

**Status:** Accepted (phase 0) · **Date:** 2026-10-23

## Decision

- Phase 0–5 read API keys from environment variables named in each descriptor (`auth.env`). Keys are never written to the journal, logs or descriptor files; ESLint rejects literal `sk-ant-` strings.
- Phase 6 moves keys to the OS keychain via `@napi-rs/keyring` (keytar is archived), with environment variables as an explicit override.
- `.env*` files are git-ignored; `.env.example` documents names only.

## Consequences

Users must export keys in their shell for now; `kpai providers` reports which are present without printing them.
