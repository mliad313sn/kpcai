# Phase 2 report — Protocols and tool bus

**Date:** 2026-10-23 · **Scope:** spec §3.1, §3.3, §9 phase 2; exit criteria in `docs/BUILD_PROMPT.md`
**Demo:** `pnpm demo:phase2` / `node scripts/demo-phase2.mjs` (offline, mock providers)
**Team:** PO (contracts, CLI integration, gate), S2 providers (tool calling, mock scripting), S4 orchestrator, S5 tool bus and MCP, independent reviewer.
**Gate:** review → 5 High + 7 Medium + 6 Low → fixed → three re-verifications (6 then 2 new findings, all fixed) → **PASS at 6bfb8ee** (D-017). Register: `docs/review/PHASE-2-REVIEW.md`.

## What works

| Capability                                                                                                                                                                                | Where                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `kpai plan` / `kpai do "request"`: a task graph (who does what, with which model and protocol), the cost range per node and in total before anything runs, then execution                 | `apps/cli/src/commands/graph.ts`       |
| Planners: deterministic template planner, and a model planner behind the budget gate                                                                                                      | `packages/orchestrator`                |
| Protocols Solo, Author+critic, Debate, Vote; critic, judge and voters always from another provider (principle 2); code and test nodes always cross-reviewed                               | `packages/orchestrator`                |
| GraphRunner: topological, parallel ready nodes, dependency outputs as context, per-node budget, whole-graph cap, cancellation                                                             | `packages/orchestrator`                |
| Tool calling in the Anthropic, AI SDK and Ollama adapters; mock role scripting for offline demos                                                                                          | `packages/providers`                   |
| Tool bus: fs/git/shell built-ins jailed to the workspace, graded permissions (read allow, write per batch, destructive every time), forbidden zones (defaults + `policy.json`), journaled | `packages/tools`                       |
| Git tools hardened: no repository-configured programs, filters, hooks or submodules run; forbidden zones hidden from status/diff/log                                                      | `packages/tools/src/builtins/git-*.ts` |
| MCP client (stdio, `mcp.json`); non-read-only MCP tools are destructive by default (D-012)                                                                                                | `packages/tools/src/mcp.ts`            |
| Patches applied only with `--apply`, only if a critic from another provider approved them, never after Ctrl+C, refused if they hide bytes; writes confirmed unless `--yes-apply`          | `apps/cli/src/graph/apply.ts`          |
| Workspace guard: refuses home, filesystem root or a folder with no project marker, before any paid call                                                                                   | `apps/cli/src/graph/workspace.ts`      |
| Console protocol contract (JSON-RPC 2.0, zod both ways) for phase 3                                                                                                                       | `packages/kernel/src/protocol.ts`      |

## What does not work yet

- **Nothing validated against live providers** (Sponsor question Q-2). All adapters and protocols are tested against local fakes and scripted mocks.
- **No isolating shell sandbox** on any OS: every `shell.run` is confirmed by a human. `@anthropic-ai/sandbox-runtime` could not run here (no bwrap).
- **The success criterion is met on mocks only:** plan visible, three different models (architecture, implementation, tests), a fourth reviews, cost shown before launch, clean diff in seconds. Not yet timed on a real repository with real models.
- **Pause, resume and redirect** exist in the protocol but not yet in the GraphRunner (phase 3 WP2).
- **Estimates on cold start are far off** on mocks (output tokens > 1,000 % error); calibration closes it after a few runs (phase 1 behaviour, unchanged).

## Measurements

| Measure                             | Value                                                                   | Target  |
| ----------------------------------- | ----------------------------------------------------------------------- | ------- |
| Router decision latency (demo)      | p50 0.04 ms, p95 0.08 ms                                                | < 50 ms |
| Fallback rate (demo)                | 0 % (no injected faults in the phase 2 demo; phase 1 suite covers them) | —       |
| Average cost per task (demo, mocks) | $0.0023                                                                 | —       |
| Graph estimate shown before run     | Every `plan`/`do`; per node range and total; whole-graph cap enforced   | always  |
| Critic diversity                    | 100 % of reviews by another provider (enforced; tests fail otherwise)   | 100 %   |
| Tests / coverage (6bfb8ee)          | 745 tests. Lines 97.7 %, branches 90.9 %, functions 96.7 %              | > 80 %  |
| CI                                  | Green on Windows, Linux and macOS at 6bfb8ee                            | green   |

## Three key decisions

1. **Only approved patches can be applied (D-014, review F4).** A patch is applied only if a critic from another provider explicitly approved its node, the patch carries no hidden bytes, and the human confirmed the write (or passed `--yes-apply`). The review showed unreviewed patches could reach disk; principle 2 is now enforced at the last step, not only in the plan.
2. **Forbidden zones are enforced at every exit, not only at `fs.read`** (F10, N2, NF-1). Secrets left through `git diff`, then through directory contents and diff prefixes from the user's git config. Zones now apply to the pathspec, to the output (fail closed), and to shell path arguments.
3. **Repository content never runs programs on our behalf** (F13, N4, NF-2). A read tool must not execute anything the repository configures: filters, external diff, submodule config, hooks. This is the same threat class as the 2025–2026 agent supply-chain incidents in the benchmark.

## Lessons

- The review found 26 issues in total, 6 of them High, that 700+ green tests had not caught; most were at trust boundaries (what reaches the model, what reaches the disk).
- Windows CI stayed red for several commits while the PO reported green. **Rule kept:** check CI for the exact commit before reporting status.
- Defence in depth paid: when NF-1 bypassed the pathspec layer, the output filter was the second line. Making it fail closed is the general rule now.

## Next: phase 3 (KP Studio console)

The web console (`apps/studio`) is already built against a fake kernel (bb52c46). Next: kernel service extraction and WebSocket server, pause/resume/redirect, terminal and desktop shells, Playwright and axe, onboarding, plus the benchmark Must requirements R-301 to R-307 (editable plan, cost band and live meter, routing reason, steering, checkpoints and rollback, rules files, parallel worktrees).
