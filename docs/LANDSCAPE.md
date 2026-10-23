# Open-source landscape scan (2026-10-23)

Survey done before writing KernelPAI code, as the master prompt requires ("chercher l'existant avant d'écrire").
Versions and licenses come from the npm registry and LICENSE files; star counts from GitHub search.
Items marked **(unverified)** come from a single secondary source.

## 1. Multi-provider clients (TypeScript)

| Project                             | License                    | State                                                                                                  | Verdict                                                                                                 |
| ----------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Vercel AI SDK `ai` v7 + `@ai-sdk/*` | Apache-2.0                 | `ai` 7.0.150; first-party anthropic, openai, google, mistral, **xai**, **deepseek**, openai-compatible | Best candidate for a _generic_ adapter (streaming, AbortSignal, tools, reasoning parts). Node 22+, ESM. |
| `@openrouter/ai-sdk-provider`       | Apache-2.0                 | 3.1.0                                                                                                  | OpenRouter route.                                                                                       |
| ollama-js                           | MIT                        | 0.6.4                                                                                                  | Model management (pull/list/ps). Chat is a trivial NDJSON stream.                                       |
| node-llama-cpp                      | MIT                        | 3.22.2                                                                                                 | Optional in-process GGUF backend; heavy native build.                                                   |
| llama.cpp `llama-server`            | MIT                        | —                                                                                                      | OpenAI-compatible `/v1/chat/completions`; covered by an openai-compatible adapter.                      |
| LiteLLM                             | MIT (except `enterprise/`) | Python + proxy                                                                                         | No TS client. Valuable for its **pricing JSON** and fallback semantics.                                 |
| multi-llm-ts, token.js, llm.js      | various                    | small / stale                                                                                          | Do not adopt.                                                                                           |

## 2. Routers

| Project                                                                     | Verdict                                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| RouteLLM (Apache-2.0, Python)                                               | Binary strong/weak routing; reference only.                                              |
| Arch-Router-1.5B / Plano (gateway Apache-2.0, model under Katanemo license) | Closest to task-type routing; optional local classifier, check model license.            |
| semantic-router (Python)                                                    | Copy the idea: per-route exemplar embeddings, nearest wins.                              |
| LiteLLM Router                                                              | Copy fallback / cooldown semantics.                                                      |
| Not Diamond, Martian, OpenRouter auto                                       | Hosted black boxes; at most a "last resort" target.                                      |
| RouterBench, RouterEval, RouterArena, LLMRouterBench                        | Offline evaluation sets. None ships per-task-type capability sheets for frontier models. |

## 3. Orchestration and cross-model review

| Project                                                       | License                   | Verdict                                                                                                          |
| ------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Mastra (`@mastra/core` 1.79)                                  | Apache-2.0 (except `ee/`) | Closest TS fit (DAG workflows, suspend/resume, MCP, OTel) but heavy, fast churn, storage opinions. Borrow ideas. |
| LangGraph.js 1.5                                              | MIT                       | Good checkpoint/interrupt model; drags in `@langchain/core`. Borrow patterns.                                    |
| VoltAgent                                                     | MIT                       | Runner-up to Mastra.                                                                                             |
| OpenAI Agents SDK, Google ADK, Claude Agent SDK (proprietary) | —                         | Vendor-centric; not a core.                                                                                      |
| karpathy/llm-council                                          | **no license**            | Copy the _pattern_ (answer → anonymous peer ranking → chairman), never the code.                                 |
| Mixture-of-Agents (Together)                                  | Apache-2.0                | Proposers + aggregator pattern.                                                                                  |

**Finding:** no TS framework ships author+critic / debate / vote as composable DAG node types with cost and quorum control.

## 4. Coding consoles

| Project     | License     | Multi-model                         | Note                                                         |
| ----------- | ----------- | ----------------------------------- | ------------------------------------------------------------ |
| opencode    | MIT         | model per agent                     | Uses AI SDK + models.dev; good provider/auth reference.      |
| Aider       | Apache-2.0  | architect/editor                    | Canonical two-model pattern; edit formats worth copying.     |
| Cline       | Apache-2.0  | plan/act                            | —                                                            |
| Continue    | Apache-2.0  | model roles                         | Role config schema worth copying.                            |
| Plandex     | MIT         | model packs                         | Role pattern.                                                |
| Kilo Code   | MIT         | modes                               | opencode fork.                                               |
| Goose       | Apache-2.0  | planner model (lead/worker removed) | MCP-first reference.                                         |
| OpenHands   | MIT         | mostly single                       | Docker sandbox reference.                                    |
| Codex CLI   | Apache-2.0  | single vendor                       | **Best sandbox reference incl. native Windows.**             |
| Gemini CLI  | Apache-2.0  | single vendor                       | Ink TUI reference.                                           |
| Roo Code    | Apache-2.0  | —                                   | Archived 2026-05.                                            |
| Crush       | FSL-1.1-MIT | —                                   | Source-available; do not copy.                               |
| Claude Code | proprietary | subagents                           | Not reusable; `@anthropic-ai/sandbox-runtime` is Apache-2.0. |

