# Phase 3 gate review register

Reviewer: an independent sub-agent that built none of phase 3, appointed by the PO under charter §4.
Reviewed: 5674d99 (verdict HOLD). Fixes: 1981d65, plus NF fixes at gate closure. Re-verified at 1981d65: **PASS-WITH-NOTES**.
Process: review → PO disposition (D-022) → fix by four seats, each fix with a test that fails without it → re-verification with bypass attempts and mutation checks.

## Initial review (at 5674d99): 1 High, 5 Medium, 5 Low

| ID  | Sev.   | Finding                                                                         | Fix                                                                                                                                                  |
| --- | ------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | High   | One confirmation applied all of a node's patches; only the first diff was shown | Each patch is its own write batch; kernel, CLI and console tests expect one confirmation per diff (S1)                                               |
| F2  | Medium | A run could still write after a cancel, through a pending confirmation          | Bus re-checks the abort after the answer; cancel declines pending and queued questions (`confirm.closed`); console and TUI drop the dialogs (S1, S6) |
| F3  | Medium | An unreviewed "document" could be any file (`package.json`, code)               | Unreviewed documents: new Markdown files only, no hidden folders, no agent instruction files, never an overwrite (S7, S1)                            |
| F4  | Medium | A repository pack could take over a built-in id and ask for zone relaxations    | Repository packs cannot reuse an id; their relaxations are ignored; repository text is quoted and labelled untrusted (S7; ADR-0025 addendum)         |
| F5  | Medium | The per-node budget was shown as a cap but not enforced                         | `budgetUsd` is a node cap, always asked by a person through the budget gate (S4, S1)                                                                 |
| F6  | Low    | `run.start` accepted waivers the plan never showed                              | `overBudget` and `allowSameProvider` come from the approved plan only; `overBudget` removed from the console protocol (S1; ADR-0019 addendum)        |
| F7  | Low    | Merge of a cancelled run was refused only while in memory                       | Outcome journaled and read for merge; restore refused during an in-place run and when the tree changed while the human answered (S1, PO)             |
| F8  | Low    | Redirect checked against the expected cost, not the band top                    | Checked against the band top, both figures shown (S4)                                                                                                |
| F9  | Low    | No regression guard for confirmation serialisation (P2-F7)                      | Kernel test; fails when serialisation is removed (S1)                                                                                                |
| F10 | Low    | The console followed `ws=` to any loopback port                                 | `ws=` only to the page's own origin or the desktop shell (S6)                                                                                        |
| F11 | Low    | Exit-criterion gaps: R-307 concurrency, CLI locale, R-303 comparison            | Two isolated runs through the kernel; CLI in French and English; R-303 comparison accepted as NF-3                                                   |

## Re-verification (at 1981d65): PASS-WITH-NOTES

All four original reproductions fail to reproduce; every fix fails a test when reverted; bypass attempts (answer/cancel race, extension and case tricks, lookalike pack ids, other run-time flags) did not reopen a finding. `pnpm check`, `pnpm e2e` (20 tests, axe 0 violations), the four demos and CI on Windows, Linux and macOS are green.

| ID   | Sev. | Finding                                                                 | Disposition                                                                                                         |
| ---- | ---- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| NF-1 | Low  | A node id with a space escaped the node-cap question (label parsing)    | Fixed at closure: ids are `[A-Za-z0-9_-]` in the protocol and plan validation; the gate matches any id; tests added |
| NF-2 | Low  | `AGENTS.override.md` and `memory-bank/` notes could be saved unreviewed | Fixed at closure: added to the agent-file list; test added                                                          |
| NF-3 | Low  | R-303 e2e compares with the kernel plan, not `kpai route --verbose`     | Accepted (same data source); backlog B-21                                                                           |

Notes kept for later (no action required at the gate): unreviewed `<nodeId>.md` collides on re-runs (B-22); merge reads up to 500 sessions to find an outcome (B-23); a refused restore leaves an extra undo checkpoint (harmless).
