# @kernelpai/packs

Domain packs are **data that adapt KP Studio to a profile** — software, reverse
engineering, data science, IoT, GIS, smart home, and more — **without forking code**. A
pack is a small YAML file. It never contains model ids, prices or limits (those live in
provider descriptors); it refers to capabilities and task types.

This package is **not wired into the CLI, kernel, orchestrator or tools yet**. It ships the
schema, loader, detector and validator, plus the built-in packs. Seats S1, S4 and S5 wire
it in through the work items in `docs/adoption/WORK-ITEMS.md`.

## What a pack declares

- `id`, `name`, `description`, `profiles` — plain language.
- `markers` — extra project markers so the workspace guard accepts real workspaces
  (`*.ipynb`, `platformio.ini`, `project.godot`, …). A marker can be `optIn: true` for
  ambiguous files (a lone `*.bin` or `*.elf`); it counts only after the user agrees.
- `plans` — node-sequence hints for the profile (for example `explore → experiment →
report` for data science), mapped onto the **existing** core task types.
- `proposedTaskTypes` — new task types the profile needs, listed as a request for S1 (this
  package never edits `packages/core`).
- `reviewCriteria` — extra checks for the cross-provider critic on this profile's work.
- `tools` — suggested tools and MCP servers. **Suggestions only, never auto-installed.**
  `verified: false` marks anything not checked against a primary source (shown as `[U]`).
- `zones.add` / `zones.relax` — forbidden-zone additions, and explicit relaxations. A
  relaxation is shown to the user, needs approval, and **can never** open credential files
  (`.env`, keys, `.ssh`, …). Those defaults are immovable.
- `safety` — `requiresScope` for security packs, `preferLocal`, `physicalEffects`,
  `personalData`, and plain-language `limits`.
- `glossary` and `tips` — first-run help.

Security packs (reverse engineering, offensive) set `safety.requiresScope: true`. Before any
node runs, an `AuthorisedScope` (targets, engagement reference, expiry) must be declared; it
is shown in the plan and journaled. Packs serve authorised, defensive, research, CTF and
interoperability work. They never include features to evade detection or attack third parties.

## API

```ts
import { loadPacks, detectPacks, checkPackFiles, planZones, scopeProblems } from '@kernelpai/packs';

const { packs, problems } = await loadPacks({ repoRoot: process.cwd() });
const suggestions = await detectPacks(
  process.cwd(),
  packs.map((p) => p.pack),
);
```

- `loadPacks(opts)` — merge order **built-in → `$KPAI_HOME/packs` → `<repo>/.kpstudio/packs`**;
  a user pack overrides a built-in one by id, but safety and zone additions only tighten. A
  repository pack is untrusted: it may not reuse a built-in or user id (refused, see
  `admitRepoPack`) and its `zones.relax` is ignored (ADR-0025 addendum).
- `detectPacks(root, packs)` — suggests packs from the files present, inside a jail: bounded
  depth and entry count, never follows a symlink out of `root`, opens no file.
- `acceptsWorkspace(root, packs, optedIn)` — proposed replacement for the workspace guard.
- `pickPlanHint` / `hintToNodes` — pick and realise a plan hint (groundwork for S4).
- `planZones` / `isForbidden` — combine zone requests; credential zones always win.
- `scopeProblems` / `describeScope` — validate and render an authorised scope.
- `checkPackText` / `checkPackFiles` — validate packs with actionable messages.

## Validate a pack

```
node packages/packs/dist/bin.js path/to/pack.yaml
```

See `docs/adoption/PACK-AUTHORING.md` for the authoring guide and a template.

## Tests

`npx vitest run packages/packs --coverage` — 59 tests, no network, ≥ 80 % coverage.
