# ADR-0028 — Grading, measured competence and the bench

**Status:** Accepted by the PO (proposed by S3; phase 4 WP2) · **Date:** 2026-10-23

## Context

Spec §5.4 and R-401 ask that routing learn from outcomes in the repository, and that the
reason line cite that evidence. R-402 asks for published estimate accuracy. The phase 4
safety rules say grades are evidence, not opinions: automatic grades come from journaled
events only, manual grades are journaled with their author, and updates are bounded.
The router already had a `measured` hook (ADR-0011) that nothing filled.

## Decision

1. **New package `@kernelpai/learning`.** It reads the journal; it writes only `grade` and
   `bench check` interventions. It depends on core, journal and orchestrator (for
   `parseVerdict`/`accepted`, so a verdict means what the protocol acted on).
2. **Runs come from the journal.** A session is split at each `run outcome` (keyed by run
   id). Later events with the run id (checkpoint, restore, merge) and the kernel's writes
   (`git.apply`, `fs.write` under provider `kernel`) belong to that run. A segment without
   an outcome (`kpai ask`, a killed run) is keyed `<sessionId>#<first seq>`.
3. **Grade per (node, model).** The producer is the last `solo`/`author`/`revision` answer.
   Its task type comes from the plan, else the call. Vote and debate nodes have no
   single producer and are not graded in this phase. The grade is
   `g = Σ wᵢ·vᵢ / Σ wᵢ`, with v ∈ {0, 1}:

   | signal    | v = 1                     | v = 0                                         | w   |
   | --------- | ------------------------- | --------------------------------------------- | --- |
   | manual    | `good`                    | `bad`                                         | 3   |
   | rollback  | —                         | checkpoint restore or declined merge undid it | 2   |
   | tests     | last test run passed      | failed or timed out                           | 1.5 |
   | critic    | approved, no major issue  | rejected (each verdict on that model's draft) | 1   |
   | patch     | every patch applied as is | declined, refused or failed to apply          | 1   |
   | bench     | the bench check passed    | failed                                        | 1   |
   | cancelled | —                         | the run was cancelled                         | 0.5 |

   Tests are `shell.run` calls of a test command (`vitest`, `npm test`, `pytest`,
   `go test`, …) or a future `test.run` tool. A run with no exit code (missing program,
   refusal) says nothing. A rollback replaces the patch signal.

4. **Measured competence per repository.** `CompetenceStore.fromJournal(journal,
{ project: cwd })` groups grades by (model, task type) for that project. It keeps the
   last 100 nodes and reports `score = mean(g)`, `samples = n`, and the evidence:
   `approved 14/16 test tasks here (tests passed 9/10, critics approved 12/13)`. A node
   counts as approved when g ≥ 0.5. Nothing is stored besides the journal, so the store is
   always recomputed. It is built once per plan (about 60 ms on 12 000 events); each
   decision only does a map lookup.
5. **Router blend (bounded).** Let p be the static prior, m the measured score and n the
   sample count.
   - If n < 5, the router uses p.
   - Otherwise c = n / (n + 10) and blended = p + clamp(c·(m − p), −0.3, +0.3).
   - The w2 term uses the blended value. `parts.measuredCompetence` reports it, or null
     while n < 5. One node moves m by at most 1/n, and no history moves the term more than
     0.3 from the prior.
   - When measured competence is in force, the reason line ends with
     `; evidence: <phrase>`. The phrase is one line and at most 160 characters.
6. **Anti-gaming.**
   - A critic's verdict on its own draft (same provider and model) is ignored and listed
     as `self-review`. A same-provider critic counts half.
   - Manual grades are interventions, which only the kernel appends. A model's tool calls
     are `tool` events. A grade must say `source: "human"` and carry an author.
   - An author naming the graded model is refused (`recordGrade`) or ignored
     (`self-grade`).
   - The last grade of each author counts.
   - A bench check must say `source: "bench"`.
   - Every ignored item is returned for audit.
7. **Bench (`runBench`).** It scans small source files and skips:
   - the kernel's forbidden zones (an `allowed` predicate);
   - tests, secret-looking paths, dot-directories and vendored code.

   It builds three tasks, with file content quoted as data:
   - summarise a file (analysis);
   - write unit tests for a function (test);
   - critique a diff with a planted defect (critique).

   Each task is planned through the kernel without spending. The bench then asks once,
   showing the likely cost and the cap, and runs each task through the kernel's normal
   path. A deterministic text check of each answer is journaled as a `bench check`. Model
   output is never executed. Competence is recomputed afterwards and the changes are
   returned.

8. **Estimate accuracy (R-402).** It compares plan estimates with billed cost for finished,
   uncancelled runs whose plan was journaled. It reports this per task type (node level),
   per run, and by basis (cold start, calibrated, mixed), with the in-band share.
   `accuracyNote` gives the line shown next to an estimate.

## Consequences

- With little evidence, routing behaves as before: below 5 graded tasks per (model, type,
  repository), nothing changes. A close race flips after about 10–16 graded tasks. A
  prior gap above 0.6·w2/(w1+w2) (0.23 balanced, 0.24 economy) never flips on competence
  alone.
- Concurrent runs sharing one session would interleave. The kernel opens one run at a time
  per session today. Tagging calls with the run id would remove the ambiguity (integration
  note).
- Bench checks are weak, heuristic signals (w = 1). The critic of another provider grades
  the same answers.
- The store reads the last 100 000 journal events. Incremental caching is deferred until a
  journal grows past that.
