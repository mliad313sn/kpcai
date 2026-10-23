# ADR-0029 — Run records, replay, fork, fail-closed disputes and review policy

**Status:** Accepted by the PO (phase 4 WP3, implemented by S4 in e744643) · **Date:** 2026-10-23

## Context

Spec §3.5 asks to replay a node with another model and to fork from any node. R-404 asks for a
review-spend policy and verification ROI, and R-405 asks that disagreement be surfaced rather than
silently resolved. Before phase 4, the journal recorded calls and events, not the exact inputs a
node ran with. A replay could therefore not be faithful.

## Decision

1. **Run records.** The runner journals:
   - `run started`, with the run id, the graph as it will run, and the parent and reused nodes of a fork;
   - one `node recorded` per finished node, with its exact messages (rules and memory included), effective protocol, upstream outputs, full result and duration.

   `readRun(journal, runId)` rebuilds the run from these records. Readers of interventions (export, UI history) filter these record actions out: the payloads are large and hold node messages.

2. **Replay** reruns one finished node from its recorded inputs, with another model or protocol, beside the original and never replacing it.
   - It goes through the same step runner, so budget gate, cap, routing constraints and critic diversity all apply, and code nodes stay author+critic.
   - The result is a side-by-side comparison: output, cost, duration, verdicts.
3. **Fork** starts a new run from any node of a past run.
   - Finished upstream outputs are reused as recorded and not billed again.
   - The chosen node, its descendants and any unfinished node are re-routed and re-estimated, with an optional edit (model, protocol, instruction).
   - The estimate covers only what will run, and the fork is gated on the band top like any plan (D-021).
4. **Disputes fail closed.** A node is disputed in any of these cases:
   - a vote has no clear majority (more than half of ballots and of competence weight);
   - critics are still split after the last revision;
   - judges disagree.

   The human picks an option through a dedicated `dispute` hook (a yes/no confirmation cannot choose among options). No hook, no answer, a rejection or a cancel all leave the node failed, with no deliverable, patch or artifact. Option text is untrusted model output and is shown quoted.

5. **Review policy.** Review depth is mapped from criticality: `none | critic | critics | debate | vote`. Code, test and file deliverables never go below one critic from another provider (principle 2). Extra reviewers come from new providers; when none is left the node runs with fewer, and this is journaled.
6. **Verification ROI.** Each run reports review spend, its share of the total, the findings that led to an accepted revision, and the cost per accepted finding. Reused fork nodes are excluded.

## Consequences

- A tied weighted vote is no longer broken silently; it becomes a dispute that a person settles.
- `readRun` scans recent sessions. An index by run id is backlogged together with B-23.
- Proposed core change, not made: a `disputed` node state and a `node_disputed` graph event. Today disputes travel on the control feed and in the run result.

## Addendum (kernel and protocol wiring, S1)

- The kernel exposes a `choose` host callback that shares the single question queue with
  `confirm`, so only one question is open at a time.
- Over the console protocol, `confirm.request` has kind `dispute` and a `dispute` field with the
  options, and `confirm.answer` carries `choice`.
- Only one of the offered option ids settles a dispute. A plain yes without `choice`, an unknown
  id, silence, a cancelled run or no client all reject, so the node fails closed.
- The CLI shows each option quoted and sanitised, then asks for each option in turn.
- `run.replay`, `run.forkPlan` and `run.fork` go through the normal budget gate and cap.
- Reused fork nodes offer no patches, artifacts or memory proposals again.
- Run records never appear in the history, in `kpai log` or in the Markdown export.

## Addendum (phase 4 review, D-024: P4-F2, F4, F5, F6)

Status: proposed by S1, for the PO.

- **The run's routing is a floor (P4-F2).** `run started` now journals `routing`:
  `localOnly`, `exclude`, the resolved `profile` and `allowTest`. A replay and a fork apply it
  as a floor. `localOnly` stays on. Excluded providers stay excluded, and the given ones are
  added. Test providers stay refused if the run refused them. The run's profile applies
  unless one is given. Options can only make routing stricter. A pinned model outside the
  floor is unroutable. A run journaled before this change has no record, so its replays and
  forks use the options as given. `run.replay` and `run.forkPlan` take optional `options`.
  The CLI passes `--local-only`, `--exclude`, `-p` and `--scope` to `kpai replay` and `kpai fork`.
- **Only runs of this project (P4-F4).** The run's session `cwd` must equal the kernel's
  `cwd` after `realpath`. Otherwise the answer is `not_found`, the same as an unknown run,
  so the journal does not reveal another project's runs. The replay is journaled in the
  run's session, which is then of this project.
- **Estimate first, cancellable (P4-F5).** A replay is planned first (`Kernel.replayPlan`,
  protocol `run.replayPlan`), which spends nothing, and then started once
  (`Kernel.startReplay`, `run.replay {planId}`). The plan id is also the replay id.
  `run.cancel` with that id aborts the replay. Its confirmations are closed, and a
  `replay cancelled` event is journaled. Before any spend, the cap (the band's top) is
  checked against the budget exactly like a graph (`capCheck`, shared with runs; D-021). It
  asks above the threshold, and it blocks without `--over-budget`. `kpai replay` prints the
  likely cost and the cap, then needs `--yes` or a y. That yes stands for the cap question,
  and Ctrl+C cancels. `run.replay` without `planId` still plans and runs in one call,
  with the cap checked.
- **Scope gate (P4-F6).** A replay goes through the runner's scope gate (`admitScope`,
  shared with `GraphRunner.run`), with the packs selected now and the time now. A scope
  read from `.kpstudio/scope.yaml` is confirmed by the human first, as for a run. A refusal
  is journaled as `replay refused` with the run and replay ids, and no provider is called.
  The node's `authorisedScope` boundary is stamped afresh.
- **Consequence:** confirmations raised by a replay carry the replay id as `runId`, dispute
  questions included (P4-R2: `runId` is the replay id, `replayOf` the original run). So
  cancelling a replay sends `confirm.closed` for an open dispute dialog too, and the
  dispute fails closed at once. The journal still files the dispute events under the
  original run id, between that replay's `replay started` and `replay recorded`.
