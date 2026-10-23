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
     only tighten safety.
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
