# KP Studio — adoption and friction audit

Owner: S9 (engagement & adoption analyst). Date: 2026-10-23. Appointment: D-018.
Base: branch `claude/adoring-euler-c7wa3f`, HEAD `bc81a7f`. Audited against a clean build of
`HEAD` (the working tree is mid-edit by S1/S4/S5 and does not compile), the phase-2 offline
demo, and the CLI driven as a first-time user of each profile with `--allow-test`.

> The question for every finding: **who would stop using KP Studio here, and why?**
> Severity: **Blocker** (the profile cannot do its core task, or is driven away on day one) ·
> **Major** (a real task is painful or a whole profile is second-class) · **Minor** (friction,
> wording, polish). Owner seats: S1 kernel/CLI, S2 providers, S3 router, S4 orchestrator,
> S5 tools, S6 UI, S7 security, S8 QA, S9 me. Requirement ids (A-0xx) are in
> `REQUIREMENTS-ADOPTION.md`; work items (WI-…) in `WORK-ITEMS.md`.

Pack-based fixes marked **S9 (done)** ship in `packages/packs` in this change but are **not
wired in** — the wiring is a work item for the owning seat (S1/S4/S5), per my work package.

## Summary — the ten findings that matter most

| #   | Finding                                                                 | Severity | Blocks                                       | Owner      |
| --- | ----------------------------------------------------------------------- | -------- | -------------------------------------------- | ---------- |
| F1  | Workspace guard refuses any folder with no code marker                  | Blocker  | data, RE, GIS, design, creative, CAD, novel  | S1 (+S9)   |
| F2  | Default forbidden zones `**/*secret*` / `**/credentials*` over-block    | Blocker  | infosec, security, docs, CAD (`design.key`)  | S7 (+S9)   |
| F3  | Output is a code patch only; non-code work has no artifact path         | Major    | data, design, GIS, CAD, creative, research   | S4/S1      |
| F4  | Fixed 7 task-type list and code-centric planner fit only software       | Major    | every non-software profile                   | S4/S1(+S9) |
| F5  | Text-only model input; images, binaries, datasets cannot be given       | Major    | design, RE, data, GIS                        | S2/S1      |
| F6  | No first-run / onboarding; `kpai init` does not exist                   | Major    | students, non-devs, everyone                 | S1/S6      |
| F7  | No pack / domain mechanism; no way to adapt without a code fork         | Major    | every profile beyond software                | S9 (done)  |
| F8  | Security/RE profiles have no scope concept; cross-review may block them | Major    | pentest, RE (can't run without another prov) | S4/S7(+S9) |
| F9  | Product UI/CLI English only; master spec is French, no i18n             | Major    | French & non-English users                   | S6/S1      |
| F10 | Error messages name internal rules, not next steps                      | Minor    | first-time users of every profile            | S1/S6      |

---

## 1. Install

- **F-INST-1 (Minor, everyone, S8/S1).** There is no published install path yet: no
  `npm`/`brew`/binary; a user clones the monorepo and runs `pnpm`. Node ≥ 22.13 is required
  (`package.json engines`), but KernelPAI's own repo CLAUDE.md notes Python/other repos run
  on 3.11/3.12 — the Node floor is high and undocumented for end users. Evidence:
  `package.json` `engines.node ">=22.13"`. Fix: ship a packaged binary (phase 6 already
  plans macOS/Linux packaging) and document the Node floor. Owner S8/S1.
- **F-INST-2 (Minor, offline/regulated, S5).** Phase-2 report records there is **no isolating
  shell sandbox** (`@anthropic-ai/sandbox-runtime` needs bwrap, absent here), so every
  `shell.run` is human-confirmed. Fine for safety, but an automation/DevOps user expecting
  unattended runs will hit a wall. Evidence: `docs/PHASE-2-REPORT.md` "No isolating shell
  sandbox". Fix: document it; phase 6. Owner S5.

## 2. First run

- **F6 (Major → Blocker for non-devs, S1/S6).** There is **no onboarding and no `kpai init`**.
  Spec §4.6 and the phase-3 plan both call for a guided first run (detect keys/local models,
  pick a profile, calibrate, first task); it is not built. A first-time user runs `kpai`,
  gets the raw USAGE block, and must already know the flags. Evidence:
  ```
  $ kpai init
  Unknown command "init"
  ```
  (`apps/cli/src/main.ts` has no `init`; USAGE lists `do/plan/run/route/...` only). Fix:
  A-001, phase 3. Owner S1 (CLI command) + S6 (UI first-run). Blocks students, non-dev
  creators, and anyone who is not already a KernelPAI developer.
- **F-RUN-1 (Major, everyone without a key, S6/S1).** With no API key set and no `--allow-test`,
  every real request is unroutable; the message is correct but the path forward (set a key, or
  use `--allow-test`, or install Ollama for a $0 path) is not offered. Evidence:
  ```
  $ kpai do "add a login page"
  … answer: No candidate for node answer: all 1 rejected — mock/echo: provider kind "test" excluded
  ```
  Fix: the first-run flow should detect "no providers" and offer the local/$0 path (R-308,
  A-001). Owner S6/S1.

## 3. Concepts and jargon

- **F-JARG-1 (Minor, all non-devs, S6/S9).** The console and CLI lead with "kernel",
  "node", "protocol", "criticality", "fallback", "routing reason". These are precise but
  unexplained in-product. Evidence: `apps/studio/src/ui/CommandBar.tsx` placeholder
  "Describe a task… / commands · @ files · # nodes · ! terminal"; no glossary surface. Fix:
  packs carry a `glossary` and `tips` (S9, done); surface them in onboarding (A-010). The
  `learning` and `general` packs define model/plan/cost/node in plain words.
- **F-JARG-2 (Minor, everyone, S9).** "Criticality: critical" is inferred from keywords like
  `secret`, `token`, `password`, `crypto` (`packages/orchestrator/src/planner/template.ts`
  `CRITICAL` regex). A data scientist asking to "report the token counts of the tokenizer"
  gets a **critical** plan and forced debate/critic. Evidence:
  ```
  $ kpai plan --allow-test "train a tokenizer on the dataset and report the token counts"
  … criticality critical …
  ```
  Fix: the word "token" is overloaded; packs can set criticality and the `data-science` pack's
  glossary clarifies it. Narrow the regex (WI-S4-03). Owner S4 (+S9 glossary, done).

## 4. Defaults that block real work

- **F1 (Blocker, S1 + S9 done).** The workspace guard refuses any folder without a marker in
  a fixed list (`.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`,
  `build.gradle`, `.kernelpai-workspace`). A folder of CSVs, a firmware dump, a single binary,
  a QGIS project, a Figma export, a novel, a GDD — all refused before any work. Evidence:
  ```
  $ cd csv-folder && kpai do --allow-test --yes "analyse these files"
  not run — no project marker here (.git, package.json, pyproject.toml, Cargo.toml, go.mod,
  pom.xml, build.gradle, .kernelpai-workspace); create .kernelpai-workspace to allow this folder
  ```
  Source: `packages/kernel/src/workspace.ts:5-14` (and the identical `apps/cli/src/graph/workspace.ts`
  at HEAD). The `.kernelpai-workspace` escape hatch works but the message makes a data
  scientist feel the tool is not for them. Fix: packs add markers (`*.ipynb`, `platformio.ini`,
  `project.godot`, `*.gpkg`, `*.fig`, …); `acceptsWorkspace()` in `@kernelpai/packs` is the
  drop-in replacement, with opt-in for lone binaries. A-002, WI-S1-01. Owner S1 (wiring),
  S9 (markers + guard logic, done).
- **F2 (Blocker, S7 + S9 done).** `DEFAULT_FORBIDDEN_PATHS` includes `**/*secret*` and
  `**/credentials*` (`packages/tools/src/policy.ts:31-45`). These catch real keys **and** a
  security analyst's legitimate files. Measured false positives (run against
  `matchesForbidden`):
  ```
  BLOCKED rules/aws_secret_access.yml      (a Sigma/detection rule name)
  BLOCKED client_secret_rotation_runbook.md
  BLOCKED credentials_policy.md
  BLOCKED detections/secretsdump.yml
  BLOCKED writeups/ctf-secret-flag.md       (RE/CTF notes)
  BLOCKED keynote/design-review.key         (an Apple Keynote file!)
  BLOCKED slides/Pitch.key                  (Keynote)
  BLOCKED tools/credentials-scanner/README.md
  BLOCKED datasets/secret_santa.csv
  BLOCKED .env.example                       (a template, safe to read)
  ```
  So an infosec rule author, a RE/CTF player, and anyone with a `.key` Keynote cannot have
  those files read, with no visible way to allow them. (`.env.example` is also blocked though
  `.gitignore` deliberately keeps it — `!.env.example`.) Fix: keep credential zones immovable,
  but let packs **relax** the two name-heuristic zones for named folders, shown and approved
  (never credential files). `@kernelpai/packs` `zones.relax` + `planZones`/`isForbidden` do
  exactly this (S9, done); `security-defensive` relaxes `detections/**`, `sigma/**`,
  `policies/**`, `runbooks/**`; `reverse-engineering` relaxes `writeups/**`. `*.key` should
  match only at the credential layer for PEM/SSH keys, not Keynote — WI-S7-01. A-003. Owner
  S7 (defaults + wiring), S9 (relax mechanism, done).
