# Phase 5 gate review register

Reviewer: an independent sub-agent that built none of phase 5, appointed by the PO under charter §4.
Wave 1 security pass by S7 at a6f2ba9 (D-032). Gate review at 75de5e8: **HOLD** (D-035). Fixes: f0c386e. Re-verified at f0c386e: **PASS-WITH-NOTES**. Closure fixes: D-036.
Process: review → PO disposition → fixes by S1, S6 and S7, each with a test that fails without it → re-verification with bypass attempts and 21 mutation checks → closure fixes, each mutation-checked.

## Gate review (at 75de5e8): 2 High, 3 Medium, 3 Low

| ID    | Sev.   | Finding                                                                                      | Fix                                                                                                                              |
| ----- | ------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| P5-F1 | High   | Stop everything and program stop from another process never cancelled the daemon's live runs | Run guard on every tick and a 250 ms timer cancels, pauses or resumes the daemon's own runs; journaled (S1)                      |
| P5-F2 | High   | Spend past the accepted cap and `test.run` counted as trivial, batch-approved unseen         | `confirm.overcap`, `.unbounded`, `.exec`, `.outside`, `.control` are consequential, never batched, counted as rubber stamps (S7) |
| P5-F3 | Medium | Source policy and gate independence checked against the plan only                            | Policy reaches the run's routing; settlement records providers used; a breach fails closed and escalates (S1)                    |
| P5-F4 | Medium | V2 could be earned with no test (the run rewrote its own test command)                       | Tampered runs earn no V2, grade or DVO; an unchecked pass proves nothing (S7, PO)                                                |
| P5-F5 | Medium | No Simplicity Charter tiers; the Enterprise view shown to every user                         | Beginner, Regular, Expert; Enterprise hidden for beginners until a program exists or they delegate; Stop always visible (S6)     |
| P5-F6 | Low    | Gate record hard-coded "no open Critical/High"                                               | No machine claim; the report says the Sponsor decided (S1)                                                                       |
| P5-F7 | Low    | `kpai program` marked only false reports                                                     | "verified" only for a delivery; "not a delivery" otherwise (S1)                                                                  |
| P5-F8 | Low    | Progress safeguard counted V1 as verified for code                                           | V2 for code, V1 for documents (S1)                                                                                               |

## Re-verification (at f0c386e): PASS-WITH-NOTES

All four original probes fail to reproduce; 21 of 21 fix reversions make tests fail; `pnpm check`, `pnpm e2e` (56) and demos 0–5 pass.

| ID    | Sev.   | Finding                                                                                   | Disposition                                                                                                                                   |
| ----- | ------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P5-R1 | Medium | A kill or stop did not reach a question the run was waiting on (open up to an hour)       | Fixed at closure: the guard and the gate's poll expire the question, the wait resolves no, a late yes is refused; pause holds it (S1)         |
| P5-R2 | Medium | Tamper check bypassed via a transitive runner file, `.npmrc` and an ignored runner binary | Fixed at closure: runner-side files followed transitively, package-manager configs, ignored files scanned; unverified runner earns no V2 (S7) |
| P5-R3 | Low    | A pack's zone relaxation became a trivial ask                                             | Fixed at closure: `zoneRelaxation` fact, rule `confirm.zone`, consequential and never pre-answered (S1)                                       |

Notes kept for later: code under test can still forge a pass from inside the runner's process (the critic reads the diff); JavaScript V2 needs trusted dependency installation (B-44); remaining wave 1 Lows (B-34).
