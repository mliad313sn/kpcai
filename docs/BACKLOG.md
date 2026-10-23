# Backlog

Items deferred with a reason. Severity from gate reviews where applicable.

| #   | Item                                                                                                                                                               | Origin      | Target            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ----------------- |
| B-1 | Estimated cost of partial output on failed attempts (D-007)                                                                                                        | S4 report   | Phase 2           |
| B-2 | Competence priors calibrated on public leaderboards (Aider polyglot, LMArena categories); currently tier-based judgement documented in `descriptors/COMPETENCE.md` | S2 report   | Phase 4 (bench)   |
| B-3 | Tiered prices (long-context) as fields, not notes                                                                                                                  | S2 report   | Phase 1.x / 4     |
| B-4 | Reasoning/thinking parts as stream events                                                                                                                          | S2 report   | Phase 2           |
| B-5 | Spend table per model / task type / project with export (spec §3.4)                                                                                                | S3 report   | Phase 3 (console) |
| B-6 | Classifier misses some code prompts ("write a parser" → analysis); replace rules with embeddings or a local model behind `classify()`                              | PO demo run | Phase 2           |
| B-7 | Live validation of the 9 cloud/local adapters and of the estimate/real gap (needs Sponsor keys, Q-2)                                                               | PO          | When Q-2 answered |
| B-8 | Provider-reported token counting (Anthropic `count_tokens`, tokenizers) to calibrate estimates                                                                     | ADR-0005    | Phase 1.x         |
