# KP Studio — adoption work items for other seats

Owner: S9. Date: 2026-10-23. These are ready-to-implement items that live **outside** my lane
(`docs/adoption/**`, `packages/packs/**`). Each names the files, the change and the test. I do
not edit those files (S1/S4/S5 are editing `apps/cli`, `packages/kernel`, `packages/server`,
`packages/orchestrator`, `packages/tools` concurrently). `@kernelpai/packs` already provides
the data and the pure functions each item needs; the work is to call them.

Dependency note: all wiring items depend on `@kernelpai/packs` being added to the build graph
— see "Root config changes" at the end (for S1).

---

## WI-S1-01 — Pack-aware workspace guard (A-002, audit F1) · owner S1

- **Files:** `packages/kernel/src/workspace.ts` (and the CLI caller `apps/cli/src/commands/graph.ts:64`).
- **Change:** keep the home/filesystem-root refusals. Replace the fixed `PROJECT_MARKERS`
  membership test with: if no built-in marker matches, call
  `acceptsWorkspace(dir, packs, optedIn)` from `@kernelpai/packs`. Accept when `accepted` is
  true; when `askOptIn` is non-empty, prompt the user to opt the folder in for that pack
  (persist the opt-in, e.g. in `$KPAI_HOME`); otherwise keep the current "create
  .kernelpai-workspace" fallback. Load packs once via `loadPacks({ repoRoot: dir })`.
- **Test:** a folder with only `sales.csv` / `platformio.ini` / `project.godot` / `*.gpkg` is
  accepted; a folder whose only marker is `firmware.bin` is refused until opted in; `$HOME` and
  the filesystem root are still refused. (`packages/packs` already tests `acceptsWorkspace`.)

## WI-S1-02 — `deliverable` on task nodes + save paths (A-005, audit F3) · owner S1 (+S4/S6)

- **Files:** `packages/core/src/graph.ts` (`GraphNode`), `packages/core/src/routing.ts`
  (`TaskNode`). This is a core-contract change, so it goes through the PO.
- **Change:** add an optional `deliverable` field to a node (`'answer' | 'report' | 'patch' |
'notebook' | 'design' | 'build' | 'model3d' | 'map' | 'config' | 'asset'`), mirroring the
  pack schema's enum. Default `answer`. This is the contract the apply path, the prompts and
  the UI branch on (WI-S4-01, WI-S6-01).
- **Test:** core type test: a node may carry a `deliverable`; existing nodes default to
  `answer`; round-trips through the protocol schema (`packages/kernel/src/protocol.ts`).

## WI-S1-03 — Journal + show the authorised scope (A-004, audit F8) · owner S1 (+S7)

- **Files:** `packages/kernel/src/*` (run start), `apps/cli/src/graph/setup.ts` (plan render),
  journal event writer.
- **Change:** when a selected pack has `safety.requiresScope`, require an `AuthorisedScope`
  (CLI flag or `.kpstudio/scope.yaml`), validate it with `scopeProblems(pack, scope)` from
  `@kernelpai/packs`, refuse the run on any problem, print `describeScope(scope)` in the plan,
  and journal `scopeJournalPayload(pack, scope)` (which omits free-text notes).
- **Test:** a RE/pentest run is refused until a bounded, unexpired, in-kind scope is given; the
  journal contains the scope event with targets as `kind:value`, no notes. (`scope.ts` tested.)

## WI-S1-04 — Add pack-proposed task types to core (A-007, audit F4) · owner S1

- **Files:** `packages/core/src/schemas.ts` (`TaskTypeSchema`), classifier
  `packages/executor/src/classify.ts`, `apps/cli/src/main.ts` `TASK_TYPES`.
- **Change:** add the nine proposed types collected from the built-in packs' `proposedTaskTypes`
  (reverse_engineering, security_assessment, data_analysis, design, game_design, cad_modelling,
  geospatial_analysis, creative_writing, translation). Until then packs map onto existing types
  via `NodeHint.type`; this item removes the `mapsTo` indirection. Router competence sheets
  (`packages/providers/descriptors`) can then score them.
- **Test:** `--type reverse_engineering` is accepted by the CLI; `TaskTypeSchema` parses it; a
  capability sheet may declare competence for it.