- **F-DEF-1 (Minor, everyone, S4).** Default criticality `normal` forces a critic from
  another provider on many nodes, so with only one provider configured a plan is unrunnable
  (`no provider other than mock (principle 2; allowSameProvider waives it)`). Correct by
  principle 2, but a solo developer with one key is stuck until they learn `--allow-same-provider`.
  Evidence: the migration/fr plans above. Fix: onboarding should explain diversity and offer
  the waiver or a local second provider (A-001). Owner S4/S6.

## 5. Safety friction vs safety value

- **F8 (Major, S4/S7 + S9 done).** Reverse engineering and pentest are first-class profiles,
  but there is no concept of an **authorised scope**, and the cross-provider critic can block
  them from running at all with one provider. The value (don't exfiltrate secrets, don't run
  samples) is right; the friction is that the product has no vocabulary for "I am authorised
  to analyse this binary / test this host". Fix: security packs require an `AuthorisedScope`
  (targets, engagement ref, expiry) shown in the plan and journaled; `@kernelpai/packs`
  `scope.ts` validates it and refuses unbounded/expired scopes (S9, done). Wiring into the
  plan/journal is WI-S1-03 / WI-S4-02. A-004. Owner S4/S7.
- **F-SAFE-1 (Major, IoT/DevOps/smart-home/CAD, S4/S5).** Physical-world actions (flashing a
  board, `terraform apply`, actuating a lock, printer G-code) are exactly where a wrong move
  is irreversible, yet the product treats `shell.run` uniformly as "destructive, confirm".
  There is no notion of "dry-run / simulate first". Fix: packs carry `safety.physicalEffects`
  and a dry-run plan node (smart-home, embedded-iot, devops-sre, cad-3d-printing — S9, done);
  the runner should honour it (WI-S4-04). A-011. Owner S4/S5.
