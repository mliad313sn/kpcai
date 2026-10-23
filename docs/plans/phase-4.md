# Phase 4 plan — Memory and learning

Owner: Product Owner · Started 2026-10-23 · Exit criteria: `docs/BUILD_PROMPT.md` (Phase 4), spec §3.1 (unified memory), §3.5 (replay, fork), §5.4 (competence learning), §4.6 (calibration bench), and the Must items R-401..R-403 of [REQUIREMENTS-KP-STUDIO.md](../REQUIREMENTS-KP-STUDIO.md) (R-404..R-406 are Should).

## Goals

1. **Unified memory, three layers, with provenance** (spec §3.1). Session memory (current context), project memory (conventions, decisions, past mistakes) and user memory (preferences, style). Every fact carries its provenance: which model or person, when, and on what evidence. The memory is readable and editable as Markdown and is injected into any model, so changing provider costs nothing.
2. **Learning from outcomes** (spec §5.4, R-401). Every task is graded automatically (tests passed, patch accepted unmodified, rolled back or reverted, critic without major objection) and optionally by hand. Grades update the measured competence per model, task type and project. The router's reason line cites that evidence.
3. **A bench on the user's own code** (spec §4.6, §5.4). An optional short calibration and a reference task set run on the current repository to recalibrate competence.
4. **Replay and fork** (spec §3.5, R-403). Rerun any node with another model and compare side by side; fork a run from any node.
5. **Evidence the user can trust.** Published estimate accuracy (R-402), verification ROI and a review-spend policy (R-404), disagreement surfaced instead of silently resolved (R-405), and productivity metrics computed only from the journal (R-406).

## Safety rules for this phase

- **Memory is a persistence channel for prompt injection.** A model may propose a memory fact, but the fact is stored only after a human confirms it. Facts proposed by models are labelled with their source and treated as untrusted data when injected.
- **Memory never holds secrets.** Content is redacted before it is stored, facts touching forbidden zones are refused, and a fact can be marked `local-only` so it is never sent to a cloud provider.
- **Local first.** Memory and competence live under `$KPAI_HOME`. Project memory can optionally be exported to the repository as Markdown, and it is then read as untrusted repository content like the R-306 rule files.
- **Grades are evidence, not opinions.** Automatic grades come only from journaled events. Manual grades are journaled with their author. Competence updates are bounded, so a few grades cannot flip routing.

## Work packages

- **WP1 (S1): `packages/memory` plus kernel wiring.**
  - Three layers, stored as Markdown with front matter.
  - Provenance per fact.
  - Propose → confirm → store.
  - Redaction and zones.
  - Injection with a token budget.
  - Protocol `memory.*` and CLI `kpai memory`.
  - ADR-0027.
- **WP2 (S3): grading, measured competence and the bench.**
  - Automatic and manual grades from the journal.
  - Per-repository competence store.
  - Router blend of the prior with measured competence, with bounded updates and the evidence cited in the reason.
  - `kpai bench` (short calibration on the repository).
  - Estimate accuracy in `kpai stats` (R-402).
  - ADR-0028.
- **WP3 (S4): replay, fork, disagreement and review policy.**
  - Replay a node with another model from the journal (R-403).
  - Fork a run from a node.
  - Disagreement between critics or voters marks the node "disputed" and asks the human (R-405).
  - Review depth by criticality, with the verification cost against accepted findings in the run report (R-404).
- **WP4 (S6): KP Studio views.**
  - Memory editor.
  - Replay and fork buttons (enabled), with side-by-side compare.
  - Competence evidence in the routing panel.
  - Accuracy and productivity view (R-402, R-406).
  - Disputed nodes.
  - French and English.
  - Starts once WP1–WP3 expose their protocol shapes.
- **WP5 (S8): measurement and demo.**
  - R-406 metrics from the journal, with documented formulas.
  - e2e for memory and replay.
  - `scripts/demo-phase4.mjs`.
- **WP6 (PO): independent review, report and gate.**
