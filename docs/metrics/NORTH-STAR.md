# North star and guardrails (S10, B-28)

Owner: S8 · Implementation: `packages/learning/src/north-star.ts`, `dvo.ts`, `deliverables.ts`, `intents.ts`, `guardrails.ts`, `guardrails-live.ts` · Since phase 5 · Proposal: [consulting/METRICS-NORTH-STAR.md](../consulting/METRICS-NORTH-STAR.md)

Like [PRODUCTIVITY.md](PRODUCTIVITY.md), every figure here is computed **from the journal only**. When the journal cannot show something, the report says `not measured` and lists why (`notMeasured`). Nothing is estimated.

API: `northStar(journal, { project, since?, now?, durableWindowMs?, verify? })`. Surfaces: `kpai stats --north-star [--since <date>]` and protocol `stats.northStar { since?, detail? }`.

**Campbell's law.** Humans read these numbers. No planner, router or assistant gets them as an objective or a reward.

## Journal fields (B-28)

| Id  | Field                                                                                                                                                         | Written by                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| J1  | `run intent {runId, intent: {id, origin}, unattended}`. Programs: `charter-wp:<hash>`. A typed request: `human-request`, id = run id. A ticket: `ticket:<id>` | kernel `run.ts` (`runIntent`); enterprise starter; CLI `ticket run` |
| J1  | Forks inherit the parent's intent through `run started.parent` (read time). Unattended runs without an intent name none                                       | orchestrator `run started`                                          |
| J2  | `confirmation answered {runId, kind, risk, consequential, answer, askedAt, answeredAt, viewed: 'diff' \| 'none'}`, never the question text                    | kernel `asks.ts` (questions of a run)                               |
| J2  | `sponsor answer {askedAt, answeredAt, viewed, viewedAt, class}` and `evidence viewed {ref}`                                                                   | enterprise `sponsor.ts` (S1, wave 2)                                |
| J3  | `images: {file: {pre, post}}` SHA-256 or `null` (absent), on `git.apply` and `fs.write` `meta`, and on `merge-back`                                           | tools `builtins/images.ts`; kernel `workspace-ops.ts`               |
| J4  | `energyWh: [low, high]` on `response` events                                                                                                                  | **not written yet**: G6 says "not measured"                         |
| J5  | `enterprise heartbeat {intervalSec, queued, oldestAskAgeSec}`                                                                                                 | enterprise `liveness.ts`                                            |

## North star: Durable Verified Outcomes (DVO)

- **Intent.** The `run intent` of the run. A fork uses its parent's intent. A run journaled before J1 uses its own run key (`proxy`). Only started runs count (`run started` or `run intent`).
- **Deliverable.** An accepted change of `PRODUCTIVITY.md`: a kernel `git.apply` / `fs.write` of a node's output, or a bare `merge-back`, that reached the workspace.
- **Class.** `doc` when every file is a document (`.md .mdx .markdown .txt .rst .adoc .asciidoc .org .tex .html`), or an artifact with no file list. Otherwise `code`.
- **Assurance** of the deliverable's run: `assuranceOf` from `@kernelpai/program`, the same rule as the program reports.
  - V0: the run did not finish cleanly, or a produced node has no approval from another provider.
  - V1: approved last by a critic of another provider.
  - V2: V1, plus a real test run passed and none failed (P4-F10 rules).
  - V3: V2, plus `evidence viewed` names the run.
- **Verified.** `code` needs ≥ V2. `doc` needs ≥ V1 and counts as `DVO-doc`.
- **Undone** within `W = 7 days` of landing:
  - **rolled back**: a restore covering the change (`PRODUCTIVITY.md` rule), at most W after it landed;
  - **reverted** (J3): a later accepted write, at most W later, whose post-image of a file equals this change's pre-image of that file (and the file had changed).
- **DVO.** For each intent, the first deliverable in journal order that is verified and not undone. The intent counts once, ever, on the day that deliverable landed. While that deliverable is younger than W, the DVO is `provisional`.
- **Weeks.** ISO 8601 weeks, UTC. A week is `final` once `now ≥ its Monday + 7 days + W`.
- **Window.** `since` keeps DVO whose deliverable landed at or after it. An intent counted before the window never counts again.
- **Diagnostic.** `v3Share` = V3 ÷ (DVO + DVO-doc). It has no target.
- **Durability label.** `rollback and revert` once any write in the project carries J3 images, else `rollback-only`.

