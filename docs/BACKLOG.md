# Backlog

Items deferred with a reason. Severity from gate reviews where applicable.

| #    | Item                                                                                                                                                                        | Origin                        | Target            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------- |
| B-1  | ~~Estimated cost of partial output on failed attempts (D-007)~~ — done (review F3)                                                                                          | S4 report                     | Phase 2           |
| B-2  | Competence priors calibrated on public leaderboards (Aider polyglot, LMArena categories); currently tier-based judgement documented in `descriptors/COMPETENCE.md`          | S2 report                     | Phase 4 (bench)   |
| B-3  | Tiered prices (long-context) as fields, not notes                                                                                                                           | S2 report                     | Phase 1.x / 4     |
| B-4  | Reasoning/thinking parts as stream events                                                                                                                                   | S2 report                     | Phase 2           |
| B-5  | Spend table per model / task type / project with export (spec §3.4)                                                                                                         | S3 report                     | Phase 3 (console) |
| B-6  | Classifier misses some code prompts ("write a parser" → analysis); replace rules with embeddings or a local model behind `classify()`                                       | PO demo run                   | Phase 2           |
| B-7  | Live validation of the 9 cloud/local adapters and of the estimate/real gap (needs Sponsor keys, Q-2)                                                                        | PO                            | When Q-2 answered |
| B-8  | Provider-reported token counting (Anthropic `count_tokens`, tokenizers) to calibrate estimates                                                                              | ADR-0005                      | Phase 1.x         |
| B-9  | Gate the task limit on worst-case cost, or clamp the output cap to the remaining budget (review F11)                                                                        | Phase 1 review                | Phase 2           |
| B-10 | Typical latency per model, measured locally, so the latency weight matters (review F14)                                                                                     | Phase 1 review                | Phase 4           |
| B-11 | Router reason in display currency; project key = repository root, not raw cwd (review F16)                                                                                  | Phase 1 review                | Phase 2           |
| B-12 | Print loaded override descriptors in `kpai providers` and warn on first use (ADR-0015)                                                                                      | ADR-0015                      | Phase 2           |
| B-13 | `stats` by estimate basis / time window, so calibrated accuracy is visible separately from cold-start                                                                       | PO                            | Phase 2           |
| B-14 | A stall after reasoning but before any text is billed 0 (no usage, no partial text): estimate reasoning time/tokens                                                         | Phase 1 final re-verification | Phase 4           |
| B-15 | `kpai run` builds the registry twice, so override warnings print twice                                                                                                      | Phase 1 final re-verification | Phase 2           |
| B-16 | F8 residual: a user override can name another provider's key and send it to its own https host — show loaded overrides and ask on first use (with B-12)                     | Phase 1 review                | Phase 6           |
| B-17 | F9 residual: piped stdout stays raw by design; document and offer `--sanitize`                                                                                              | Phase 1 review                | Phase 6           |
| B-18 | Patches accept LRM/RLM/ALM marks (U+200E, U+200F, U+061C); consider refusing them too (nit)                                                                                 | Phase 2 review                |
| B-19 | With an isolating shell sandbox, allow-listed `git diff`/`git log` via `shell.run` bypass zone filtering: route them to the filtered git tools or hide zones in the sandbox | Phase 2 review                |
| B-20 | Policy glob matcher treats `[...]` literally while git treats it as a class; align (output filter still catches)                                                            | Phase 2 review                |
