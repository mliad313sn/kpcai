# ADR-0002 — Provider adapter contract (own port)

**Status:** Accepted (phase 0) · **Date:** 2026-10-23

## Context

Spec §5.2 defines `send → stream`, `cancel(id)`, `capabilities()`, `estimate()`. Adding a provider must take one description file plus one adapter class. The landscape scan (docs/LANDSCAPE.md) found the Vercel AI SDK v7 covers most providers well, but the kernel needs things no client library models: competence sheets, jurisdiction, normalised failure kinds that drive fallback, and cancellation by request id from the UI.

## Decision

- KernelPAI owns the port: `ProviderAdapter { descriptor, capabilities(), estimate(req), send(req, {requestId, signal}) → AsyncIterable<StreamEvent>, cancel(requestId), detect() }`.
- `StreamEvent` is a small normalised union: `start | text | usage | end(stopReason)`. Tools and reasoning parts are added in phase 2 as new variants.
- Every failure is a `ProviderError` with a `kind` (`auth | rate_limit | unavailable | refusal | malformed | bad_request | cancelled | budget`). `fallbackEligible` is derived from the kind; the phase 1 router decides fallback from that alone.
- `BaseAdapter` holds the shared plumbing: zod validation of the request, a registry of in-flight `AbortController`s for `cancel(id)`, model-card lookup, estimation, and an **abort race** so a call stops even if an adapter's I/O ignores the signal.
- Adapters are free in their internals: vendor SDK, raw HTTP, or the AI SDK. **Phase 1 evaluates `ai` v7 as one generic adapter** for OpenAI, Google, Mistral, xAI, DeepSeek, OpenRouter and llama.cpp; it would sit behind this same port.
- Adapters never retry; retry and fallback belong to the kernel.

## Consequences

- The kernel stays independent of any client library's churn.
- Mapping errors to kinds is per-adapter work, covered by contract tests against local fake servers (401, 429, 5xx, unreachable, malformed, refusal, cancel).

## Revisit when

Tool calling lands (phase 2): the event union grows, and the AI SDK decision is final.
