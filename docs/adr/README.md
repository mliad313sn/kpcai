# Architecture Decision Records

One page per decision. Format: Context, Decision, Consequences, Revisit when.

| #                                                    | Title                                                                     | Status   |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| [0001](0001-stack-and-monorepo.md)                   | Stack and monorepo layout                                                 | Accepted |
| [0002](0002-provider-adapter-contract.md)            | Provider adapter contract (own port)                                      | Accepted |
| [0003](0003-anthropic-adapter.md)                    | Anthropic adapter on the official SDK                                     | Accepted |
| [0004](0004-sqlite-driver.md)                        | SQLite driver: `node:sqlite` behind the Journal API                       | Accepted |
| [0005](0005-cost-estimation.md)                      | Cost estimation and currency                                              | Accepted |
| [0006](0006-secrets.md)                              | Secrets until phase 6                                                     | Accepted |
| [0007](0007-journal-hash-chain.md)                   | Append-only hash-chained journal                                          | Accepted |
| [0008](0008-provider-descriptors.md)                 | Provider descriptors in YAML                                              | Accepted |
| [0009](0009-no-default-model-phase0.md)              | No default model and budget gate in phase 0                               | Accepted |
| [0010](0010-ai-sdk-generic-adapter.md)               | One generic adapter on the Vercel AI SDK                                  | Accepted |
| [0011](0011-competence-router.md)                    | Competence router: filters, score, reason                                 | Accepted |
| [0012](0012-task-classifier.md)                      | Heuristic task classifier                                                 | Accepted |
| [0013](0013-display-currency.md)                     | Display currency                                                          | Accepted |
| [0014](0014-budget-governor.md)                      | Budget governor and spend ledger                                          | Accepted |
| [0015](0015-untrusted-text-and-provider-trust.md)    | Untrusted text and provider trust boundaries                              | Accepted |
| [0016](0016-sessions-fallback-budget-calibration.md) | Sessions, budget-checked fallbacks, stall timeouts, calibration           | Accepted |
| [0017](0017-graph-protocols-and-tool-contracts.md)   | Task graph, protocols and tool contracts                                  | Accepted |
| [0018](0018-graph-cli.md)                            | `kpai plan` / `kpai do`: planning, gating and patches                     | Accepted |
| [0019](0019-kernel-service-and-console-server.md)    | Kernel service layer and console server protocol (addendum: P3 review)    | Accepted |
| [0020](0020-run-control-and-pinned-models.md)        | Run control and user-chosen models                                        | Accepted |
| [0021](0021-checkpoints-rules-and-run-worktrees.md)  | Checkpoints, repository rules and run worktrees in the kernel             | Accepted |
| [0022](0022-non-code-artifacts.md)                   | Non-code artifacts next to patches                                        | Accepted |
| [0023](0023-two-tier-forbidden-zones.md)             | Two-tier forbidden zones and pack relaxations                             | Accepted |
| [0024](0024-domain-task-types.md)                    | Domain task types in core, scored on a base type                          | Accepted |
| [0025](0025-packs-at-the-kernel-boundary.md)         | Domain packs at the kernel boundary                                       | Accepted |
| [0026](0026-cost-cap-is-the-band-top.md)             | The cost cap is the top of the band (D-021)                               | Accepted |
| [0027](0027-unified-memory.md)                       | Unified memory: layers, provenance, propose → confirm, budgeted injection | Accepted |
| [0028](0028-grading-and-measured-competence.md)      | Grading, measured competence and the bench                                | Accepted |
| [0029](0029-replay-fork-disputes-review-policy.md)   | Run records, replay, fork, fail-closed disputes, review policy            | Accepted |
| [0030](0030-phase4-kernel-wiring.md)                 | Productivity, review policy from config, replay/fork CLI, home zone       | Accepted |
