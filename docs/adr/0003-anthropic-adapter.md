# ADR-0003 — Anthropic adapter on the official SDK

**Status:** Accepted (phase 0) · **Date:** 2026-10-23

## Context

Phase 0 needs one cloud adapter. Anthropic's TypeScript SDK (`@anthropic-ai/sdk` 1.x) handles SSE parsing, typed errors and abort signals.

## Decision

- Use `@anthropic-ai/sdk` with `messages.stream(…, { signal })`.
- `maxRetries: 0`: retries/fallback are the kernel's job (ADR-0002).
- Send only `model`, `max_tokens`, `system`, `messages`. No sampling parameters (since 2026-10-21 the API rejects `temperature`/`top_p`/`top_k`), no `thinking` override (current models default to adaptive thinking). Effort control arrives with routing profiles in phase 1.
- Map SDK errors: connection → `unavailable`; HTTP status via `kindFromStatus`; `stop_reason: refusal` → `ProviderError('refusal')` (fallback-eligible).
- Model ids, prices and context windows live in `descriptors/anthropic.yaml`, never in code. Base URL can be overridden with `ANTHROPIC_BASE_URL` (used by tests).
- Note: SDK 1.x sends the API key as `Authorization: Bearer`.

## Consequences

Tests run the real SDK against a local SSE server, so SDK upgrades are covered by the same contract tests.

## Revisit when

Phase 2 adds tool use (`eager_input_streaming`, strict tools) and phase 1 adds token counting (`messages.countTokens`) for estimates.
