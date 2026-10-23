# ADR-0025 — Domain packs at the kernel boundary

**Status:** Accepted by the PO (proposed by S1; phase 3, D-020 WI-S1-01, WI-S1-03) · **Date:** 2026-10-23

## Context

D-018 to D-020 make KP Studio serve every technical domain through data packs
(`@kernelpai/packs`):

- S4's planner and runner use packs for plans, deliverables and the authorised scope;
- S7's tool bus applies pack zones;
- the PO is writing ADR-0023 on two-tier zones.

The kernel must decide which packs apply to a workspace, gather the user's decisions, show
them before anything runs, and hand them to S4 and S7. It must not weaken any rule.

## Decision

1. **Workspace guard (WI-S1-01).**
   - The home folder and filesystem roots are always refused.
   - Built-in project markers still accept a folder.
   - Otherwise the markers of the built-in and user packs can accept it (a folder of CSVs,
     a QGIS, Godot or PlatformIO project). Repository packs are not consulted: a folder
     cannot vouch for itself.
   - Opt-in markers (a lone binary or capture) count only after the human said yes once.
     The answer is stored in `$KPAI_HOME/workspace-optins.json` by real path.
   - The guard is `async`.
2. **Selection.**
   - Every pack whose markers match is selected, including repository packs, which can
     only tighten safety (see the addendum below for what that means exactly).
   - There is no cap: a cap could drop a pack that requires a scope or adds zones.
   - The generic pack is the fallback.
   - The plan, `kpai plan` and the protocol (`plan.packs`) show each pack's reason,
     evidence and safety flags. The run's `routing` journal entry records ids and reasons.
3. **Zones.**
   - The kernel gives S7's bus `packs: {enabled, approved, sessionId}` in the run, apply
     and listing buses, and it uses `policy.zoneSet()` for rules, checkpoints, restore and
     merge.
   - The plan shows every zone with its tier and origin, plus the pack additions,
     relaxations, pending relaxations and refusals (`describePackZones`).
   - A pending relaxation is asked once at run start. Each answer is stored as a
     `relaxKey` in `$KPAI_HOME/zone-approvals.json`, and a no is not asked again.
   - Plan-time reads (rules) never apply relaxations: no journal yet, so they fail closed.
4. **Authorised scope (WI-S1-03).**
   - The kernel gathers the scope from `--scope <file>`, from `options.scope`, or from
     `.kpstudio/scope.yaml`. A repository file is used only after the human confirms it.
   - The kernel shows `describeScope` lines and problems in the plan.
   - S4's runner validates the scope again, refuses or accepts it, and journals that.
     The kernel journals only a refusal it makes itself, before the runner is reached and
     before any budget question or worktree. Nothing is journaled twice.

## Consequences

A data, GIS or firmware folder works without a marker file, and the user sees which packs
shape the run and why. Pack decisions (opt-ins, zone approvals) persist per folder in
`$KPAI_HOME`, outside the repository. Detected packs count as "enabled" for S7's bus, and
user approval of each relaxation is what grants it. Asking "enable this pack" as a separate
step is left to the console (S6).

## Revisit when

The console offers pack enabling and disabling (S6), or packs are shared across a team
(phase 8).

## Addendum — repository packs are untrusted (review P3-F4, D-022)

**Date:** 2026-10-23 · proposed by S7.

The loader let a `<repo>/.kpstudio/packs` file reuse a built-in pack id: it replaced the
name, plans and prompts, and kept its own `zones.relax`, which the run-start question then
showed with the repository's own reason ("approving is safe and expected") under the
built-in pack's name. "Can only tighten" was true for the safety flags only.

1. **No id reuse.** A repository pack whose id is already a built-in or `$KPAI_HOME` pack is
   refused, with the reason in the plan's `packs.problems` ("reuses the id of a built-in
   pack: ignored"). It is not namespaced (`repo:<id>`): pack ids are a closed pattern used
   in relaxation keys, journals and the console, and a near-identical id would still read
   as the trusted pack. A user pack may still override a built-in one (`mergeOverride`).
2. **No relaxations.** `zones.relax` from a repository pack is dropped and reported; its
   `zones.add` and safety flags apply. Relaxations come only from built-in and user packs.
3. **Never replaces an earlier layer.** Together, 1 and 2 mean a repository file cannot
   change an earlier layer's plans, prompts, name or relaxations.
4. **Repository text in questions is quoted and labelled.** The `.kpstudio/scope.yaml`
   confirmation says its lines are "from a repository file (untrusted)" and quotes each
   one. A relaxation reason (now always from a built-in or user pack) is quoted on one
   line as "given by the pack file, not verified". Control, bidi and zero-width
   characters are removed from both.

Consequence: a team that shared a relaxation through the repository must now put that
pack in each member's `$KPAI_HOME/packs` (revisit with phase 8, team packs).
