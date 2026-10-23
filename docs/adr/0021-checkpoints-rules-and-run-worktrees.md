# ADR-0021 — Checkpoints, repository rules and run worktrees in the kernel

**Status:** Accepted by the PO (proposed by S1; phase 3, R-305, R-306, R-307) · **Date:** 2026-10-23

## Context

S5's workspace API (`@kernelpai/tools`, 1aa1125) provides checkpoints on shadow refs,
rule-file ingestion inside the jail, and one git worktree per run. The kernel, the console
protocol and the CLI must use it with the same safety rules as patches (ADR-0019).

## Decision

1. **Rules (R-306).** `plan` reads the rule files with `readRepoRules` inside the jail and
   the zones in force (defaults + `policy.json`). Every node of the run gets them through
   `formatRepoRules` as a leading **`user`** message, never a `system` message, because
   system messages carry KernelPAI's own authority and rule files are repository content
   (`trust: 'untrusted'`). Rules are read with the policy's zone set (`policy.zoneSet()`,
   ADR-0023 / ADR-0025). The node's request stays its last user message, so every step
   (author, critic, voter…) sees the rules. The model planner's calls get the same message
   through a wrapping adapter. The estimate is made on the graph as it will run. The plan
   result, `kpai plan` and the run's `routing` journal entry list the files by name and size
   only, plus the count skipped in forbidden zones (never named).
2. **Checkpoints (R-305).** A checkpoint of the target tree precedes every write the kernel
   makes: each patch, each artifact (ADR-0022) and each merge-back. If a checkpoint fails in a
   git repository, nothing is written. A workspace outside git cannot be checkpointed. The
   write still goes on, because it is confirmed with its diff, and `checkpoint unavailable`
   is journaled. Namespaces: `<runId>` holds checkpoints of the user's workspace, and
   `<runId>-wt` holds those of the run's worktree. A ref therefore names the tree it
   restores.
3. **Restore** is destructive. It goes through the permission policy and then a
   `confirm.request` of the new kind `restore` (risk `destructive`). No answer before the
   timeout means no. A restore is refused while its run is live. Both outcomes are journaled
   as interventions. Protocol: `run.checkpoints {runId}`, `run.restore {runId, ref}`.
   CLI: `kpai checkpoints [--session <id>]`, `kpai restore <ref>`.
4. **Run worktrees (R-307).** The run option `isolated` gives the run its own worktree
   under `$KPAI_HOME/worktrees`. That worktree is the run's jail root and the target of
   `patches.apply` and `artifacts.apply`. The defaults are:
   - **console runs** (`run.start` without `isolated`) are `auto`: isolated when the
     workspace is a git working tree, in place otherwise, which is journaled. Parallel runs
     on one tree are the console's normal case, and D-019 workspaces (GIS, CAD, data) are
     often not git;
   - **the CLI** is opt-in (`kpai do --isolated`). It runs one run at a time, and each write
     is already confirmed at the terminal, so a merge-back would ask twice for the same lines;
   - `isolated: true` without git refuses the run before any spend.
5. **Merge-back** (`run.merge`, `kpai merge`) applies the worktree's diff through the
   git.apply checks. The confirmation is of kind `patch` and carries the whole diff. A
   workspace checkpoint is taken once the human says yes, and before writing. Merge is
   refused while the run is live or when it was cancelled (review P2-F6). `run.discard` /
   `kpai discard` removes the worktree and keeps the checkpoints. Both are journaled.
6. **`runs.list`** is the manager view. For each run it gives the state, the live or final
   cost, whether it is isolated, the worktree, the diff stats, the critic verdict, and the
   counts of patches and artifacts.

## Consequences

- Rule text adds input tokens to every call. Its size is capped by the tools' 96 KB limit,
  and the plan estimate includes it.
- A declined patch still leaves its checkpoint. That is harmless, and it keeps
  "no write without a checkpoint" simple, even when the policy batches writes.
- Runs live in kernel memory, but worktrees and checkpoints outlive the process. The CLI
  verbs work from git and the journal alone.

## Revisit when

Background runs (R-507), a `PlanContext` field for rules in core (instead of the planner
adapter wrap), or worktrees for non-git workspaces.