- **F-SAFE-2 (positive).** The phase-2 hardening is strong and a selling point for regulated
  buyers: forbidden zones enforced at every exit, repository content never runs programs,
  patches applied only after another provider approves. Keep and surface it in onboarding.

## 6. Cost and confusion

- **F-COST-1 (Minor, everyone, S3/S6 — already planned).** Estimates on cold start are far off
  on mocks (phase-1 behaviour; `docs/PHASE-2-REPORT.md`). R-302 (cost band + live meter) and
  R-402 (published accuracy) already address this; nothing to add beyond making the band
  visible in onboarding so the first number does not scare a new user. Owner S3/S6.
- **F-COST-2 (Minor, students/non-devs, S6).** The $0 local-only path (Ollama/llama.cpp) is a
  real differentiator but invisible at first run. The `learning` and `regulated-airgapped`
  packs point to it in tips; onboarding should default économe for these profiles (A-001).

## 7. Error messages

- **F10 (Minor, everyone, S1/S6).** Messages state the internal rule, not the fix. Examples:
  `provider kind "test" excluded`, `all 1 rejected`, `no provider other than mock (principle
2; allowSameProvider waives it)`, `no project marker here (…)`. Each is accurate but asks the
  user to know the model of the system. Fix: pair each with one next step ("no AI providers
  configured — set an API key, or install Ollama for a free local model, or add --allow-test
  to try offline"). A-009. Owner S1/S6. The pack validator (`checkPackText`) is the model to
  copy: it prints the error **and** a `hint:` line.

## 8. Languages

- **F9 (Major, French and non-English users, S6/S1).** The master spec, BUILD_PROMPT and
  governance are **French**; the product (CLI USAGE, studio UI strings, error messages) is
  **English only**, with no i18n layer. `apps/studio/index.html` is `<html lang="en">`; all UI
  strings are hard-coded English (`apps/studio/src/ui/*.tsx`). The classifier accepts French
  **input** (`packages/executor/src/classify.ts` has FR patterns), so the product half-speaks
  French: it understands a French request but answers in an English shell. A French-first team
  — the spec's own audience — sees an English product. Evidence: `kpai plan` reasons print
  `template "writing" (writing: matched rewrite)` even for a French request. Fix: an i18n
  message catalogue (FR first, since the spec is FR), and pack `glossary`/`tips` are
  translatable data. A-008, WI-S6-02. Owner S6/S1.

## 9. Accessibility

- **F-A11Y-1 (positive, S6).** The studio UI is already careful: every state has an icon **and**
  a word, colour only reinforces (`apps/studio/src/ui/StateBadge.tsx` "colour only reinforces
  them (WCAG 1.4.1)"); tables use `scope`, `caption`/`sr-only`, `abbr`; `aria-pressed`,
  `aria-hidden`. axe-in-CI and keyboard paths are planned (R-609, phase 6).
- **F-A11Y-2 (Minor, S6/S8).** No automated a11y check runs yet (R-609 is phase 6), and the
  live execution thread / agents board update without announced `aria-live` regions in all
  places — a screen-reader user may miss state changes mid-run. Fix: add `aria-live` to the
  thread and agents board; land axe in CI (A-012). Owner S6/S8. (Screen-reader sessions are
  Sponsor-reserved, per CHARTER §5.)

## 10. Output is code-shaped (the cross-cutting one)

- **F3 (Major, S4/S1).** The only artifact the product can hand back and apply is a **unified
  diff from a `code_generation` or `test` node**: `CODE_TYPES = new Set(['code_generation',
'test'])` and patches are collected only from those nodes
  (`apps/cli/src/graph/apply.ts` at HEAD, `git.ts`). The author prompt tells non-code nodes to
  "Answer with the complete result" as text (`packages/orchestrator/src/prompts.ts`
  `deliverable()`), which only ever prints to the terminal. So a data scientist's notebook, a
  designer's spec, a GIS map, a CAD model, a DevOps runbook, a report with citations — none has
  a first-class output, a save path, or a checkpoint. Everywhere the product "assumes the
  output is a code patch":
  - `apps/cli/src/graph/apply.ts` — `CODE_TYPES` gate; only code/test become appliable patches. **Owner S4/S1.**
  - `packages/orchestrator/src/prompts.ts` `deliverable()` — only code/test asked for a diff; all else "complete result" as text. **Owner S4.**
  - `apps/cli/src/graph/render.ts` / studio `DiffView.tsx` — the reviewable artifact view is a diff; no notebook/report/asset view. **Owner S6.**
  - R-305 checkpoints are "before any patch is applied" — non-patch outputs are never checkpointed. **Owner S5.**
    Fix: a `deliverable` type on nodes (packs already declare `answer|report|patch|notebook|
design|build|model3d|map|config|asset`, S9 done); non-patch deliverables get a save path and
    a view. A-005, WI-S1-02, WI-S4-01, WI-S6-01. This is the single change that turns KP Studio
    from "a multi-model coding tool" into "useful wherever technology can help".

## 11. Task types and planner fit (the other cross-cutting one)

- **F4 (Major, S4/S1 + S9 done).** The task-type enum is fixed at seven software-shaped kinds
  (`analysis, code_generation, writing, research, test, critique, decision` —
  `packages/core/src/schemas.ts:4`) and `--type` rejects anything else:
  ```
  $ kpai route --allow-test --type security "x"
  --type must be one of analysis, code_generation, writing, research, test, critique, decision
  ```
  The template planner only branches into a rich multi-node graph for "code"; everything else
  collapses to one solo node (measured: RE, infosec, design, creative, data, IoT, GIS requests
  all planned as a single `analysis` node). A reverse engineer, infosec analyst or data
  scientist gets no profile-fit plan. Fix: packs map onto existing types today and list
  `proposedTaskTypes` for S1 (reverse_engineering, security_assessment, data_analysis, design,
  game_design, cad_modelling, geospatial_analysis, creative_writing, translation — all in the
  built-in packs, S9 done, **core untouched**); `pickPlanHint`/`hintToNodes` realise a
  profile-fit graph (S9 done). Wiring: WI-S1-04 (add types), WI-S4-01 (use hints). A-006/A-007.
  Owner S4/S1.

## 12. Per-profile day-one verdict (detail in PERSONAS-AND-USE-CASES.md)

Blocked on day one today (before packs are wired): data science, reverse engineering, infosec,
design/UX, creative, IoT, GIS, CAD/3D-printing, smart-home, game creation, student/non-dev —
all by F1 (workspace guard) and/or F3/F4 (code-only output and plan). Software engineering,
DevOps (code side), legacy porting, research-writing (text) work today. The pack layer plus
the wiring work items clear F1, F2, F4, F7, F8 and most of F3.

## 13. What is already good (keep)

Cost-before-run with a band, routed cross-provider critic, explained routing, hash-chained
journal, forbidden-zone defence in depth, no-bypass stance, accessible state badges, French
input understanding. These are the differentiators; the adoption work is to let every profile
reach them.
