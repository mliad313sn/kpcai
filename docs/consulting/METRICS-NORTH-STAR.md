# KP Studio: north-star and guardrail metrics

Author: S10 (D-027) · 2026-10-23 · Status: proposal for the PO and the Sponsor (SD-6). Implementation would extend `packages/learning/src/productivity.ts`, which S8 owns. Every figure here is computed **from the journal only**, like `docs/metrics/PRODUCTIVITY.md`. Fields that do not exist yet are marked **(J1–J5)** and specified in §5.

Lenses: Goodhart (1975) and Campbell (1979) on gaming; Holmström–Milgrom (1991) on multitask incentives; measurement validity (METR 2025; JetBrains 2025: 66 % distrust productivity metrics).

## 1. North star: Durable Verified Outcomes (DVO)

> **The number of human intentions that KP Studio turned into a result that was independently checked, accepted, and still standing a week later.**

This is what every actor wants:

- the user gets work that holds;
- the team gets throughput it can trust;
- pack authors get evidence that their pack helps;
- providers get credit for quality;
- society gets accountable output.

It is also what the product promises: "verification as the product", benchmark W2.

### 1.1 Definition

**Intent (I).** A unit of work fixed by a human, never by a model:

- `human-request`: a request a person typed in the CLI or console (`kpai do`, `kpai plan` then run, the studio command bar);
- `charter-wp`: a work package of a charter the Sponsor approved, identified by `charterHash:wpId` (`program/src/machine.ts approve`, `amend.approve`).

All runs that serve the same intent (retries, fallbacks, redirects, forks, replays) belong to it. **(J1)** Until J1 exists, the proxy is the run id for `kpai do` runs and `wpId` for program runs.

**Deliverable (D).** A kernel write of a node's output: a patch, an artifact, or a merge (the "change" of `PRODUCTIVITY.md`).

**I counts as one DVO, on the day its first qualifying D lands, if all of these hold:**

1. **Accepted.** D's status is `accepted` as defined in `PRODUCTIVITY.md`: an `allow` or `confirmed` decision with no error and, for an isolated run, merged back. A pre-authorised auto-merge (`checkMerge` → `merge.auto`) counts.
2. **Verified.** D's assurance level (SCOPE-REVIEW R5) is:
   - **≥ V2** for code, test and config deliverables: critic approval from another provider with no open major issue, **and** objective evidence (tests that ran under the ADR-0028 P4-F10 rules, or CI green on the exact commit);
   - **≥ V1** for documents, reports, designs and other deliverables with no objective validator. These are reported separately as `DVO-doc`, so the code share stays honest.
3. **Durable.** Within 7 days of landing, D was not rolled back (a `restore` covering it, `PRODUCTIVITY.md` rule) and not **reverted**: a later write restoring a file to D's pre-image hash **(J3)**. Until J3, only rollbacks count, and the figure is labelled "durability: rollback-only".
4. **Once.** An intent contributes at most one DVO, ever.

**Reporting:**

- weekly count per project, as `kpai stats --dvo`;
- _final_ 7 days after the week ends; _provisional_ before;
- the mix (V1 / V2 / V3) and the `DVO-doc` count are always shown beside it;
- for teams (phase 8): per active seat-week.

### 1.2 Why it resists gaming

| Gaming move                                            | Why it fails                                                                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Split one change into many patches or runs             | The unit is the human intent, so it is still 1                                                                                                                                                      |
| The PO assistant splits a goal into more work packages | Work packages are fixed by the Sponsor-approved charter hash. More of them requires an amendment the Sponsor approves (`amend.approve`). The single-run baseline (R10) makes over-splitting visible |
| A lenient critic approves everything                   | V2 also needs objective evidence. Critic recall is measured by canaries (R9). Self-review is ignored (ADR-0028 §6)                                                                                  |
| Tests that test nothing                                | P4-F10 rules refuse no-op runs. Durability catches what slips through, and later mutation evidence (phase 7, opinion)                                                                               |
| Accept now, revert tomorrow                            | The 7-day durability window                                                                                                                                                                         |
| Ask trivial things to pad the count                    | Only a human can create an intent. The metric is for humans to read, not a target for agents. Cost and attention guardrails expose padding                                                          |
| Rubber-stamp to raise "accepted"                       | G2 measures inspection; the V3 share falls                                                                                                                                                          |

