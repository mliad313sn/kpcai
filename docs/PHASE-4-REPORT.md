# Phase 4 report — Memory and learning

**Date:** 2026-10-23 · **Scope:** spec §3.1, §3.5, §4.6 and §5.4; exit criteria in `docs/BUILD_PROMPT.md`, plus R-401..R-403 (Must) and R-404..R-406 (Should) · Plan: [plans/phase-4.md](plans/phase-4.md)
**Demo:** `node scripts/demo-phase4.mjs` (offline: memory propose → confirm → inject, grading, competence evidence in routing, replay and fork, a dispute settled by a person, productivity from the journal) · **E2E:** `pnpm e2e`
**Team:** PO; S1 kernel wiring and protocol; S3 grading, competence, bench and accuracy; S4 replay, fork, disputes and review policy; S6 KP Studio views; S7 memory guard, taint and redaction; S8 metrics, e2e and demo; independent reviewer.
**Gate:** review → 2 High, 4 Medium, 6 Low (D-024) → fixed → re-verification **PASS-WITH-NOTES** → 1 Medium and 3 Low fixed at closure (D-030). Register: [review/PHASE-4-REVIEW.md](review/PHASE-4-REVIEW.md).

## What works

| Capability                                                                                                                                            | Where                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Unified memory in three layers (session, project, user), Markdown with provenance per fact; a model may only propose, a person confirms               | `packages/memory`, ADR-0027                 |
| Memory never holds secrets or zone content; repository memory is untrusted and cannot forge provenance; local-only facts never reach a cloud provider | `packages/memory`, ADR-0027 addenda         |
| Local-only taint: what a local step produced from a local-only fact stays local, in runs, replays and forks, or fails closed                          | `packages/kernel/src/replay-taint.ts`       |
| Automatic grades from journaled events only (tests that really ran, patch accepted, reverted, critic objections) plus one manual grade per node       | `packages/learning`, ADR-0028               |
| Measured competence per model, task type and repository, blended with the prior with bounded updates; the router cites the evidence                   | `packages/router`, `packages/learning`      |
| `kpai bench`: short calibration on the user's own repository                                                                                          | `apps/cli`, ADR-0028                        |
| Replay a node with another model side by side, fork a run from any node; estimate first, cap checked, cancellable; the run's routing is a floor       | `packages/orchestrator`, ADR-0029           |
| Disagreement fails closed: split votes, critics or judges make the node disputed and a person chooses among options shown in full                     | ADR-0029                                    |
| Review depth by criticality and verification ROI (cost per accepted finding, revised verdicts as the headline)                                        | `packages/orchestrator/src/verification.ts` |
| Estimate accuracy (R-402) and productivity metrics computed only from the journal, with documented formulas (R-406)                                   | `docs/metrics/PRODUCTIVITY.md`              |
| KP Studio: memory editor, replay and fork with compare, competence evidence, disputes, accuracy and productivity, in French and English               | `apps/studio`, `apps/studio-tui`            |

## What does not work yet

- **Nothing validated against live providers** (Q-2). Competence, accuracy and cost bands are calibrated on mock traffic.
- A fork's estimate prices tainted reruns on their usual (possibly cloud) models; the run itself is held local, so the estimate can be high (ADR-0027 addendum P4-R1).
- Runs are found by scanning recent sessions; a run index is backlogged with B-23.
- A `disputed` node state in the core graph contract is proposed, not made (disputes travel on the control feed).

## Measurements

| Measure          | Value                                                                        | Target    |
| ---------------- | ---------------------------------------------------------------------------- | --------- |
| Tests / coverage | 1,634 unit and integration tests; lines 97.9 %, branches 90.6 %; 39 e2e      | > 80 %    |
| Accessibility    | axe WCAG 2.2 AA on the new screens (memory, replay, disputes, productivity)  | 0 serious |
| Review mutations | 19 of 20 fix reversions caught by tests; the 20th covered at closure (P4-R4) | all       |
| CI               | green on Windows, Linux, macOS, e2e and desktop at 5864258                   | green     |

## Three key decisions

1. **Memory is a persistence channel for prompt injection, so it is guarded like one.** Propose, then a person confirms; provenance is validated and escaped; repository memory is always untrusted; local-only facts taint what they touch.
2. **Learning uses evidence, not opinions.** Grades come from the journal only, test runs that test nothing do not count, manual grades carry the server's author, and updates are bounded.
3. **Replays and forks are runs, with every run rule.** Same budget gate and cap, same scope gate, same project only, and the original run's routing (local-only, exclusions, provider diversity) is a floor.

## Lessons

- The review's two Highs were both "a new path around an old rule": repository memory around provenance, replay around routing constraints. New entry points now get a checklist of the run rules they must inherit.
- A wall-clock assertion in a jsdom unit test failed on a loaded Windows runner; latency budgets are measured in the browser e2e only.
- Mutation checks by the reviewer found one defence with no test of its own; reverting fixes is now part of every seat's report.

## Next: phase 5 (tools and extensions, Enterprise mode)

MCP registry and pinning, skills and hooks, external agents and subscriptions, ACP, background runs; then Program and Enterprise mode on the accepted design (D-028) with the S10 recommendations adopted in D-029: heartbeat and watchdog, spending brakes, change-only reports, assurance labels, the DVO journal fields, a small default team and the Enterprise view.
