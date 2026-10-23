# Productivity metrics (R-406)

Owner: S8 · Implementation: `packages/learning/src/productivity.ts`, `changes.ts` · Since phase 4

These metrics are computed **from the journal only**. Nothing is self-reported by a model,
estimated by a vendor or typed in by a person: every number comes from events the kernel,
the tool bus and the runner append to the hash-chained journal, and every counted change
lists its run, node and journal sequence (`report.list`) so it can be audited.

API: `productivity(journal, { project, since?, reworkWindowMs?, limit? })`.
`project` is the workspace path (the session's working directory, as `Journal.spend` uses).
`since` keeps the runs whose first journaled event is at or after that instant.

## Units

- **Run** — a `run outcome` intervention closes it (ADR-0028 §2). Model events of a
  session without an outcome (a `kpai ask`, a killed run) form an unnamed run. Bench runs,
  replays and forks are runs too: what they cost is spent in the project.
- **Change** — one kernel write of a node's output: a `tool` event with provider `kernel`,
  tool `git.apply` (kind `patch`) or `fs.write` (kind `artifact`), on node `<id>#patch-<i>`
  or `<id>#artifact-<i>`. A model's own tool calls are never changes.
  In an isolated run (R-307) the write goes to the run's worktree; it **lands** in the
  workspace with the run's next `merge-back`. A `merge-back` with no kernel write landing
  through it counts as one change of kind `merge` (its `files`).
- **Change status**
  | status      | rule                                                                             |
  | ----------- | -------------------------------------------------------------------------------- |
  | `accepted`  | decision `allow`/`confirmed`, no error, and (isolated run) merged back           |
  | `declined`  | decision `declined`, or the isolated run's `merge-back declined` came first      |
  | `failed`    | any other decision (`deny`, `refused`, …) or the write returned an error         |
  | `pending`   | applied in a worktree, neither merged nor discarded yet                          |
  | `discarded` | applied in a worktree that was discarded (`worktree discarded`) before any merge |

## Formulas

Let R be the runs of the project in the window, A the accepted changes of R.

| metric                         | formula                                                                                                               | null when  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| `spentUsd`                     | Σ `costUsd` of every event of R (calls, failed attempts, replays, bench)                                              | —          |
| `runTimeMs`                    | Σ over R of (ts of the run's last journaled event − ts of its first)                                                  | —          |
| `costPerAcceptedChangeUsd`     | `spentUsd` ÷ \|A\|                                                                                                    | \|A\| = 0  |
| `timePerAcceptedChangeMs`      | `runTimeMs` ÷ \|A\|                                                                                                   | \|A\| = 0  |
| `rollbackRate`                 | \|{a ∈ A : rolled back}\| ÷ \|A\|                                                                                     | \|A\| = 0  |
| `reworkRate`                   | \|{a ∈ A : rolled back, or touched again}\| ÷ \|A\|                                                                   | \|A\| = 0  |
| `review.acceptedFindings`      | Σ over run records of R (reused fork nodes excluded) of `nodeVerification(result).acceptedFindings` (R-404)           | —          |
| `review.usdPerAcceptedFinding` | Σ critic and judge spend ÷ `acceptedFindings`                                                                         | 0 findings |
| `review.revisedVerdicts`       | Σ over the same records of rejecting verdicts answered by a revision on an approved node, one per verdict             | —          |
| `review.majorFindings`         | Σ over those nodes of the distinct major issues of those verdicts (case and spacing ignored)                          | —          |
| `review.usdPerRevisedVerdict`  | Σ critic and judge spend ÷ `revisedVerdicts`: the headline review cost per defect caught                              | 0 verdicts |
| `band.rate`                    | finished, uncancelled runs with a journaled plan whose billed cost is in [band low, band high] ÷ such runs (as R-402) | no run     |

- **Rolled back.** A workspace `restore` intervention that wrote or deleted at least one
  file, of checkpoint `c`, rolls back every accepted change that landed after `c` was
  taken and before the restore (`seq(c) < landed < seq(restore)`). A restore of a
  worktree checkpoint (`…/<run>-wt/…`) never touches the workspace. A restore whose
  checkpoint is not in the journal read is counted in `unattributedRestores` and undoes
  nothing (we do not guess).
- **Touched again.** A later run's accepted change touches one of the same
  workspace-relative files (patch `meta.files`, artifact `path`, merge `files`) within
  `reworkWindowMs` (default 7 days) of the first change landing. Changes of the same run
  never rework each other.
- **Defects caught by review** (R-404 definition, recomputed from the `node recorded`
  events rather than from `run.done.verification`, which is not journaled): the issues of
  rejecting critic verdicts that were followed by a revision, on nodes whose final version
  was approved by a critic or by a human settling a dispute.
  Two figures are published (P4-F12). `acceptedFindings` counts the issues a critic
  listed, so a verbose critic that splits one defect into nine issues counts nine.
  `revisedVerdicts` counts each rejecting verdict once, however many issues it lists, and
  `majorFindings` counts its distinct major issues. Cost per defect is quoted on
  `revisedVerdicts` (`usdPerRevisedVerdict`). `usdPerAcceptedFinding` is kept for
  comparison.

Ratios are rounded to 4 decimals, money to 6.

## What these numbers do not say

- **"Reverted" is approximated.** The journal stores a patch's hash and files, not its
  text, so a later change that reverts a file and one that extends it look the same:
  both count as touched again. This over-counts rework when the user iterates on purpose;
  shorten `reworkWindowMs` to tighten it. A `git revert` done outside KernelPAI is invisible.
- **Time is wall time** of the run as journaled, human waits (budget and write questions)
  included. It is not the human's working time, nor the time the user would have spent
  without KernelPAI; we publish no "time saved" figure, because the journal cannot
  observe it.
- **Accepted is not correct.** A change the human applied can still be wrong; the rework
  and rollback rates are the journal's only later evidence of that.
- A change with no file list (its write journaled no `meta.files`) is never counted as
  touched again. A restore journaled without `written`/`deleted` counts is ignored.
- The report reads the last 100 000 journal events by default (`limit`), like the
  competence store (ADR-0028).

## Where it is shown

- `kpai stats --productivity [--since <date>]` and protocol `stats.productivity`
  (kernel wiring by S1; integration spec in the phase 4 WP5 report).
- The accuracy and productivity view of KP Studio (S6, WP4).