**Finding:** all assign models to _fixed roles_. None does competence-scored per-task routing plus systematic cross-provider review.

## 5. MCP

- Spec revision 2026-07-28: stateless core, Tasks as an extension (unverified details).
- TypeScript SDK v2: `@modelcontextprotocol/client` / `server` 2.3.1; legacy `@modelcontextprotocol/sdk` 1.32.1 still maintained. **Build on v2 client.**
- Shell sandbox: Seatbelt (macOS), bubblewrap + seccomp/Landlock (Linux) via `@anthropic-ai/sandbox-runtime`; **Windows has no off-the-shelf equivalent** — WSL2 or per-command approval first, port Codex's restricted-token approach later.

## 6. Capability and price catalogs

| Source                                                  | License | Use                                                                                                                                                 |
| ------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| models.dev `api.json`                                   | MIT     | **Primary seed**: 230 providers / 8,846 models; limits, cost, tool_call, reasoning, modalities. No `ollama`/`llama.cpp` (runtime discovery needed). |
| LiteLLM price JSON                                      | MIT     | Price cross-check.                                                                                                                                  |
| OpenRouter `/api/v1/models`                             | ToS     | Live availability and prices.                                                                                                                       |
| Aider polyglot, LMArena categories, Artificial Analysis | various | Priors for competence scores (check terms).                                                                                                         |

**Gap:** no catalog has per-task-type competence; KernelPAI must learn it locally (spec §5.4).

## 7. Storage, observability, secrets

- `node:sqlite`: no flag since 22.13 but still _experimental_ on Node 22; RC in 25.7. A 2026-08 CVE on prepared-statement reuse is reported (unverified). `better-sqlite3` 13 is the mature alternative (native prebuilds). See ADR-0004.
- OpenTelemetry JS 1.10 API / sdk-node 0.300; GenAI semantic conventions still _Development_ — pin and expect renames.
- Langfuse (MIT, now ClickHouse Inc.) too heavy to self-host locally; Arize Phoenix is ELv2 — optional external viewers only.
- Keychain: `keytar` is archived; use `@napi-rs/keyring` 2.1.

## 8. UI

- Ink 8 (MIT) for the TUI; Tauri 2 for desktop with the Node core as a **sidecar** process speaking JSON-RPC; Electron as fallback if sidecar packaging on Windows hurts. OpenTUI to watch.

## Build vs adopt

| Component     | Decision                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter layer | **Own port + thin adapters.** Native SDK where it is the vendor's (Anthropic), raw HTTP where trivial (Ollama), AI SDK v7 evaluated as the generic adapter for the remaining providers (ADR-0002). |
| Router        | **Build** (competence sheets + measured scores + fallback). Arch-Router as optional classifier.                                                                                                    |
| Orchestration | **Build** DAG + review protocols in SQLite; borrow Mastra/LangGraph patterns.                                                                                                                      |
| Tool bus      | **Adopt** MCP TS SDK v2; sandbox-runtime on macOS/Linux; Windows approval-gated.                                                                                                                   |
| Storage       | **Adopt** SQLite behind the Journal API (ADR-0004).                                                                                                                                                |
| Observability | **Adopt** OTel JS + pinned GenAI semconv, local exporter into SQLite.                                                                                                                              |
| UI            | **Adopt** Tauri 2 + React, Ink 8; build the app.                                                                                                                                                   |
| Catalog seed  | **Adopt** models.dev + LiteLLM cross-check; overlay local competence scores.                                                                                                                       |

## Gaps KernelPAI fills

1. Transparent, editable, outcome-updated per-task competence routing across cloud and local models.
2. Cross-provider review (critic, debate, vote) as composable, budgeted DAG primitives.
3. A local-first, provider-neutral console with visible per-task model attribution.
4. Unified local trace + cost + memory in SQLite, no server stack.
5. Cross-platform shell sandboxing including Windows inside an MCP tool bus.