**Rule (Campbell's law).** DVO and the guardrails are **never** given to the PO assistant, the planner or the router as an objective or a reward. Gates use evidence (CI, tests, reviews), not these aggregates. Humans read the metrics. Agents do not optimise them.

## 2. Guardrails (six, each computable from the journal)

The north star may rise only while every guardrail holds. A breached guardrail is shown next to DVO in the same colour-independent style (icon plus word).

| #      | Guardrail                                  | Formula (window W)                                                                                                                                                                                                                                                                                                                                           | Initial threshold (opinion; reset after 4 weeks of baseline)                                | Source                                     |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **G1** | **Cost per DVO** and **cost-band honesty** | `spentUsd(W)` (all events: calls, failed attempts, replays, forks, bench, canaries) ÷ DVO(W). Next to it, `band.rate` from `PRODUCTIVITY.md`                                                                                                                                                                                                                 | Cost per DVO not rising 4 weeks in a row; `band.rate ≥ 0.80`; median cap ÷ likely ≤ 3       | Existing (`productivity.ts`); DVO needs J1 |
| **G2** | **Attention load and rubber-stamp rate**   | (a) asks per DVO = confirmations and escalations asked ÷ DVO. (b) Median ask age at answer. (c) **Rubber-stamp rate** = consequential approvals with `viewed = none`, or answered < 3 s after asked, ÷ consequential approvals. Consequential means merge to a user branch, envelope or extra-spend escalations, V0/V1 merges, physical or destructive steps | (a) falling; (b) < 12 h for programs; (c) < 10 %                                            | **J2**                                     |
| **G3** | **Silent-failure rate**                    | (a) Runs with `run started` and no `run outcome` within stall timeout + grace ÷ runs started. (b) Watchdog events not followed by a report within 15 min. (c) Programs `delivered` with `verified = false` (`report.ts`). (d) Heartbeat gaps > 2× interval                                                                                                   | (a) < 1 %; (b) 0; (c) shown, never hidden; (d) 0 undetected in fault-injection tests        | Existing run events; **J5** heartbeat      |
| **G4** | **Escape rate**                            | Accepted deliverables rolled back or reverted within 7 days ÷ accepted deliverables (the complement of durability). Kept beside the existing `reworkRate`, which over-counts iteration                                                                                                                                                                       | < 10 % for V2; tracked by assurance level (V1 vs V2 must differ, or V2 is not adding value) | Existing rollback; **J3** revert           |
| **G5** | **Safety invariants** (must be 0)          | Counts of: zone content sent to a cloud provider; unattended runs with a subscription source without a terms record (R1) or with a scope or physical pack (R13); envelope `allow` verdicts outside caps (re-check of `run.started`); kernel writes without a preceding checkpoint; `kpai verify` failures                                                    | **0**, and any non-zero value pages the user (R2)                                           | Existing events; R1 and R13 rules          |
| **G6** | **Footprint per DVO**                      | Σ `energyWh` range of `response` events (local: runtime × declared device watts) ÷ DVO; share of tokens served locally                                                                                                                                                                                                                                       | Shown as a range; not rising quarter on quarter                                             | **J4**                                     |

**Diagnostic, not a guardrail: the V3 share.** The share of DVO where a human opened the evidence before accepting. It is a weak, honest proxy for human engagement and therefore for skill retention (SCOPE-REVIEW L5). Watch the trend; set no target, because a target would invite clicking without reading.

## 3. What we deliberately do not measure or claim

- **Time saved, or productivity multipliers.** The journal cannot observe the counterfactual, and METR (2025) found perception and reality diverge by about 40 points.
- **Lines of code, tokens, number of agents, runs or programs.** These are effort, not value. They reward bureaucracy (SCOPE-REVIEW L6).
- **Daily active users or session length** as product goals. These are engagement metrics; see the anti-feature list.
- **Model leaderboards** across users without the k-threshold and robust aggregation of ECOSYSTEM §5.

## 4. Use in governance

- **Phase reports** (BUILD_PROMPT "Fin de chaque phase") add DVO, G1–G6 and their trend, measured on the demo fixtures (offline) and, once Q-2 allows, on live dog-fooding.
- **Program reports** (R4) show the program's DVO against its work packages ("4 of 9 work packages durably verified"), cost per DVO against the single-run baseline (R10), and any breached guardrail.
- **Public claims** (Sponsor-reserved) quote only these figures, with their window and caveats.

## 5. Journal additions required

These are proposed for phase 5. They do not touch the phase 4 gate; record them as a backlog item now.

| Id     | Field                                                                                                                                              | Where                                                         | Privacy                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **J1** | `intent: { id, origin: 'human-request' \| 'charter-wp', ref }` on `run started`; forks and replays inherit the parent's intent                     | Kernel `run-record.ts`; program driver                        | Ids only                                                                |
| **J2** | `asked` and `answered` ISO timestamps, `consequential: bool`, `viewed: 'diff' \| 'evidence' \| 'none'` on every confirmation and escalation answer | Kernel confirm queue; console and TUI clients report `viewed` | Local only; never in outbound reports                                   |
| **J3** | `preImage` and `postImage` SHA-256 per file on kernel writes (`git.apply`, `fs.write`, merge)                                                      | Tools workspace ops                                           | Hashes only. Note: hashes of tiny files can be guessed; keep them local |
| **J4** | `energyWh: [low, high]` and `energySource` on `response` events, from descriptor coefficients or local runtime                                     | Executor / providers                                          | None                                                                    |
| **J5** | `heartbeat` intervention from the daemon (interval, queue depth, oldest ask age)                                                                   | Daemon (phase 5)                                              | None                                                                    |
