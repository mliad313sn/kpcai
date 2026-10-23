# Competence priors (`competence:` on model cards)

Static priors in [0, 1] per task type, used by the router as `card.competence[type]`
until measured competence (phase 4) has enough samples to take over. They rank
models; they are not benchmark scores. Re-check them whenever a card changes.

## Method (2026-10-23)

1. **Tier from models.dev** (`api.json`, fetched 2026-10-23): the provider's
   flagship (described as most capable, highest list price, reasoning enabled)
   starts at 0.85–0.93; the cheap tier starts at 0.60–0.78; unknown local models
   start at 0.40–0.50.
2. **Capability flags from models.dev**: `reasoning: true` keeps analysis,
   critique and decision at the tier top; the model description (for example
   "coding", "agentic engineering", "visual reasoning") moves `code_generation`
   and `test` up by about 0.02–0.04; text-only input lowers `research` slightly.
3. **Order within a tier** across providers is a judgement call from list price,
   release date and the vendor's own positioning. Public leaderboards (LMArena,
   SWE-bench Verified, Aider polyglot) were **not** consulted in this pass; doing
   so is an open follow-up before the priors are trusted for close calls.
4. Spread between task types for one model stays within ±0.06 of its tier: the
   priors express "which model is better at what", not absolute quality.

## Local defaults

`ollama` and `llamacpp` `defaultLocalCard` priors (0.40–0.50) assume a small
quantised model of unknown family, so a cloud model wins on quality-weighted
profiles unless the user prefers local (`localOnly`, `economy`). Override per
model in `$KPAI_HOME/providers/*.yaml` once a local model is known.

## Not covered

`mock` (kind `test`) has no priors on purpose: it is excluded from routing by
default and other packages' tests rely on its `strengths` only.
