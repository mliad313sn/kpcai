# KP Studio: Simplicity Charter

Author: S10 (D-027) · 2026-10-23 · Status: proposed to the PO. Once adopted, it becomes a gate criterion that the independent reviewer checks (charter §4). Rationale is in [SCOPE-REVIEW.md](SCOPE-REVIEW.md) §2.2, §2.8 and §4.

> KP Studio is for anyone, for any purpose. A feature that a beginner cannot meet safely, or that an expert cannot reach quickly, is not finished.

## 1. The tests every feature must pass

A feature passes **all four** tests, or it ships hidden in the expert tier, or it does not ship. The reviewer records the result in the phase review register.

| Test                | Rule                                                                                                                                                                                                                       | How to check                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **One sentence**    | The feature's purpose fits in one sentence of at most 20 words, using only the tier-1 vocabulary (§3). Example: "Undo puts your files back the way they were before this task."                                            | The sentence is the first line of its help text, in French and English           |
| **Three clicks**    | From any screen, each core job (§2) takes at most 3 interactions. **Stop everything** takes 1. A keypress counts as one interaction                                                                                        | Playwright e2e counts interactions; TUI test counts keypresses                   |
| **Safe if ignored** | A user who never touches the feature is safe and still gets a useful result. Its default never spends beyond the shown cap, never writes outside a worktree or confirmation, and never sends data a zone or policy forbids | Default-config test in CI                                                        |
| **One in, one out** | The change names what it removes or hides from the default experience (D-027). If nothing can go, the PO must record why in DECISIONS                                                                                      | PR or work-package template field; reviewer checks the ledger in SCOPE-REVIEW §4 |

## 2. Core jobs (the three-click set)

1. Ask for something and see the plan and its cost.
2. Approve, or change one thing, then run.
3. See what it is doing and how much it has spent.
4. Answer a question KP is waiting on.
5. Get the result: open, save or apply it.
6. Undo the last change.
7. **Stop everything.** One action, always visible, including a single kill for a whole portfolio.

## 3. Progressive disclosure tiers

The tier is a per-user setting with a visible switch. The default is **Beginner** on first run, and **Regular** after 5 finished tasks with an offer the user can decline. Nothing in a lower tier depends on understanding a higher one.

| Tier                                               | Who                          | Vocabulary budget                                                                | What is visible                                                                                                                                                                                                | What is hidden                                                                                                                                              |
| -------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Beginner** (students, non-developers, first day) | Anyone                       | **7 words:** _task, plan, cost (likely / at most), check, approve, undo, result_ | Conversation view; plan as a short list; cost "likely $X · at most $Y"; one assurance label per result (V0–V3, shown as "not checked", "checked by another AI", "checked + tested", "you checked"); Stop; Undo | Graph view, models, protocols, criticality, fallbacks, memory layers, packs (auto-detected silently), replay and fork, stats, programs                      |
| **Regular** (daily users)                          | Developers, makers, analysts | + _model, step, review, memory, pack, run, program, budget_                      | Task graph (collapsible to conversation), "why this model" one-liner, runs manager, memory editor, packs list, replay, simple programs (one-team charter), asks inbox, energy range                            | Score breakdowns, routing weights, protocol choice per node, envelope details, departments, source policies, subscriptions, canary and exploration settings |
| **Expert** (power users, admins, pack authors)     | Leads, platform owners       | Full glossary                                                                    | Everything: protocols, criticality, review-policy table, departments, escalation lines, source policies, quotas, velocity, raw journal, `kpai x …` verbs                                                       | Nothing, but each expert control still names its default and its safe range                                                                                 |

**Rule.** Moving a feature _down_ a tier (toward beginners) requires passing the one-sentence test at that tier's vocabulary.

## 4. Safe and useful defaults

These are the defaults in force. Changing one needs a PO decision with rationale.

| Area          | Default                                                                                                                               | Why                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Cost          | The approved figure is the band top, enforced (D-021); confirmation above the threshold; a velocity cap on unattended portfolios (R3) | No surprise bills                  |
| Writes        | Isolated worktree; one confirmation per patch; checkpoint before every write                                                          | Everything is undoable             |
| Review        | Code and files reviewed by another provider (principle 2); disputes fail closed                                                       | Verification is the product        |
| Data          | Local first; credential zones immovable; outbound notifications content-free (R4)                                                     | Privacy by default                 |
| Program mode  | One-team charter (R7); `isolated-only`; no pre-answers; envelope expires in 14 days; API and local sources only when unattended (R1)  | Delegation stays bounded           |
| Silence       | No answer = no action                                                                                                                 | Fail-safe                          |
| Profile       | `balanced`. `economy` for the learning and regulated packs, and whenever only local models exist                                      | Matches A-016                      |
| Notifications | Only on an ask, an incident, a gate or the heartbeat                                                                                  | Attention is the scarcest resource |
| Language      | The system locale; French and English complete                                                                                        | D-020                              |
| Telemetry     | Off. Nothing leaves the machine without an explicit opt-in                                                                            | Local-first promise                |

