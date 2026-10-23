# ADR-0015 — Untrusted text and provider trust boundaries

**Status:** Accepted (phase 1, after gate review F8/F9/F13) · **Date:** 2026-10-23

## Context

"Adding a provider = one YAML" (spec §3.2) makes descriptors a supply-chain surface, and spec §6 treats all model output as untrusted. The gate review showed a shared descriptor could send any environment variable to any host on every command, and that model text could drive the terminal (OSC 52 clipboard writes, screen clears).

## Decision

1. `auth.env` must match `^[A-Z][A-Z0-9_]*_API_(KEY|TOKEN)$`. Generic secrets (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`) cannot be named.
2. `kind: local` providers must resolve (after env overrides) to loopback; otherwise they are unavailable, and sending is refused even when addressed explicitly. A missing base URL is not local.
3. Credentials are only sent over https or to loopback, in discovery and in chat.
4. Discovery sends `Authorization` only when the descriptor declares `auth`.
5. Descriptor origins (built-in vs `$KPAI_HOME/providers`) are recorded, so overrides can be shown.
6. Text from models and provider error messages is stripped of escape sequences and C0/C1 controls before reaching a terminal; the journal keeps the raw text; piped output is the raw final answer.
7. Only known parse/validation errors become `malformed` (fallback-eligible); unknown errors are `bad_request` and stop, so bugs are not silently retried on other providers.

## Consequences

A user who really wants a remote Ollama declares it `kind: cloud` in an override, and it is then treated, budgeted and constrained as cloud. Remaining gap: a malicious override can still declare `kind: cloud` with a lookalike base URL for a real key name — the CLI should print loaded overrides (backlog B-12).
