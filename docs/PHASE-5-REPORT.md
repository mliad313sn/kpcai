# Phase 5 report — Tools, extensions and Enterprise mode

**Date:** 2026-10-29 · **Scope:** `docs/BUILD_PROMPT.md` phase 5, R-501, R-502, R-505 (Must), the phase 5 rows of [design/ENTERPRISE-MODE.md §17](design/ENTERPRISE-MODE.md), and the S10 recommendations adopted in D-029 · Plan: [plans/phase-5.md](plans/phase-5.md)
**Demo:** `node scripts/demo-phase5.mjs` (offline: goal → charter → Sponsor approval → headless daemon runs work packages → crash and restart without double spend → an escalation answered with the evidence opened → report with assurance labels → snapshot and heartbeat) · **E2E:** `pnpm e2e`
**Team:** PO; S1 kernel contracts, extensions, Enterprise runtime; S2 reports and channels; S4 external agents and source fallback; S5 MCP pins, test runner, browser; S6 KP Studio views and tiers; S7 security review and fixes; S8 north star and cross-package tests; S10 consultant (D-027); independent reviewer.
**Gate:** wave 1 security pass (D-032: 2 High, 7 Medium fixed) → gate review HOLD (D-035: 2 High, 3 Medium, 3 Low) → fixed → re-verification **PASS-WITH-NOTES** → 2 Medium and 1 Low fixed at closure (D-036). Register: [review/PHASE-5-REVIEW.md](review/PHASE-5-REVIEW.md).

## What works

| Capability                                                                                                                                               | Where                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| MCP servers from an allow-list, pinned by version and tool hash; a changed tool blocks calls until re-approved; per-server egress allow-list             | `packages/tools`, ADR-0032                        |
| `test.run` with parsers; failing tests turn an approval into a revision; a run that changed how its tests run earns no "verified"                        | `packages/tools`, ADR-0032                        |
| Driven browser on local Chromium: loopback and workspace files by default, other origins allow-listed and confirmed, redirects cannot leave the policy   | `packages/tools/src/browser`                      |
| Skills (SKILL.md), named agents and hooks that only narrow; hooks veto through the bus and fail closed; local tickets                                    | `packages/kernel/src/extensions`, ADR-0033        |
| Agent CLIs (Claude Code, Codex, Gemini CLI, opencode) as node authors in a private clone under the user's login, cross-provider critic, interactive only | `packages/providers/src/agents`, ADR-0034         |
| Program and Enterprise mode: charter bound to its hash, delegation envelope, Sponsor inbox where silence is no, `kpai program`                           | `packages/program`, ADR-0031                      |
| Headless daemon: durable queue, restart-safe, Stop everything and stop or pause from any process reach live runs and their open questions                | `packages/enterprise`, ADR-0035                   |
| S10 safeguards: heartbeat, dead-man endpoint, watchdog, $/hour cap, no-progress pause, 14-day envelope expiry, V0–V3 labels, evidence before a yes       | `packages/enterprise`, `packages/program`         |
| Model sources local, API and subscription with policies that only narrow, enforced in the run and checked against the providers actually used            | ADR-0034, ADR-0035                                |
| Executive reports in a fixed order with evidence on every claim; notifications without project text, third-party channels off by default                 | ADR-0036                                          |
| North star (Durable Verified Outcomes per week) and guardrails G1–G6 from the journal only                                                               | `packages/learning`, `docs/metrics/NORTH-STAR.md` |
| Enterprise view (web and terminal), Beginner/Regular/Expert tiers, FR and EN                                                                             | `apps/studio`, `apps/studio-tui`                  |

## What does not work yet

- **Nothing validated against live providers** (Q-2). Agent CLI flags and the provider-terms claim behind "subscriptions are interactive only" are unchecked (B-32).
- **Program work does not yet count as a Durable Verified Outcome**: worktrees are not merged by the program (`program.merge`, B-35) and no CI evidence source feeds the daemon (B-39).
- **JavaScript runs that install their own dependencies cannot reach V2**: the runner is then unverified. The kernel should install from the lockfile before the baseline (B-44).
- **No OS sandbox yet**: egress is enforced for servers that respect the proxy, and project code runs after a confirmation (phase 6).
- Terminal tiers, durable outbox, energy coefficients (B-40..B-42).

## Measurements

| Measure                       | Value                                                                                             | Target    |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | --------- |
| Tests / coverage              | about 2,080 unit and integration tests; lines about 98 %, branches about 90 %; 56 e2e             | > 80 %    |
| Accessibility                 | axe WCAG 2.2 AA, 0 serious or critical on the Enterprise, Tools and beginner screens, both themes | 0 serious |
| UI local actions (Enterprise) | p95 ≤ 21 ms, 500 seats windowed                                                                   | < 100 ms  |
| Mutation checks               | more than 200 safety properties reverted one by one across the phase, all caught                  | all       |
| Restart                       | SIGKILL mid-run then restart: no double spend, no silent run (real daemon test)                   | 0         |

## Three key decisions

1. **Unattended means narrower, never wider (D-029, D-035).** The envelope pre-answers only in-envelope budget and in-worktree writes; spend past a cap, project code, outside writes, control files and zone relaxations are consequential and need the evidence opened; subscription agents never run unattended.
2. **Evidence over claims.** "Verified" needs CI for the exact head plus real tests; a run that changed how its tests run, or a pass that could not be checked, proves nothing; the north star counts human intents, so splitting work cannot inflate it.
3. **Simple by default (Simplicity Charter).** One small team by default, departments for experts, the Enterprise view hidden for beginners until they delegate, and Stop everything always one click.

## Lessons

- Two reviews found what about 2,000 green tests had not: a stop that did not reach another process, and a "trivial" label on spend past the cap. Cross-process and classification paths now have dedicated tests.
- Several CI failures were platform details in test fixtures (Windows paths and shells, notification races). Fixtures now use canonical paths and script files, and the UI store marks a run settled only when its final data arrived.
- Shared trees with several seats need one owner per file and a PO verification of the combined tree before every commit.

## Next: phase 6 (hardening and market readiness)

OS sandbox and egress jail, key vault, encryption at rest, audit export, remote approvals (R-6E1..R-6E6), packaging and signing setup, performance, the backlog items B-30..B-44, and live-provider validation once Q-2 is answered.