## WI-S1-05 — `kpai pack` CLI surface (A-015) · owner S1

- **Files:** new `apps/cli/src/commands/pack.ts`, wired in `apps/cli/src/main.ts` USAGE+dispatch.
- **Change:** `kpai pack list|detect|check|show` over `@kernelpai/packs` (`loadPacks`,
  `detectPacks`, `checkPackFiles`, and print one pack). Suggestions print tools with `[U]` for
  `verified: false` and **never install** anything.
- **Test:** `kpai pack check <bad.yaml>` exits 1 with the hint lines; `kpai pack detect` in a
  notebook folder lists `data-science` with its evidence.

## WI-S4-01 — Use pack plan hints + deliverables in the planner (A-006, A-005) · owner S4

- **Files:** `packages/orchestrator/src/planner/template.ts`, `packages/orchestrator/src/prompts.ts`.
- **Change:** before the code/other branch, call `pickPlanHint(packs, request)`; if it returns a
  hint, build nodes with `hintToNodes(hint, request, criticality)` and set the plan reason to
  `hintReason(choice)`. In `prompts.ts` `deliverable()`, branch on the node's `deliverable`
  (WI-S1-02) instead of only `code_generation|test`: a `report`/`design`/`notebook` node asks
  for that artifact, not a diff. Pack `reviewCriteria` are appended to the critic prompt.
- **Test:** a dataset request yields the explore→experiment→report graph with the pack reason;
  a `report` node's author prompt does not demand a unified diff. (`select.ts` tested in packs.)

## WI-S4-02 — Enforce scope at run start in the runner (A-004) · owner S4 (with WI-S1-03)

- **Files:** `packages/orchestrator/src/runner.ts`.
- **Change:** the GraphRunner refuses to schedule any node when the active pack requires a scope
  and none is validated; the refusal is journaled. Pairs with WI-S1-03 (which gathers/validates).
- **Test:** runner test: a graph tagged with a scope-requiring pack and no scope does not call
  any provider.

## WI-S4-03 — Narrow the `critical` keyword regex (audit F-JARG-2) · owner S4

- **Files:** `packages/orchestrator/src/planner/template.ts` (`CRITICAL`).
- **Change:** `token` and `crypto` over-trigger criticality for data-science and crypto-currency
  wording ("report the token counts"). Require a security context (e.g. `auth`, `secret`,
  `password`, `credential`, `api key`) rather than bare `token`; let packs set criticality.
- **Test:** "report the token counts of the tokenizer" → `normal`; "store the auth token
  securely" → `critical`.

## WI-S4-04 — Physical-effect dry-run nodes (A-011, audit F-SAFE-1) · owner S4 (+S5)

- **Files:** `packages/orchestrator/src/planner/*`, runner confirmation path; tool risk in
  `packages/tools/src/builtins/shell.ts`.
- **Change:** when the active pack has `safety.physicalEffects`, the planner inserts a dry-run /
  simulation node before any node whose deliverable actuates (build/flash/apply), and the runner
  confirms each actuating step individually (no batch trust). The smart-home, embedded-iot,
  devops-sre and cad-3d-printing packs already carry such a node and the flag.
- **Test:** a smart-home plan contains the dry-run node before the automation node; an apply step
  is confirmed every time.

## WI-S5-01 — Honour pack zones in the tool bus (A-003) · owner S5 (with S7)

- **Files:** `packages/tools/src/policy.ts`, `packages/tools/src/policy-config.ts`,
  `packages/tools/src/workspace/common.ts` (`zonesOf`).
- **Change:** feed the pack-derived forbidden set into the policy. Use `@kernelpai/packs`
  `planZones(packs, approved)` to compute additions and approved relaxations, and apply
  `isForbidden` semantics: credential zones and additions always win; the two name-heuristics
  yield only to an approved, narrow relaxation. The pending/refused relaxations are surfaced for
  the human to approve (console confirmation round-trip).
- **Test:** with `security-defensive` approved, `detections/aws_secret_access.yml` is readable
  while `.env` and `server.pem` stay refused; an over-broad relax is refused.

## WI-S7-01 — Split `*.key` and tighten the name heuristics (A-003, audit F2) · owner S7