| Gaming move                                     | Why it does not raise DVO (test in `north-star.test.ts`)                 |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| Split a change into more patches, runs or forks | One intent, one DVO ("splitting one intent … never inflates it")         |
| Lenient critic, no tests                        | Code stays V1 ("code needs V2, documents V1")                            |
| Self-review                                     | V0 ("a V0 doc does not count")                                           |
| Accept now, revert tomorrow                     | Undone within 7 days ("a later write back to the pre-image is a revert") |
| Re-deliver an old intent in a new week          | Once ever ("later ones of the intent never count")                       |

## Guardrails (window = runs and events at or after `since`)

| #   | Figure                                                                                                                                                                                                                                                                                                                                                                                                                                      | Breached when (initial thresholds, METRICS-NORTH-STAR §2) |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| G1  | `costPerDvoUsd` = `spentUsd` (as PRODUCTIVITY.md: every event of the window's runs) ÷ (DVO + DVO-doc). `band` = PRODUCTIVITY.md `band.rate`. `capToLikelyMedian` = median over planned runs of `estimate.capUsd ÷ estimate.expectedUsd`                                                                                                                                                                                                     | `band.rate < 0.80`; `capToLikelyMedian > 3`               |
| G2  | `asks` = `confirmation answered` + `sponsor answer` + `question expired`. `asksPerDvo` = asks ÷ (DVO + DVO-doc). `medianAskAgeMs` = median(answeredAt − askedAt). Rubber stamp: among consequential yes answers, those never viewed (`viewed` false / `none`), or answered < 3 s after the view (`viewedAt`, or `askedAt` when the diff was shown with the question)                                                                        | rubber-stamp rate ≥ 10 %                                  |
| G3  | (a) Started runs with no `run outcome` and no `run interrupted` whose last event is older than 30 min stall + 15 min grace, ÷ started runs. Inside that time they are `open`. (b) `watchdog alert` followed within 15 min by an intervention named `report …`, `notification …` or `notice …`. It is `null` when the journal has none of those. (d) Consecutive `enterprise heartbeat` more than 2 × the earlier beat's `intervalSec` apart | (a) ≥ 1 %; (b) any unfollowed; (d) any gap                |
| G4  | Accepted deliverables that landed in the window and were undone (rolled back or reverted) within W, ÷ those deliverables, overall and per assurance label                                                                                                                                                                                                                                                                                   | V2 escape rate ≥ 10 %                                     |
| G5  | Each must be 0. **Applied kernel writes with no `checkpoint`** in their session since the previous write, plus `merge-back` without `checkpoint`. **Unattended runs** (J1) whose outcome `sources` include `subscription`, or with an `agent run`. **Spend `pre-answered`** with no `amountUsd`. **`Journal.verify()`** broken: 1. It is `null` when not run                                                                                | total > 0                                                 |
| G6  | Σ `energyWh` ranges of `response` events ÷ (DVO + DVO-doc). Without J4 data: `measured: false`, never a guess                                                                                                                                                                                                                                                                                                                               | — (trend only)                                            |

Ratios are rounded to 4 decimals and money to 6. A ratio with a zero denominator is `null`, never 0.

## Not measured yet (listed in every report)

- **G1 trend** (cost per DVO rising 4 weeks in a row): needs 4 weeks of baseline.
- **G3 (c)** programs `delivered` with `verified = false`: this is in the program store (`report.ts`), not in the journal.
- **G5** zone content sent to a cloud provider: refused before the call, so never journaled.
- **G5** envelope `allow` outside caps: re-checked against the program store.
- **G5** scope or physical packs in unattended runs (R13): pack effects are not journaled.
- **G4 reverts** before J3 existed (`rollback-only`). **G3 (b)** until reports and notifications are journaled (WP5). **G6** until J4.

## Limits

- `viewed: 'diff'` on an interactive confirmation means the exact diff or content was shown with the question (every client shows it). It does not prove anyone read it; the 3-second rule is what catches stamps. A client-side `viewed` report is B-37.
- A question asked outside a run (workspace guard, memory, scope) has no session and is not journaled (J2).
- Reverts done outside KP Studio, or by a write that is not a kernel write, are invisible.
- Program work packages count only once `program.merge` (B-35) merges their worktree: until then, a WP intent has no accepted deliverable.
- The report reads the last 100 000 journal events (`limit`), like the competence store.
