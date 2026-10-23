# ADR-0020 — Run control and user-chosen models

**Status:** Accepted by the PO (phase 3, WP2 by seat S4; recorded by S1) · **Date:** 2026-10-23

## Context

R-301 (an edited plan is the plan that runs) and R-304 (steer a run mid-way) let the user
pick models, and principle 4 says the user decides. The router's guarantees (fallback,
diversity) must not silently override that choice.

## Decision

1. **Only a node's first step uses the chosen model.** That step is the solo answer, the
   author, the first debater or the first voter, set by `PlannedNode.model` or by a
   redirect. Later steps are routed as usual: critics stay away from the author's
   provider, and revisions stay on the author's model. A redirect re-routes the critic
   when diversity requires it.
2. **A pinned step has no automatic fallback.** If the chosen model fails, the failure is
   reported rather than replaced by another model, and the user can redirect again.
   Budget gates and `maxGraphUsd` still apply, and a redirect asks again.
3. **Control events use their own feed**, `OrchestratorOptions.onControl`:
   - the events are `run_paused`, `run_resumed`, `run_cancelled`, `node_redirected`,
     `instruction_added` and `control_refused`;
   - `GraphEvent` (core) is unchanged;
   - every action, refusals included, is journaled as an intervention;
   - the kernel maps these events to `run.state` and `run.control` (ADR-0019).

## Consequences

The core contract stays stable, and a console can show exactly what the user chose. A
pinned model that is down stops its node until the user acts. This is the cost of never
swapping a choice silently.

## Revisit when

Users ask to pin later roles (for example "this critic"), or for a fallback list per node.
