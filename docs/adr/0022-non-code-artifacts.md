# ADR-0022 — Non-code artifacts next to patches

**Status:** Accepted by the PO (proposed by S1; phase 3, D-019, D-020 WI-S1-02) · **Date:** 2026-10-23

## Context

D-019 makes non-code outputs first-class results: reports, notebooks, configs, 3D models,
maps and assets. They must follow the same rules as patches: model output is untrusted,
writes are confirmed, and forbidden zones apply. The pack schema (S9) names what a node
delivers. S4's runner (edd71f3) extracts artifacts per node
(`RunResult.deliverables: Record<nodeId, NodeDeliverable>`).

## Decision

1. **Contract.**
   - `GraphNode.deliverable?` is in core (`DeliverableSchema`). It holds the full pack
     enum: `answer`, `report`, `patch`, `notebook`, `design`, `build`, `checklist`,
     `model3d`, `map`, `config`, `asset`.
   - When it is absent, code and test nodes deliver `patch`; every other node delivers
     `answer`.
   - Only `patch` nodes feed the patch path (`collect` uses `deliverableOf`).
   - Artifact kinds are the enum minus `answer` and `patch`.
2. **Wire format.** One fenced block per file; a longer fence lets the file contain one:
   the opening line is ` ```artifact path=… kind=… [mime=…] `.
   - Document kinds (`report`, `checklist`, `design`) are also the whole reply, saved as
     `<nodeId>.md`.
   - S4 extracts and checks the path (relative, plain, no `..`, `.git` or dotfile segment),
     the size (1 MB), the count, the MIME type and hidden bytes.
   - The kernel re-checks path, kind, size and hidden bytes as defence in depth.
   - v1 is text only. `encoding="base64"` is reserved for binary models and assets.
3. **Which artifacts may be written** (PO ruling, D-020):
   - **File kinds** (`notebook`, `config`, `model3d`, `map`, `asset`, `build`) only from a
     node approved by a critic from another provider (D-014, principle 2).
   - **Document kinds** (`report`, `checklist`, `design`) also from a node that no critic
     reviewed, such as a solo node. They are marked `reviewed: false`, and each save is
     asked on its own with "NOT REVIEWED". `yesApply` never covers them.
   - A document that a critic **rejected** is not kept.
   - When the same file comes from two nodes, the reviewed copy is kept.
   - Refusals are journaled, with the reason.
4. **Same route as patches.**
   - `run.done` carries an optional `artifacts` array. Each artifact has
     `{nodeId, path, kind, mime, content, bytes, sha256, reviewed, provenance}`, where
     `provenance` is `{runId, sessionId, nodeId, author?, reviewer?}`.
   - `artifacts.apply {runId, paths?}` writes in the run's tree, which is its worktree when
     the run is isolated (ADR-0021). Each write comes after a checkpoint and goes through
     `fs.write` (jailed, forbidden zones denied).
   - Each artifact is its own write batch, so each is confirmed with `kind: 'artifact'`,
     its exact `content`, and `{path, kind, mime, bytes, nodeId, reviewed}`.
   - Nothing is written after a cancel, and nothing is pre-approved over the protocol.
5. **Prompts** are S4's (`deliverablePrompt`). The kernel's interim note was removed.

## Core changes made (with the PO's go-ahead in D-020)

`DeliverableSchema` / `Deliverable` and `GraphNode.deliverable?` are additive and optional.
Proposed, not made:

- add `data` (CSV, Parquet, GeoPackage outputs) to the enum in core and in the pack
  schema. Until then, data files travel as `asset` or `map`;
- `ProtocolResult.artifacts?`, once protocols produce files through tools rather than in
  text.

## Consequences

Non-code results are confirmed, checkpointed and journaled exactly like code. An
unreviewed document still costs one explicit yes per save. Two open points for S4:

- the extracted body drops its final newline, so text files are written without one;
- dotfile paths (`.env.example`, `.github/…`) are refused by the path rule. This is safe,
  but stricter than the zones need.

## Revisit when

Binary artifacts are needed, artifacts must go outside the workspace (devices: D-019
requires simulation first), or reviewed documents should skip the per-save question.