## 5. Levels of automation, stated once

This is shown in the help as a table, so nobody has to guess who decides. Based on Parasuraman, Sheridan & Wickens (2000).

| Stage   | KP does alone                                                            | KP proposes, you decide                                        | Only you                                                                                                            |
| ------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Gather  | Read the project inside its zones                                        | Read a relaxed zone (pack)                                     | Credential files: never read                                                                                        |
| Analyse | Plan, route, estimate, review                                            | —                                                              | —                                                                                                                   |
| Decide  | Fallback within the cap; low-risk writes in a worktree (if pre-answered) | Merge, extra spend within the envelope, disputes, memory facts | Widen the envelope, spend beyond it, publish, licences, credentials, default branch, physical or irreversible steps |
| Act     | Write in the run's worktree                                              | Apply to your files                                            | Anything outside the machine's policy                                                                               |

## 6. Anti-feature list

KP Studio will **not** ship the following. Proposing one needs a Sponsor decision.

1. **No bypass mode.** No flag, setting or environment variable disables zones, the jail, the cap or confirmation of destructive steps (R-605). No "YOLO" or "skip permissions" mode.
2. **No "approve all"** for consequential items, and no auto-approve on timeout. Silence is always "no".
3. **No markup on tokens and no hidden default model.** The router's choice is always explained (principle 1).
4. **No "time saved" or "productivity ×N" claims** that the journal cannot compute.
5. **No engagement mechanics:** streaks, badges, leaderboards of usage, nudges to run more tasks, notification bait.
6. **No human-named agent personas** that suggest an agent can be accountable. Roles are functional (builder, reviewer).
7. **No popularity reputation** (stars, downloads) for packs or models. Reputation comes from verified outcomes only.
8. **No auto-install** of tools, packs or MCP servers. Suggestions only.
9. **No notifications without an ask, an incident or a gate,** except the liveness heartbeat.
10. **No telemetry on by default,** and no dark-pattern consent flows.
11. **No unbounded autonomous loop.** Every unattended activity has a cap, a velocity limit and an expiry.
12. **No new setting without a safe default and a one-sentence explanation.**
13. **No colour-only or motion-only information;** reduced motion respected.
14. **No feature that only works with one provider's account** when a provider-neutral path is possible.

## 7. Enforcement

- **Work-package template:** fields _one-sentence purpose_, _tier_, _what it removes or hides_, _default_.
- **CI:**
  - e2e interaction counts for the 7 core jobs;
  - a default-config safety test;
  - a lint that keeps tier-1 UI strings within the tier-1 vocabulary (a list in the i18n catalogue);
  - axe on every view.
- **Gate review:** the independent reviewer checks §1 for every new user-visible feature. A failed test is a **Medium** finding, and a **High** one when it breaks "safe if ignored".
- **Yearly prune:** the PO lists features with under 2 % use among opting-in users (from local, opt-in counters only) or that fail §1 today, and removes or demotes them.

## 8. One in, one out: ledger

The ledger started in [SCOPE-REVIEW.md](SCOPE-REVIEW.md) §4. Entries from phase 5 onward are kept here.

**PO note (D-035, finding P5-F5, 2026-10-29).** The console now has the §3 tiers: Beginner (the default on first run), Regular and Expert. The tier is kept per viewer in browser storage (Beginner when storage is unavailable). It is set from a visible "Level" switch in the header and from the command palette, in French and English.

| Added to the default experience                                                    | Removed or hidden from the default experience (Beginner)                                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| The "Level" switch (Beginner, Regular, Expert)                                     | The Workspace / Enterprise switch and Alt+E, until a program exists or the user picks "Delegate a whole project"; then it stays |
| One palette entry, "Delegate a whole project"                                      | The palette's "Show the Enterprise view", "Go to Tools & skills" and `/tools` entries                                           |
| "Stop everything" in the header whenever a program runs, on every tier             | The Tools & skills tab (shown from Regular)                                                                                     |
| Beginner labels for the view switch: "My tasks", "Delegated projects", "questions" | The org map's team / departments toggle and the score breakdown table (shown in Expert only)                                    |

Not yet done: the offer to move to Regular after 5 finished tasks (§3), and the tiers in the terminal client.
