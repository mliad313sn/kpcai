# ADR-0010 — One generic adapter on the Vercel AI SDK

**Status:** Accepted (phase 1, decision D-002) · **Date:** 2026-10-23

## Context

Phase 1/5 must cover OpenAI, Google, Mistral, xAI, DeepSeek, OpenRouter and llama.cpp. ADR-0002 keeps our own port; the landscape scan found `ai` v7 (Apache-2.0) with first-party packages for all of them (llama.cpp via `@ai-sdk/openai-compatible`).

## Decision

- One class, `AiSdkAdapter`, wraps `streamText` from `ai` v7. Descriptors select the SDK through the adapter key (`adapter: ai-sdk:<sdk>`), so the registry needs one line per SDK and the class stays single.
- `maxRetries: 0`, `abortSignal` from `BaseAdapter`, `APICallError.statusCode` mapped with `kindFromStatus`, connection failures → `unavailable`.
- Model ids, prices and limits stay in YAML, seeded from models.dev; `scripts/catalog-sync.mjs` reports drift and never overwrites.

## Consequences

- Seven providers ride on one dependency family; an `ai` major upgrade is covered by the per-SDK contract tests against local fake servers.
- Anthropic and Ollama keep their direct adapters (ADR-0003, phase 0), which also gives a non-AI-SDK path if the AI SDK breaks.

## Revisit when

Tool calling (phase 2) — the AI SDK's tool parts must map onto our event union.