- **Files:** `packages/tools/src/policy.ts` (`DEFAULT_FORBIDDEN_PATHS`).
- **Change:** `*.key` currently blocks Apple Keynote `.key` files. Scope the key/cert match to
  real key material (e.g. `*.pem`, `id_rsa*`, `*.p8`, `*.pfx`, and `*.key` only under
  `keys/`/`certs/` or alongside a cert), and keep `**/*secret*` / `**/credentials*` as
  **relaxable** heuristics (via WI-S5-01) rather than immovable. Keep `.env`/ssh/aws/gnupg
  immovable. Also stop blocking `.env.example` (it is in `.gitignore` as an allowed template).
- **Test:** `design-review.key` (Keynote) is readable; `server.pem`, `id_rsa`, `.env` refused;
  `.env.example` readable. (Mirror the false-positive list in `packages/packs/src/zones.ts`
  `CREDENTIAL_SAMPLES` / audit F2.)

## WI-S6-01 — Non-code artifact views + glossary/tips (A-005, A-010) · owner S6

- **Files:** `apps/studio/src/ui/CenterTabs.tsx`, `DiffView.tsx` (add sibling views),
  `NodeDetail.tsx`, onboarding screen.
- **Change:** render a node's output by its `deliverable`: a report/document view, a notebook
  view, a map/asset preview, a config view — not only the diff. Show the active pack's
  `glossary` and `tips` in the first-run screen and link terms from the plan.
- **Test:** component test: a `report` node renders the document view, a `patch` node the diff
  view; the first-run screen lists the selected pack's tips.

## WI-S6-02 — i18n message catalogue, French first (A-008, audit F9) · owner S6/S1

- **Files:** `apps/cli/src/main.ts` (USAGE + errors), `apps/studio/src/ui/*` strings,
  `apps/studio/index.html` `lang`.
- **Change:** extract user-facing strings into a catalogue with a locale switch; provide a French
  translation (the master spec is French). Pack `glossary`/`tips` are already data and can ship
  per-locale.
- **Test:** with locale `fr`, USAGE and the main errors render in French; English fallback holds.

## WI-S2-01 — Multimodal model input (audit F5) · owner S2 (+S1)

- **Files:** `packages/core/src/schemas.ts` (`ChatMessage` content), `packages/providers/src/*`
  adapters, `packages/tools/src/builtins/fs.ts` (binary/image read).
- **Change:** let a node attach image/binary/dataset references so vision-capable models receive
  them (the capability sheets already declare `modalities: [text, image, …]`). Keep text-only
  models getting a textual summary (spec §6: forbidden zones get a summary or nothing). This
  unblocks design (screenshots/Figma renders), RE (bytes), data (samples), GIS (raster tiles).
- **Test:** against a fake server, an image attachment reaches an image-capable mock adapter; a
  text-only adapter receives a summary, never raw bytes.

---

## Root config changes for S1 (I must not edit these)

`@kernelpai/packs` is self-contained (its own `tsconfig.json` extending `tsconfig.base.json`,
its own deps `zod`, `yaml`, `@kernelpai/core`). To add it to the workspace build and tests, S1
should add, **verbatim**:

1. `tsconfig.json` — add to `references` (anywhere in the array; before `apps/*` keeps leaf
   order):

   ```json
   { "path": "packages/packs" }
   ```

2. `vitest.config.ts` — add to `resolve.alias` (so tests resolve the package from source like
   the others):

   ```ts
   '@kernelpai/packs': src('./packages/packs/src/index.ts'),
   ```

3. Any package that will consume packs (CLI/kernel/orchestrator/tools) adds
   `"@kernelpai/packs": "workspace:*"` to its `dependencies` and a `{ "path": "../packs" }`
   reference in its `tsconfig.json`. `pnpm-workspace.yaml` already globs `packages/*`, so no
   change there; `pnpm install` will link it.

No change to `pnpm-lock.yaml` is needed from me — `zod` and `yaml` are already in the lockfile
(used by `packages/providers`); `@kernelpai/packs` is a workspace package. If CI installs with
`--frozen-lockfile`, S1 will need to refresh the lockfile to register the new workspace package;
that is S1's call, not mine (I did not touch the lockfile).
