# ADR-0024 — Domain task types in core, scored on a base type

**Status:** Accepted by the PO (proposed by S1; phase 3, D-020 WI-S1-04) · **Date:** 2026-10-23

## Context

The built-in packs propose nine task types that core does not have:

- `reverse_engineering`
- `security_assessment`
- `data_analysis`
- `design`
- `game_design`
- `cad_modelling`
- `geospatial_analysis`
- `creative_writing`
- `translation`

Until now each one was mapped onto an existing type through the pack's `mapsTo`, which
loses the distinction in routing, the journal and the stats. Adding enum values must not
break routing: capability sheets score only the original seven types.

## Decision

1. **`TaskTypeSchema`** gains the nine types. This is additive, so every existing
   descriptor, journal entry and plan stays valid. `ModelCard.competence` is a partial
   record, so a sheet may score a new type but does not have to.
2. **`TASK_TYPE_BASE`** in core maps every type to one of the seven base types (the base
   types map to themselves). It mirrors the packs' `mapsTo`:
   - `analysis`: reverse_engineering, security_assessment, data_analysis,
     geospatial_analysis;
   - `writing`: design, game_design, creative_writing;
   - `code_generation`: cad_modelling, translation.
3. **The router** (`staticCompetence`) scores a type with the card's own prior when the
   card gives one, or when the card lists the type as a strength or weakness. Otherwise it
   uses the base type's competence. Routing for a new type is never worse than for the type
   it refines, and a sheet can specialise it later. Measured competence keys on the exact
   type and starts empty, which leaves the prior in force.
4. `kpai route --type` accepts every core type (the CLI list is the core enum).

## Consequences

Packs and planners can name the real kind of work, and it reaches the journal and the
stats. The heuristic classifier (`packages/executor/src/classify.ts`) does not yet _pick_
the new types. They come from packs, planners or `--type`. Teaching the classifier is
left to S3/S4 with measured cue lists. S4's `resolveTaskType` still maps proposed types to
`mapsTo`; it can now keep the core type.

## Revisit when

A tenth type is proposed (keep the base map total, which a test enforces), or measured
competence shows a domain type routing worse than its base.
