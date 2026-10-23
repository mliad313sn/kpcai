# KernelPAI — Delivery charter

Status: in force from 2026-10-23. Owner: Product Owner.

## 1. Appointment and delegation

On 2026-10-23 the Sponsor (repository owner) appointed a **Product Owner (PO)** "in charge to build the team, delegate authorization and drive the execution and design and decision of the project from end to end".

| Role                          | Holder                                                   | Accountable for                                                                                                          | Decision rights                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sponsor**                   | Repository owner (human)                                 | Funding, legal, external contracts                                                                                       | Reserved decisions only (§5)                                                                                                                                                                                                                                 |
| **Product Owner**             | Claude Code — orchestrating session                      | Vision, backlog order, phase scope, design and architecture decisions, team composition, quality gates, `docs/STATUS.md` | Every product, design, architecture, sequencing and acceptance decision not reserved in §5. Appoints and dismisses team seats, delegates work to them, accepts or rejects their output, accepts a phase as done against `docs/BUILD_PROMPT.md` exit criteria |
| **Team seats** (§2)           | Specialised sub-agents appointed by the PO               | The work package they are given                                                                                          | Decide inside their package; anything that changes a contract in `packages/core` or an ADR goes back to the PO                                                                                                                                               |
| **Independent reviewer** (§4) | A sub-agent that built nothing in the phase under review | Gate review                                                                                                              | Can block a gate with a confirmed Critical/High finding                                                                                                                                                                                                      |

The PO records every decision taken under this delegation in `docs/governance/DECISIONS.md` with date, rationale and the alternative rejected, and prefers the reversible, conservative option.

## 2. Team (standing seats)

Seats are lenses and work-package owners, executed by sub-agents defined in `.claude/agents/`. Each work package names one lead seat.

| #   | Seat                          | Expertise                                                              | Leads                                                                            |
| --- | ----------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| S1  | Kernel architect              | Contracts, monorepo, ADRs, performance budgets                         | Core contracts, phase design, ADR review                                         |
| S2  | Provider & catalog engineer   | LLM APIs, SDKs, streaming, pricing catalogs                            | Adapters, capability sheets, catalog sync                                        |
| S3  | Routing & learning engineer   | Scoring, ranking, evaluation, statistics                               | Router, budget governor, competence learning, bench                              |
| S4  | Orchestration engineer        | DAG execution, protocols, concurrency, cancellation                    | Executor, fallback, planner, protocols                                           |
| S5  | Tools & sandbox engineer      | MCP, process isolation per OS                                          | Tool bus, shell sandbox, git/fs tools                                            |
| S6  | Interface engineer            | Tauri, React, Ink, accessibility                                       | Desktop console, TUI, onboarding                                                 |
| S7  | Security & privacy engineer   | Threat modelling, secrets, data egress, prompt injection               | Forbidden zones, keychain, audit, egress review                                  |
| S8  | QA & reliability engineer     | Test design, fault injection, CI, observability                        | Test strategy, coverage, demos, metrics                                          |
| S9  | Engagement & adoption analyst | Personas, use-case coverage, friction and onboarding research          | Adoption audits, domain packs, adoption fixes (Sponsor appointment, D-018)       |
| S10 | Strategy & systems consultant | Systems thinking, human factors, economics, safety engineering, ethics | Whole-scope reviews, simplicity and ecosystem value (Sponsor appointment, D-027) |

## 3. Operating model

1. **Plan** — PO writes `docs/plans/phase-N.md`: work packages, owners, contracts, acceptance tests.
2. **Contract first** — S1/PO lands shared types in `packages/core` before packages are built in parallel.
3. **Build** — seats work in disjoint directories; they run their package's tests, lint and typecheck; they do not commit. The PO integrates, runs `pnpm check`, commits and pushes.
4. **Gate** — independent review (§4), then the PO ticks each exit criterion. Anything that cannot be met in this environment is recorded as _deferred with reason_, never silently ticked.
5. **Report** — `docs/PHASE-N-REPORT.md`, `scripts/demo-phaseN.mjs`, `docs/STATUS.md` updated.

The non-negotiable principles of `docs/KERNELPAI_MASTER_PROMPT.md` §2 override any local optimisation.

## 4. Independent review

At each phase gate the PO appoints a reviewer that did not build the phase. Process: **Review** (read-only; each finding with file:line, failure scenario, reproduction) → **Verify** (PO or a second reviewer tries to refute it) → **Correct** (fix + regression test) → **Re-verify**. Severity Critical/High must be fixed before the gate passes; Medium fixed or PO-accepted with reason; Low logged in `docs/BACKLOG.md`.

## 5. Limits of the delegation (reserved to the Sponsor)

The PO cannot decide these, because they need a legal person, money or an external contract:

- **Licence** of the code and any contributor agreement.
- **Spending real money**: API keys, paid model calls, paid services. The PO uses offline fakes and only calls live services with keys the Sponsor supplies for that purpose.
- **Publishing**: making the repository public, releases, package registries, announcements.
- **Merging to the default branch or opening pull requests**, unless the Sponsor asks.
- **Third-party terms**: accepting provider terms of service, data-processing terms, model licences (e.g. Arch-Router's).
- **Human-only checks**: screen-reader sessions, penetration tests, user interviews.

When one of these blocks progress, the PO records it in `docs/governance/OPEN-QUESTIONS.md`, picks the reversible default, and continues.
