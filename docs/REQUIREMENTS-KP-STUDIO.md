# KP Studio — new requirements from the October 2026 benchmark

Owner: Product Owner (D-016) · 2026-10-23 · Source: [benchmark/BENCHMARK-2026-10.md](benchmark/BENCHMARK-2026-10.md).

The master prompt (`KERNELPAI_MASTER_PROMPT.md` §3–§9) stays the base. This document **adds**
requirements so that KP Studio (Kernel Project Studio) matches 2026 table stakes and owns the
white spaces no competitor covers. Each requirement has an id, a priority, the phase that
builds it, an acceptance test, and the benchmark item behind it (T = table stake, W = white
space, see benchmark §3 and §4).

Priorities: **Must** = needed for the phase gate · **Should** = planned in the phase, may slip
one phase with a PO decision · **Could** = backlog.

## Positioning (one sentence)

> KP Studio is the local-first studio where several AI models design, build and verify
> software together — every choice explained, every cost known before it is spent, every
> artifact traceable from requirement to test.

What KP Studio is not: an editor (it runs beside one or inside one through ACP), a no-code
app builder, a hosted model gateway, or a benchmark race (model choice drives scores).

## Phase 3 — Console (KP Studio web, desktop, terminal)

| Id    | Pri    | Requirement                                                                                                                                                                                           | Acceptance                                                                                                         | Basis      |
| ----- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------- |
| R-301 | Must   | **Task graph is the main view**: before launch the user can edit nodes (model, protocol, criticality, budget), remove or add nodes, then approve. The approved plan is the one that runs.             | e2e: edit a node's model in the plan view, approve, journal shows the edited model ran                             | W9, T3     |
| R-302 | Must   | **Cost as a range**: the pre-run estimate shows a low–high band (from calibration spread), the hard cap, and a live meter during the run.                                                             | Plan view shows band and cap; meter updates on each `response` event; run stops at the cap                         | W4, T8     |
| R-303 | Must   | **Why this model**: each node shows the router's one-line reason, score breakdown and the runner-up, one click from the graph.                                                                        | e2e: click a node, see reason and alternatives identical to `kpai route --verbose`                                 | W3         |
| R-304 | Must   | **Steer mid-run**: pause, resume, redirect a node to another model, add an instruction to a pending node; finished work is kept.                                                                      | Kernel tests for pause/resume/redirect; e2e redirect from the UI                                                   | T12        |
| R-305 | Must   | **Checkpoints and rollback**: before any patch is applied, a checkpoint is taken (shadow git ref, never the user's branch); one action restores the workspace to any checkpoint of the run.           | Test: apply 2 patches, roll back to checkpoint 1, tree equals checkpoint 1; user's branches and stash untouched    | T, love #5 |
| R-306 | Must   | **Repository rules ingested**: AGENTS.md, CLAUDE.md, GEMINI.md, `.cursor/rules`, `.github/copilot-instructions.md` are read (inside the jail), shown in the plan and passed to every node as context. | Fixture repo with AGENTS.md: plan view lists it; mock adapter receives it; files in forbidden zones are never read | T5         |
| R-307 | Must   | **Parallel runs in isolated worktrees** with a manager view (run, state, cost, diff, critic verdict). Each run gets its own `git worktree` under `$KPAI_HOME`; merging back is an explicit action.    | Two runs at once on one repo; each diff isolated; no write outside its worktree                                    | T1         |
| R-308 | Should | **Onboarding under 3 minutes**, including a $0 path with local models only.                                                                                                                           | Scripted first run with Ollama fake: from launch to first finished task in < 3 min wall time                       | W13        |

## Phase 4 — Memory, learning and evidence

| Id    | Pri    | Requirement                                                                                                                                                                                                            | Acceptance                                                                                                | Basis     |
| ----- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------- |
| R-401 | Must   | **Routing learns from outcomes in this repository**: critic verdicts, test results, patches accepted, rolled back or reverted update per-repo competence; the reason line cites it ("approved 14/16 test tasks here"). | Bench: after a scripted history, routing for the same task type changes and the reason cites the evidence | W3        |
| R-402 | Must   | **Published estimate accuracy**: a stats view of estimate vs actual per task type, with the share of runs inside the band. Shown before launch next to the estimate.                                                   | `kpai stats` and the UI report the in-band rate from the journal                                          | W4        |
| R-403 | Must   | **Replay and fork**: rerun any node with another model from the journal, compare outputs side by side.                                                                                                                 | e2e: fork node n2 with another provider; both answers and costs shown                                     | spec §3.5 |
| R-404 | Should | **Verification ROI and review spend policy**: per run, cost of critics vs issues they raised that led to a revision; a policy sets review depth by criticality (none, one critic, debate, vote).                       | Run report shows review cost and accepted findings; policy changes the protocol chosen                    | W2, risk  |
| R-405 | Should | **Disagreement surfaced**: when critics or voters disagree, the node shows it and asks the human instead of silently picking.                                                                                          | Mock vote 1–1–1: node is marked "disputed" and needs a choice                                             | W2        |
| R-406 | Should | **Honest productivity metrics** from the journal: time and cost per accepted change, rework and rollback rate, defects caught by review. No self-reported or vendor numbers.                                           | Stats computed only from journal events; documented formulas                                              | W12       |

## Phase 5 — Tools, extensions, other agents

| Id    | Pri    | Requirement                                                                                                                                                                                                                                        | Acceptance                                                                                         | Basis    |
| ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| R-501 | Must   | **MCP registry with pinning**: servers come from an allow-list; each is pinned by version and content hash; a changed tool description or schema is blocked until re-approved (rug-pull defence); per-server egress allow-list.                    | Test: modify a pinned server's tool description → calls refused with a clear message               | W7, T4   |
| R-502 | Must   | **Skills, hooks and named agents** in the Claude Code skill format (SKILL.md), with lifecycle hooks (before plan, before tool, after patch). Hooks run through the tool bus and its permissions.                                                   | Fixture skill loaded and used by a node; a hook can veto a tool call                               | T4, T5   |
| R-503 | Should | **External agents as graph nodes**: Claude Code, Codex, Gemini CLI and opencode run headless as a node's author, under the user's own account and auth, in the node's worktree, within the run budget, reviewed by a critic from another provider. | Fake CLI agent binary in tests; budget and critic apply; no subscription credentials handled by KP | W10      |
| R-504 | Should | **ACP agent server**: KP Studio can run as an agent inside Zed and JetBrains through the Agent Client Protocol.                                                                                                                                    | Protocol conformance test against a fake ACP client                                                | T9       |
| R-505 | Must   | **Tests as evidence**: a test runner tool; test results feed the critic and the competence record (R-401).                                                                                                                                         | Failing test turns an approval into a revision request                                             | spec §9  |
| R-506 | Should | **UI-aware verification**: Playwright screenshots of changed screens are given to a vision-capable critic; visual diff before/after.                                                                                                               | Fixture app: screenshot captured and attached to the critic call                                   | love #15 |
| R-507 | Should | **Background runs**: the kernel keeps running with the UI closed; desktop notification on confirmation needed or run done.                                                                                                                         | Close client mid-run, reconnect, run state and confirmations intact                                | T2       |
| R-508 | Could  | **Draft pull request output** to the user's own remote, after explicit confirmation.                                                                                                                                                               | Fake git remote receives a branch                                                                  | T2       |

## Phase 6 — Hardening, trust and compliance

| Id    | Pri    | Requirement                                                                                                                                                                                                        | Acceptance                                                                     | Basis           |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------- |
| R-601 | Must   | **Sensitive work stays local**: nodes that read forbidden-zone-adjacent or user-tagged sensitive paths are routed to local providers only; the plan shows the restriction.                                         | Fixture: sensitive node never routed to a cloud provider, even if cheaper      | W6              |
| R-602 | Must   | **Air-gap mode**: one switch; any non-loopback connection is refused and the refusal journaled; local models only.                                                                                                 | Test with a fake remote: no socket opened; demo runs fully offline             | W13             |
| R-603 | Must   | **Provenance export**: per run, Agent Trace records (code range → conversation → model), git notes under `refs/notes/kpai`, and a CycloneDX AIBOM listing models and providers used; commit trailers name the run. | Export validated against the published schemas; trailers present               | W5              |
| R-604 | Must   | **EU AI Act Article 50 transparency**: AI-generated content and changes are labelled (UI, exports, commit trailers); a transparency notice ships with the product.                                                 | Checklist in the phase report; labels present in exports                       | §7              |
| R-605 | Must   | **No bypass mode**: no flag, setting or environment variable disables forbidden zones or the jail; repository, issue and web content is untrusted, and a tool call proposed after reading it needs confirmation.   | Red-team suite: injection fixtures cannot read zones or run unconfirmed writes | W7, s1ngularity |
| R-606 | Must   | **Supply chain**: pinned lockfile, minimal runtime dependencies, CycloneDX SBOM of KP Studio in CI, provenance attestations; release signing set up for the Sponsor to run.                                        | SBOM artifact on every CI run; dependency diff reviewed at the gate            | LiteLLM         |
| R-607 | Must   | **Secrets**: OS keychain vault; secret scanning on model inputs and outputs; redaction before anything is journaled.                                                                                               | Seeded secrets never appear in the journal or exports                          | B §4            |
| R-608 | Should | **Region-aware routing**: a profile limits routing to providers and endpoints in chosen regions (for example EU only).                                                                                             | Router test: non-EU candidates excluded with a reason                          | B §4            |
| R-609 | Must   | **Accessibility and speed**: WCAG 2.2 AA (axe in CI, keyboard-only paths), < 100 ms for local actions (spec).                                                                                                      | axe zero serious issues; latency budget test                                   | spec            |

## Phase 7 — Conception (new phase)

The "conception" half of the vision: from intent to verified screens and code, linked end
to end. Built on the phase 3–6 kernel; no new trust boundary.

| Id    | Pri    | Requirement                                                                                                                                                                                                                                                                                                     | Acceptance                                                                                                       | Basis                 |
| ----- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| R-701 | Must   | **Traceable chain**: requirement → user story → UX flow → screen → component → commit → test are typed artifacts with stable ids, linked both ways, stored in the repo (`.kpstudio/`) and in the journal. Impact view: "what implements and tests requirement X?" and "which requirement does this line serve?" | Fixture project: query both directions; a change to a requirement marks dependent artifacts as stale             | W1                    |
| R-702 | Must   | **Spec workflow scaled to the task**: requirements, design and tasks documents generated for large requests, a one-paragraph spec for small ones; kept in sync as the run progresses.                                                                                                                           | Small request → no spec ceremony; large request → three documents updated as nodes finish                        | T3, Kiro complaint    |
| R-703 | Must   | **Design-system aware generation**: ingest the repo's components and design tokens, Figma through its MCP server (Code Connect), Make kits and exports from Stitch or Claude Design; generation uses existing components; a critic from another provider checks token, component and accessibility conformance. | Fixture design system: generated screen uses only known components and tokens; violations reported by the critic | W11                   |
| R-704 | Must   | **Security critic for generated apps**: authorization, row-level security, secrets in client code, injection; blocking for criticality ≥ normal.                                                                                                                                                                | Fixture app with missing RLS is rejected with the finding                                                        | B §1 (CVE-2025-48757) |
| R-705 | Should | **UX flow canvas**: multi-screen flows generated and edited visually, previewed live in a local sandbox, linked to their requirements.                                                                                                                                                                          | e2e: generate a 3-screen flow, edit one screen, links preserved                                                  | love #15              |
| R-706 | Should | **Two personas**: product and design roles get read, comment and approve views of requirements, flows and screens without handling code.                                                                                                                                                                        | Role-limited view in e2e                                                                                         | B risk                |
| R-707 | Could  | **Deploy to the user's own hosting** (preview environments), never a KP-hosted runtime.                                                                                                                                                                                                                         | Fake deploy target receives the build                                                                            | Bolt precedent        |

## Phase 8 — Team and enterprise (after v1.0)

| Id    | Pri    | Requirement                                                                                                | Basis |
| ----- | ------ | ---------------------------------------------------------------------------------------------------------- | ----- |
| R-801 | Should | Self-hosted team server; SSO/SAML, SCIM, role-based access, per-agent and per-tool policies set by admins. | B §4  |
| R-802 | Should | Pooled budgets, alerts and chargeback by team and project.                                                 | B §4  |
| R-803 | Should | Audit export to SIEM (OpenTelemetry), retention policies, journal verification report for auditors.        | B §4  |
| R-804 | Could  | Opt-in, anonymised sharing of competence evidence across teams (community benchmark).                      | W3    |
| R-805 | Could  | ISO/IEC 42001 readiness pack (scope, controls mapped to features).                                         | B §4  |

## Program and Enterprise mode (D-025, D-026, D-028)

The full table lives in [design/ENTERPRISE-MODE.md §17](design/ENTERPRISE-MODE.md), with acceptance tests per row:

- **R-5P1..R-5PA (phase 5):** program core. Charter from a goal, Sponsor approval bound to the charter hash, delegation envelope, gates with independent review, evidence-bound reports.
- **R-5E1..R-5E14 (phase 5):** virtual enterprise. Org chart and departments, portfolio and queue, headless daemon, mixed model sources (local, BYOK API, subscription CLIs) with per-department policy, outbound reports and the Enterprise view.
- **R-6E1..R-6E6 (phase 6):** remote approvals, opt-in, loopback by default, passkeys or device pairing; Sponsor-reserved items never approved remotely (Q-12).

## Proof points to measure before any public claim

1. Share of runs whose actual cost falls inside the shown band (target ≥ 80 %, live data needs Q-2).
2. Review findings that led to an accepted revision, per 100 code nodes, and their cost.
3. Median time for the master success criterion (OAuth with tests on an unknown repo) — < 5 min.
4. Zero forbidden-zone reads across the red-team suite on all three OS.
5. Routing change rate after learning (R-401), with the before/after acceptance rate.

## Sponsor questions raised

- **Q-5** — Market launch scope: v1.0 after phase 7 (developer and conception), with phase 8 after launch? PO default: yes.
- **Q-6** — Pricing model: zero markup on inference, licence per seat or per machine, free reviewer and viewer seats? PO default: design and build for BYOK with no metering of tokens; no pricing published.
