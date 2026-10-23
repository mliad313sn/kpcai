# ADR-0030 — Phase 4 kernel wiring: productivity, review policy from config, home memory zone

**Status:** Accepted by the PO (proposed by S1; phase 4) · **Date:** 2026-10-23

## Context

Phase 4 left five gaps at the kernel boundary:

- S8's productivity metrics (R-406, `docs/metrics/PRODUCTIVITY.md`) had no protocol method and no CLI.
- The review policy (R-404, ADR-0029) could only be passed in code, so no user could turn it on.
- Replay and fork (R-403) were reachable only from the console.
- `kpai bench --yes` still asked its cost question.
- ADR-0027 deferred `$KPAI_HOME/memory/**` as a zone for workspaces that contain `$KPAI_HOME`.

## Decision

1. **Productivity.** `KernelLearning.productivity({since?, reworkDays?, detail?})` calls `productivity(journal, {project: cwd, …})`.
   - A bad `since` or `reworkDays` is `KernelError('invalid')`.
   - The change list is returned only with `detail`, and is capped at 1,000 (`MAX_PRODUCTIVITY_LIST`). The counts always cover every change.
   - Protocol: `stats.productivity` (additive, version 1). Params are `since` (ISO datetime), `reworkDays` (1–365) and `detail`. The result is checked by `ProductivitySchema`.
   - CLI: `kpai stats --productivity [--since <ISO>]` prints a block after the accuracy block, in English or French. Plain `kpai stats` is unchanged.
2. **Review policy from configuration.** The environment variable `KPAI_REVIEW_POLICY` sets it, for the CLI and the console server alike.
   - `off` or unset: no policy (the default, as before).
   - `suggested`: R-404's suggestion.
   - `low=…,normal=…,critical=…`: the suggestion with those depths overridden.
   - A bad value is an error at planning time, never a silent "off".
   - It lives in `GraphSetup.reviewPolicy`, so the estimate (`estimateDeps`) and the runner (`runDeps`) apply the same policy. The band therefore covers the extra critics.
   - A replay never applies the policy (it reruns one node as asked), and neither does its estimate.
   - A fork whose edit names a protocol runs without the policy: the human's explicit choice wins.
   - An environment variable, not a `$KPAI_HOME/config` file: every other kernel setting is already an environment variable (`KPAI_CONFIRM_ABOVE_USD`, `KPAI_PROFILE`, `KPAI_MEMORY_TOKENS`). One config file for all of them is a separate decision.
3. **`kpai replay <run> <node> [-m p/m] [--protocol p]` and `kpai fork <run> <node> [-m p/m] [--protocol p] [--instruction …]`** call `Kernel.replay`, `forkPlan` and `startFork`, the same paths the console uses.
   - A fork is shown with its plan and estimate, then finished like `kpai do`. Writes need `--apply`, and each one is confirmed unless `--yes-apply`.
   - `Kernel.replay` now guards the workspace like a run does, because a replay spends and its tools act in the workspace.
4. **`--yes` covers the bench's cost question.** `--yes` accepts cost questions only, and the bench's total is one of them. The question is printed, followed by "yes (--yes accepts cost questions)". The bench never writes, so no write is affected.
5. **`$KPAI_HOME` zone.** When `$KPAI_HOME` is inside the workspace (lexically or after `realpath`), the kernel adds `<rel>/**` as an `added` zone of origin `caller`. The PO widened this from `memory/**` to the whole folder: `policy.json` there would otherwise let a model rewrite the zones themselves, and approvals, packs, the journal and the server token are just as sensitive. In the pathological case where `$KPAI_HOME` is the workspace root, the kernel's own files are listed one by one. It does this in `policyFor`, `selectPacks` and every tool bus it creates (runs, applies, tool listing). Patches, artifacts, merges, restores and model tools all refuse those files. `@kernelpai/tools` is unchanged.
6. **Run attribution.** The kernel journals `checkpoint unavailable`, `patch refused: control characters` and `artifact refused` with their `runId`. Outside git, a write of run A made after run B ended is then counted for A, not B.

## Consequences

- Productivity is visible from the CLI and the console with one definition.
- Enabling reviews raises estimates as much as it raises spend, so there is no estimate gap.
- Unattended calibration is possible (`kpai bench --yes < /dev/null` exits 0).
- The proposal hint was shortened to 79 tokens (ADR-0027 corrected).

## Revisit when

- A `$KPAI_HOME/config` file collects the kernel settings.
- The tool bus journals a `runId` on tool events, so the learning split no longer needs the preceding intervention.
