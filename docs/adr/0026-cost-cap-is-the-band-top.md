# ADR-0026 — The cost cap is the top of the band

**Status:** Accepted by the PO (proposed by S1; phase 3, D-021) · **Date:** 2026-10-23

## Context

Before a run, the kernel shows a cost band (R-302, ADR-0017) and the user approves a figure.
Until now that figure was the expected sum (`estimate.totalUsd`). The kernel used it three
times:

- for the whole-graph budget check before the run (governor: block or confirm);
- in the confirmation question;
- as the run's hard cap (`maxGraphUsd`, review P2-F9): spending past it asks again.

The band's top sat above that cap on every plan (S8 bug 3). A run that cost more than
average, but stayed inside its own band, was stopped halfway with a "graph total"
question. That is the surprise principle 6 and spec §4.5 rule out. D-021 says that cost
before execution means the worst plausible cost.

## Decision

1. **Two figures, one meaning each.** The kernel's plan estimate carries:
   - `expectedUsd`, the likely cost: the sum of the nodes' expected costs, equal to
     `totalUsd`;
   - `capUsd`, the cap: `band.highUsd`, the top of the estimate band.
2. **The cap is what is approved and enforced.**
   - The whole-graph budget check (`Governor.check`) uses `capUsd`.
   - The confirmation question states both figures: "graph estimate up to $Y (cap; likely
     $X)".
   - The run's `maxGraphUsd` is `capUsd`. Spending past it still asks again, or continues
     with `overBudget` (BudgetGate "graph total", unchanged).
3. **Shown everywhere the same way.**
   - The protocol's `EstimateSchema` gains optional `expectedUsd` and `capUsd`. They are
     optional only so older kernels still parse. This kernel always sends them on `plan`
     and `plan.validate`.
   - `kpai plan` and `kpai do` print `total  likely $X · at most $Y (cap)`.
   - KP Studio (S6) shows the same two figures.
4. **Band accuracy stays with the orchestrator (S3).** The kernel takes `band.highUsd` as
   it is. The kernel does not widen or clamp the band, so the figure the user sees is the
   figure enforced.

## Consequences

- Fewer runs stop halfway. A run now stops only when it leaves its own band.
- The approved figure is higher. On cold-start plans the heuristic band can be several
  times the likely cost. More plans therefore reach the confirmation threshold, and some
  reach a budget block, earlier than before. This is intended (D-021), and it makes band
  accuracy matter: S3 is narrowing the band from history (S8 bug 2).
- If a calibrated band's top ever falls below the expected sum, the cap is below the
  likely figure. The run then asks again before reaching the likely cost. The kernel does
  not hide this. The orchestrator should guarantee `band.highUsd >= totalUsd`.
- No contract in `packages/core` changes. `maxGraphUsd` keeps its meaning: the cap the
  user accepted.

## Protocol additions in the same change (ADR-0019)

All of these are optional or additive. No client breaks.

- R-303: every planned step (`estimate.nodes[].steps[]`) carries `reason`, `score`,
  `parts` and `runnerUp`. They come from the decision the estimator priced that step on:
  the same prompts, task types, critic, judge, voter and review exclusions, pinned models
  and pack rules. The kernel records those decisions with a `DecisionLog` router wrapper.
  It does not re-route without these constraints (S8 bug 1).
- `providers.list` reports each provider's `kind` (required) and `testAllowed`.
- `kpai studio --allow-test` sets the server's default `RunOptions.allowTest`. A request's
  own options still win. `plan.validate` checks an edit with its plan's options, so test
  providers stay refused unless that plan allowed them.

## Alternatives considered

- **Keep the expected sum as the cap and show the band beside it.** Rejected: this is S8
  bug 3. The cap sits inside the band, so ordinary runs get stopped.
- **Use `max(band.highUsd, totalUsd)`.** Rejected: it hides a band defect instead of
  reporting it. The orchestrator owns that invariant.
- **Use a margin above the expected sum (for example +50 %).** Rejected: the margin is
  arbitrary, and it differs from the band the user sees.

## Revisit when

- Live calls give measured band hit rates. If runs often end above `band.highUsd`, the cap
  needs its own margin.
- A user asks to set the cap by hand, for example a per-run limit below the band's top.
