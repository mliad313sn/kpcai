# Phase 1 report — Router

**Date:** 2026-10-23 · **Scope:** spec §9 phase 1, exit criteria in `docs/BUILD_PROMPT.md`
**Demo:** `pnpm demo:phase1` (offline; `KPAI_DEMO_LIVE=1` adds real providers and spends money)
**Team:** PO (integration, CLI, gate), S2 providers & catalog, S3 router & budget, S4 executor, independent reviewer.
**Gate:** review → 1 High + 8 Medium findings → fixed → re-verification → 3 new Medium findings + 2 Low → fixed. Register: `docs/review/PHASE-1-REVIEW.md`.

## What works

| Capability                                                                                                                                                                 | Where                                       | Evidence                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| `kpai run "request"`: classify → plan → route → budget gate → execute with fallback → journal                                                                              | `apps/cli/src/commands/run*.ts`             | 17 CLI tests, demo                                                               |
| `kpai route` (dry run) and `kpai stats` (phase metrics from the journal)                                                                                                   | same                                        | CLI tests                                                                        |
| Competence router (spec §5.3): filters with reasons, profile weights, absolute cost/latency references, deterministic tie-break, one-line justification, ordered fallbacks | `packages/router`                           | IIA test across profiles; p95 0.81 ms on 1,000 candidates                        |
| Capability sheets for 10 providers seeded from models.dev, with per-task competence priors                                                                                 | `packages/providers/descriptors`            | `catalog-sync` reports 0 drift vs the 2026-10-23 snapshot                        |
| One generic adapter (Vercel AI SDK v7) for OpenAI, Google, Mistral, xAI, DeepSeek, OpenRouter, llama.cpp                                                                   | `packages/providers/src/adapters/ai-sdk.ts` | Contract tests vs local fake servers per wire protocol                           |
| Automatic fallback: 429, 5xx, 402/404/413, refusal, malformed, unreachable, mid-stream break, stall (30 s / 60 s)                                                          | `packages/executor`                         | Fault-injection tests; demo                                                      |
| Budget governor: task / session (spans runs) / project / month; every fallback gated; skip unaffordable fallbacks; `--over-budget` override, journaled                     | `packages/budget`, `run-exec.ts`            | Unit + CLI tests                                                                 |
| Cost estimate calibrated from history (median output per model and task type)                                                                                              | `executor/src/calibration.ts`               | End-to-end test; expected cost converges to ~5 % of actual after 3 runs on mocks |
| Security: credential-shaped env names only, `local` must be loopback, keys only over https/loopback, terminal escape sanitising                                            | ADR-0015                                    | Dedicated tests                                                                  |

## What does not work yet

- **Nothing validated against live providers.** No keys were available. All 9 real adapters are tested only against faithful local fakes (Sponsor question Q-2).
- **Estimate target (< 15 %) not met or measured on real traffic.** Measurement and calibration are in place. On mocks the cold-start error is huge, because the default output guess is a quarter of the cap. Formally deferred (D-010); the Sponsor's explicit sign-off is pending (Q-2).
- **The latency weight does nothing.** No catalog gives typical latency (B-10).
- **The classifier is heuristic** and misses some phrasings (B-6).
- **A user override descriptor can still name another provider's key.** Only key shape and transport are enforced. Printing loaded overrides is B-12.
- Piped output is raw by design. `kpai run … | cat` can still carry escape sequences to a terminal (ADR-0015).

## Measurements

| Measure                               | Value                                                                                 | Target                              |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- |
| Router decision latency               | p50 0.27 ms, p95 0.81 ms (1,000 candidates)                                           | < 50 ms                             |
| Fallback success without intervention | 100 % in fault-injection tests and demo (where any model was eligible and affordable) | > 95 % (to confirm on live traffic) |
| Estimate vs real cost                 | Calibrated: ≈ 5 % after 3 runs (mocks). Cold start: > 1,000 % (mocks)                 | < 15 % (deferred, D-010)            |
| Average cost per task                 | $0.0001 (mocks); not measured live                                                    | —                                   |
| Tests / coverage                      | 374 tests. Lines 97.1 %, branches 91.6 %, functions 95.2 %                            | > 80 %                              |
| CI                                    | Windows, Linux, macOS (see `docs/STATUS.md` for the latest run)                       | green                               |

## Three key decisions

1. **Contract-first parallel build (D-004).** The PO landed routing, budget and execution types in `packages/core` before three seats built in disjoint directories. Integration took one day, with one declined contract request (D-005).
2. **Absolute cost and latency references (F6, ADR-0011 amended).** The first router normalised cost against the most expensive candidate, so adding an unrelated model reshuffled the fallback order. With an absolute reference each score depends only on that model and the task.
3. **Every spend point is a gate (F1, N1, ADR-0016).** The review showed a cheap model's failure could silently run a fallback costing 4,000× the budget. Every fallback now passes the governor; unaffordable ones are skipped, never silently paid.

## Lessons

- Independent review earned its cost. It found 1 High and 11 Medium issues that 300+ green tests had not caught.
- CI was red for five pushes before the PO noticed, because the demo's Ctrl+C step raced start-up on slow runners. **Rule from now on:** the PO checks CI after every push before reporting status.
- Three scripted edits silently failed to apply because Prettier had re-wrapped the target lines; one commit message claimed a fix that wasn't there. **Rule:** scripted edits must assert that they matched.

## Next: phase 2 (protocols)

DAG planner; Solo, Author+critic, Debate and Vote protocols; provider diversity enforced for critics; an MCP tool bus with fs, git and a sandboxed shell; an end-to-end demo of a code task reviewed by another provider. Plan: `docs/plans/phase-2.md`.
