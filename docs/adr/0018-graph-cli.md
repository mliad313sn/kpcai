# ADR-0018 — `kpai plan` / `kpai do`: planning, gating and patches

**Status:** Accepted (phase 2) · **Date:** 2026-10-23

## Decision

- **Planner:** the template planner is the default (free, instant, deterministic, explainable). `--planner model` asks a routed model for a JSON plan (validated, template fallback). The plan is always printed with each node's protocol, first-choice model, dependencies, tools and a min–expected cost before anything runs.
- **Budget, twice:** the whole graph's expected cost goes through the governor first (block → stop unless `--over-budget`; above the threshold → confirm or `--yes`), then every model step and fallback is gated again while running (ADR-0016).
- **Patches:** only `code_generation` and `test` nodes that succeeded and were **approved by their critic** contribute patches; identical patches are applied once. Patches are always shown; they are applied only with `--apply`, through the tool bus (`git.apply`: jailed, `--check` first, write permission confirmed unless `--yes`).
- **Live feed:** the CLI prints one line per `GraphEvent` that matters (who works on which node and in which role, each contribution's cost and verdict, node end). Phase 3's console consumes the same events.
- **Sessions** resume as for `kpai run` (`--new-session` forces a new one).
- The AI SDK's own warning log is switched off; KernelPAI reports what matters itself.

## Consequences

The success-criterion flow — plan visible, different models per role, a reviewer from another provider, cost before launch, a clean diff — runs end to end offline (`scripts/demo-phase2.mjs`). A model planner and live providers are one flag away but cost money, so they are opt-in.
