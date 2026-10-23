# Phase 0 report — Foundations

**Date:** 2026-10-23 · **Scope:** spec §9 phase 0 · **Demo:** `pnpm demo:phase0` (offline; `KPAI_DEMO_LIVE=1` adds Ollama/Anthropic if available)

## What works

| Phase 0 deliverable | Where                                                                         | Evidence                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Repo, monorepo, CI  | pnpm workspaces, `tsc -b`, `.github/workflows/ci.yml` (Windows, Linux, macOS) | `pnpm check` green locally on Linux                                                                                                   |
| Adapter contract    | `packages/core/src/adapter.ts` (ADR-0002)                                     | 4 contract tests incl. cancel-by-id and pre-aborted signal                                                                            |
| Cloud adapter       | Anthropic, official SDK (ADR-0003)                                            | 9 tests vs a local SSE server: stream, usage, stop reasons, refusal, 401/429/529/400, unreachable, missing key, mid-stream cancel     |
| Local adapter       | Ollama native API with model discovery                                        | 11 tests vs a local NDJSON server: discovery, stream, `length` stop, malformed/error chunks, missing `done`, 404, unreachable, cancel |
| Offline adapter     | `mock` (deterministic, failure triggers)                                      | Drives the demo and CLI tests without network                                                                                         |
| SQLite journal      | `packages/journal` (ADR-0004, ADR-0007)                                       | Hash chain, tamper detection, Markdown export; 6 tests                                                                                |
| Minimal CLI         | `kpai providers / ask / log / export / verify`                                | 11 in-process CLI tests                                                                                                               |
| Stack ADRs          | `docs/adr/0001`–`0009`                                                        | —                                                                                                                                     |

Principles already honoured in their phase 0 form:

- **1 (no default routing):** `ask` refuses without `-m`; every call journals a routing reason.
- **3 (transparency):** estimate before the call; footer with model, duration, tokens, cost and session id after it.
- **4 (interruptible):** Ctrl+C cancels through `adapter.cancel(id)`, keeps the partial text and bills it from estimates.
- **5 (local first):** journal, prompts and answers stay in `~/.kernelpai/journal.db`.
- **6 (budget first):** confirmation above `KPAI_CONFIRM_ABOVE_USD`; declines are journaled.

## What does not work yet

- **Not exercised against live services.** No Ollama server or Anthropic key was available in the build environment. The Anthropic adapter did reach the real API once and correctly mapped its 401 to `auth`. Every other path is tested only against faithful local fakes. Run `KPAI_DEMO_LIVE=1 pnpm demo:phase0` on a machine with Ollama and a key to close this.
- **Windows only checked by CI.** Development ran on Linux. The CI matrix includes `windows-latest`, but the first run happens on push. On Windows the demo skips the Ctrl+C step, because a parent process cannot deliver SIGINT to a child there.
- **No routing, fallback or budget governor** (phase 1). So no router-latency or fallback-rate figures exist yet.
- **Estimates are heuristic** (characters ÷ 4). The gap between estimate and real cost has not been measured on real providers.
- **Text only.** No tools, images or reasoning blocks in the event stream (phase 2).

## Measurements

From `node scripts/bench-phase0.mjs` (Linux container, Node 22.22):

| Measure                                 | Value                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Router decision latency                 | n/a (phase 1; target < 50 ms)                                                                                        |
| Fallback success rate                   | n/a (phase 1; target > 95 %)                                                                                         |
| Average cost per task                   | $0 local / mock. The live Anthropic rate is not measured. Haiku 5.5 at a 64-token cap is about $0.00003 by estimate. |
| Journal append, 500-byte payload        | p50 ≈ 0.2 ms, p95 ≈ 0.5 ms                                                                                           |
| Journal verify, 2,000 events            | ≈ 12 ms                                                                                                              |
| Registry load, 3 YAML files             | ≈ 1.4 ms                                                                                                             |
| Kernel overhead per call (mock, no I/O) | p50 ≈ 11 µs                                                                                                          |
| Tests / coverage                        | 67 tests. Lines 96.4 %, branches 86.9 %, functions 90.7 %, statements 94.8 %                                         |

## Three key decisions

1. **Own adapter port, not a client library as the core (ADR-0002).** The kernel needs things no client models: failure _kinds_ that drive fallback, cancel by request id, and capability sheets with jurisdiction. Adapters may use any SDK internally. The Vercel AI SDK v7 is the phase 1 candidate for one generic adapter covering the remaining providers.
2. **`node:sqlite` behind the Journal API (ADR-0004).** It has no native build, which helps Windows and the future Tauri sidecar. `better-sqlite3` remains a one-package swap if the experimental status or the reported CVE bites.
3. **A hash-chained, append-only journal from day one (ADR-0007).** The audit and replay requirements (§3.5, §6) shape the schema, so building them in now avoids a migration later. `kpai verify` already detects edits.

Also worth noting: `BaseAdapter` races every stream against the abort signal. A test exposed that an adapter which ignores the signal would otherwise hang on cancel.

## Next: phase 1 (router)

Seed capability sheets from models.dev and add an AI SDK-based generic adapter for OpenAI, Google, Mistral, xAI, DeepSeek, OpenRouter and llama.cpp. Build the scored router with one-line justifications and fallback lists. Add fault-injection tests (429, 5xx, refusal, malformed, unreachable) and a measured fallback rate. Add a multi-level budget governor with calibrated estimates, and `kpai run "request"` showing plan, routing and cost. Exit criteria are in `docs/BUILD_PROMPT.md`.
