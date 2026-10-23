# Phase 3 report — Console (KP Studio)

**Date:** 2026-10-23 · **Scope:** spec §4 and §9 phase 3; exit criteria in `docs/BUILD_PROMPT.md`, plus the Must requirements R-301..R-307 (D-016) and the adoption items of D-020
**Demo:** `pnpm demo:phase3` (offline: `kpai studio`, edited plan, steering, isolated run and merge, checkpoint restore, artifact save, pack detection) · **E2E:** `pnpm e2e`
**Team:** PO; S1 kernel and server; S3 cost bands; S4 run control and pack planning; S5 checkpoints, rules and worktrees; S6 KP Studio web, terminal and desktop; S7 zones and pack security; S8 e2e, accessibility and metrics; S9 adoption and domain packs; independent reviewer.
**Gate:** review → 1 High, 5 Medium, 5 Low → fixed → re-verification **PASS-WITH-NOTES** → 2 Low fixed at closure, 1 accepted (D-023). Register: `docs/review/PHASE-3-REVIEW.md`.

## What works

| Capability                                                                                                                                                 | Where                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| One kernel for CLI and console; every safety rule enforced once (workspace guard, budget gates, approved patches, confirmed writes, serialised questions)  | `packages/kernel`                              |
| Local console server: JSON-RPC over WebSocket on 127.0.0.1, token, origin and Host checks, validated messages, silence means no                            | `packages/server`, ADR-0019                    |
| KP Studio web: plan editable before running, "likely $X · at most $Y" with a live meter, "why this model" on every step, steering, runs manager, artifacts | `apps/studio`                                  |
| KP Studio terminal (Ink) on the same store; desktop shell (Tauri 2) compiled on three OS, unsigned                                                         | `apps/studio-tui`, `apps/studio-desktop`       |
| Run control: pause, resume, redirect, instruction; finished work kept; principle 2 and budget held on redirect                                             | `packages/orchestrator`, ADR-0020              |
| Checkpoint before every write, confirmed restore; one isolated worktree per run with confirmed merge; repository rules as untrusted context                | `packages/tools/src/workspace`, ADR-0021       |
| Non-code results (reports, configs, models, maps) next to patches, with provenance; unreviewed documents saved only on a per-save confirmation             | ADR-0022                                       |
| Domain packs for 18 fields plus a generic one; authorised scope for security packs; two-tier forbidden zones                                               | `packages/packs`, ADR-0023, ADR-0024, ADR-0025 |
| Cost before execution is the worst plausible cost: the approved figure, the budget check and the hard cap are the band top; node budgets are caps too      | D-021, ADR-0026, ADR-0005 addendum             |
| French and English in the console, the terminal UI and the CLI; onboarding with a $0 local-only path                                                       | i18n catalogues                                |

## What does not work yet

- **Nothing validated against live providers** (Sponsor question Q-2). Cost bands and cold-start factors are set from mock runs.
- **Desktop app:** compiled in CI, not packaged with a Node runtime, not signed (phase 6; signing is Sponsor-reserved).
- **Not yet in the console:** file tree and terminal tabs (phase 5), replay and fork (phase 4), choosing a single patch in the TUI.
- **Shell sandbox:** still no isolating sandbox; every `shell.run` is confirmed.
- Remaining CLI messages outside the main ones are English only.

## Measurements

| Measure                                      | Value                                                                   | Target    |
| -------------------------------------------- | ----------------------------------------------------------------------- | --------- |
| Router decision latency (journal, real runs) | p50 0.040 ms, p95 0.055 ms                                              | < 50 ms   |
| UI local actions (e2e, in page)              | p95 ≤ 19 ms for palette, tabs, node detail, plan edit, language         | < 100 ms  |
| Accessibility                                | axe WCAG 2.2 AA: 0 violations on 12 screens, both themes                | 0 serious |
| Cost band contains the real cost             | calibrated 89 %, cold start 3/3 (mock benchmark, in CI)                 | ≥ 80 %    |
| Cold-start cap ÷ likely cost                 | median 2.98                                                             | ≤ 3       |
| Tests / coverage                             | 1,281 unit and integration tests; lines 97.6 %, branches 90.8 %; 20 e2e | > 80 %    |
| CI                                           | green on Windows, Linux, macOS, e2e job and desktop build               | green     |

## Three key decisions

1. **The approved cost is the maximum, and it is enforced (D-021).** The band's top is what the user approves, what the budget gate checks and the hard cap the kernel applies; node budgets are caps too. The band was rebuilt from history until it actually contains real costs.
2. **Every write is seen and confirmed on its own (review F1, F3).** One confirmation per patch; unreviewed model output may only create new Markdown documents, never code, configs or agent instruction files.
3. **KP Studio serves every field through data, not forks (D-018, D-019, D-020).** Domain packs adapt planning, workspaces and zones; packs from a repository can only tighten safety.

## Lessons

- CI was red on Windows and macOS for several pushes before the PO looked. The rule "check CI for the exact commit before reporting" was broken again; scheduled CI re-checks now follow every push.
- The e2e suite found four real defects (an unexplained review node, a cost band that never contained the real cost, a cap below the band, a test provider shown as paid cloud). Testing in a real browser on a real kernel paid for itself.
- The independent review again found what 1,200 green tests had not: one approval silently covering a second diff.

## Next: phase 4 (memory and learning)

Three-layer memory with provenance, automatic grading, bench, competence learned from outcomes in each repository (R-401), published estimate accuracy (R-402), replay and fork (R-403), verification ROI and disagreement surfacing (R-404, R-405), honest productivity metrics (R-406).
