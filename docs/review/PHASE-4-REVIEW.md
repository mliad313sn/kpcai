# Phase 4 gate review register

Reviewer: an independent sub-agent that built none of phase 4, appointed by the PO under charter §4.
Reviewed: e744643 and the phase 4 tree (verdict HOLD). Fixes: 5864258 (D-024). Re-verified at 5864258: **PASS-WITH-NOTES**. Closure fixes: D-030.
Process: review → PO disposition (D-024) → fixes by S1, S3, S6 and S7, each with a test that fails without it → re-verification with bypass attempts and 20 mutation checks → closure fixes, each mutation-checked.

## Initial review: 2 High, 4 Medium, 6 Low

| ID  | Sev.   | Finding                                                                      | Fix                                                                                                           |
| --- | ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| F1  | High   | Repository memory could forge provenance and trust in prompts                | Attributes validated and escaped; repository facts always `source=repository`, untrusted, screened again (S7) |
| F2  | High   | Replay and fork ignored the run's routing constraints (local-only, excludes) | The run journals its routing; replay and fork apply it as a floor; options can only tighten (S1)              |
| F3  | Medium | Local-only facts could reach the cloud through a later node                  | Taint: critics and dependents of a tainted node stay local or fail closed; exact text redacted (S7)           |
| F4  | Medium | Replay and fork could read another project's runs                            | Same project only, compared after realpath; otherwise `not_found` (S1)                                        |
| F5  | Medium | Replay spent before showing its cost and could not be cancelled              | `run.replayPlan` shows likely and cap; cancellable; CLI and console ask first (S1, S6)                        |
| F6  | Medium | Replay skipped the authorised-scope gate                                     | Scope admitted on replay like a run (S1)                                                                      |
| F7  | Low    | Zone mentions slipped through punctuation, encoding and case                 | Split, decode and lower-case before matching (S7)                                                             |
| F8  | Low    | Repository facts were not screened against environment secrets               | Redacted against env secret values (S7)                                                                       |
| F9  | Low    | A client could set a grade's author and grade a node many times              | Author set by the server; one manual signal per node (S1, S3)                                                 |
| F10 | Low    | No-op test commands counted as passed tests                                  | Dry runs, list, help, `--passWithNoTests` refused; a pass needs "tests ran" evidence (S3)                     |
| F11 | Low    | A dispute option cut for display could still be chosen                       | An option not shown in full cannot be chosen, in the kernel and every client (S7, S1, S6)                     |
| F12 | Low    | Verification ROI counted raw issues, not revised verdicts                    | Revised verdicts are the headline, raw counts still published (S3, S1, S6)                                    |

## Re-verification (at 5864258): PASS-WITH-NOTES

No original reproduction still works; 19 of 20 fix reversions make tests fail; `pnpm check`, `pnpm e2e` (39) and the phase 4 demo pass; CI green on three OS, e2e and desktop.

| ID    | Sev.   | Finding                                                                             | Disposition                                                                                                                                   |
| ----- | ------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P4-R1 | Medium | Fork and replay dropped the local-only taint; short quotes reached cloud providers  | Fixed at closure: taint journaled per node (derived for old runs); fork and replay seed it and load memory; replay held local or refused (S1) |
| P4-R2 | Low    | A replay's dispute question carried the original run id, so cancel did not close it | Fixed at closure: the question carries the replay id and `replayOf`; cancel closes it (S1)                                                    |
| P4-R3 | Low    | A replay could waive provider diversity without showing it                          | Fixed at closure: refused unless the original run had it; shown in the plan and the dialog when it applies (S1)                               |
| P4-R4 | Low    | Prompt-tag escaping had no test of its own                                          | Fixed at closure: hostile-fact test that fails without the escaping (S1)                                                                      |

Notes kept for later: a fork's estimate prices tainted reruns on cloud models (the run is held local); run lookup scans sessions (B-23); a `disputed` core node state is proposed, not made.
