# Phase 1 plan — Router

Owner: Product Owner · Started 2026-10-23 · Exit criteria: `docs/BUILD_PROMPT.md` (Phase 1) and spec §9.

Shared contracts landed first by the PO in `packages/core/src/{routing,budget,execution}.ts` and `ModelCard.competence`. Seats code against them and must not change them; requests go to the PO.

## Work packages

### WP1 — Providers and catalog (S2, kpai-provider-engineer)

Owns `packages/providers/**`, `scripts/catalog-sync.mjs`.

1. `AiSdkAdapter` (one class, Vercel AI SDK v7 inside, ADR-0002/D-002) serving descriptors with `adapter: ai-sdk` and an `sdk:` field: `openai`, `google`, `mistral`, `xai`, `deepseek`, `openrouter`, `openai-compatible`. Streaming text + usage + stop reason, AbortSignal cancel, error → `ProviderError` kinds, no retries (`maxRetries: 0`).
2. Descriptors for OpenAI, Google, Mistral, xAI, DeepSeek, OpenRouter (current flagship + cheap model each, prices and limits from models.dev), and llama.cpp (`openai-compatible`, local, runtime discovery via `GET /v1/models`).
3. `competence` priors on every card (0–1 per task type), documented source (models.dev capabilities + public leaderboards); local default card gets conservative priors.
4. `scripts/catalog-sync.mjs`: reads models.dev `api.json` (URL or file) and prints a price/limit diff against the YAML — never overwrites by itself.
5. `candidates(registry)`: detected, available adapters → `Candidate[]` (skips unavailable providers, includes their reason).
   Acceptance: per-SDK contract tests against local fake servers (OpenAI-style SSE, Gemini stream) incl. 401/429/5xx/unreachable/cancel; registry loads all descriptors; coverage ≥ 80 %.

### WP2 — Router and budget governor (S3, kpai-routing-engineer)

Owns `packages/router/**`, `packages/budget/**`, and the spend query in `packages/journal/**`.

1. `CompetenceRouter implements Router`: filters (modality, context fits estimated input + output, jurisdiction, denied, localOnly, excludeProviders for diversity, excludeKinds default `["test"]`), scores per spec §5.3 with profile weights (`economy | balanced | performance`), static competence = `card.competence[type]` else 0.5 ± strengths/weaknesses, measured competence blended by sample count, cost penalty = expected cost / node budget (capped), latency penalty = typical latency / max latency. Deterministic tie-break. Returns chosen + ordered fallbacks + rejections + **one-line reason** naming the winner's decisive factor and the runner-up.
2. Latency bench: ≥ 1,000 candidates, p95 < 50 ms; a test asserts p95 < 50 ms on 200 candidates.
3. `Governor implements BudgetGovernor` over `SpendLedger`: block when task/session/project/month projected spend exceeds the limit (options `reduce_scope`, `cheaper_models`, `continue`), confirm above `confirmAboveUsd`, else allow.
4. Journal: schema migration adding nothing destructive; `spend({ sessionId?, project?, since? })` summing `cost_usd`; `JournalLedger implements SpendLedger` (month = calendar month UTC of `now`).
   Acceptance: unit tests for each filter, each weight, diversity exclusion, empty-candidate error, profile differences, budget block/confirm/allow at each scope, month boundary; coverage ≥ 80 %.

### WP3 — Executor, fallback, classifier (S4, kpai-orchestration-engineer)

Owns `packages/executor/**`.

1. `FallbackExecutor implements Executor`: tries `decision.chosen` then `decision.fallbacks` in order; on `ProviderError` with `fallbackEligible` journals `error` + a `routing` event ("fallback to X after Y: kind") and moves on; non-eligible errors stop; cancellation (signal) stops everything and keeps partial text; journals `call` and `response` with cost; returns `ExecutionResult`.
2. Mid-stream failure policy: if an attempt fails after emitting text, discard its text for the next attempt but keep it in the journal (`partialText`).
3. `classify(prompt) → Classification`: transparent keyword/regex heuristic over the seven task types, EN + FR keywords, with confidence and reason.
4. `metrics(journal, filter)` → fallback rate, fallback success rate, average cost per task, estimate error (estimated vs reported input tokens), router latency p50/p95 (from `routing` events' `elapsedMs`).
   Acceptance: fault-injection tests with mock adapters (429 then success, 5xx×2 then success, auth stops, all fail, malformed, refusal, cancel mid-stream), classifier table tests (EN/FR), metrics tests; coverage ≥ 80 %.

### WP4 — Integration (PO)

`kpai run "request"` (classify → plan → route → budget → confirm → execute with fallback → footer), `kpai route "request"` (dry run), `kpai stats`, profile/currency flags (`--profile`, `KPAI_CURRENCY`, `KPAI_USD_RATE`), demo `scripts/demo-phase1.mjs`, ADRs, independent review, `docs/PHASE-1-REPORT.md`.
