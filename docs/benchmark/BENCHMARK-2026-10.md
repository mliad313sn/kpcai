# KP Studio — full competitive benchmark (2026-10-23)

Owner: Product Owner. Inputs: two independent analyst reports, kept verbatim as evidence:
[Annex A — AI IDEs, CLI and cloud agents](annex-a-ides-and-agents.md) (29 products) and
[Annex B — app builders, design-to-code, orchestration, routers, governance, surveys, pricing](annex-b-builders-orchestration-governance.md)
(about 40 products and sources). Earlier study: [LANDSCAPE.md](../LANDSCAPE.md) (phase 0).
What follows is the synthesis; requirements derived from it are in
[REQUIREMENTS-KP-STUDIO.md](../REQUIREMENTS-KP-STUDIO.md).

**Confidence.** Analysts worked from public web sources only; nothing was tested hands-on.
Items marked [U] in the annexes come from a single secondary or vendor-adjacent source and
must be re-checked before any public claim. Benchmark scores and productivity claims by
vendors are self-reported. Use this document for product direction, not for marketing copy.

## 1. Market map

| Segment                         | Leaders (Oct 2026)                                                                                   | What they sell                                                      | Where KP Studio sits                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| AI IDEs and editors             | Cursor 3, VS Code + Copilot, JetBrains Junie/Air, Windsurf/Devin Desktop, Kiro, Antigravity, Zed     | An editor with agents inside; parallel agents; plan mode            | Not an editor. Runs beside one, or inside one through ACP |
| Terminal and CLI agents         | Claude Code, Codex, Gemini CLI, opencode, Aider, Goose, Amp, Cline/Kilo, Warp, Factory               | One strong agent loop, mostly single vendor                         | Orchestrates several of them, cross-reviewed              |
| Cloud and async agents          | Devin, Jules, Copilot coding agent, Codex cloud, Replit Agent, OpenHands                             | Hand off a task, get a PR                                           | Local-first; background runs planned, cloud optional      |
| App builders and design-to-code | Lovable, Bolt, v0, Replit, Figma Make + MCP, Stitch, AI Studio Build, Claude Design, Builder Fusion  | Prompt to app or screen; design system adoption                     | **Conception chain** with traceability (phase 7)          |
| Orchestration frameworks        | LangGraph, Microsoft Agent Framework, OpenAI Agents SDK, Google ADK, AgentCore, CrewAI, Mastra, Dify | Libraries and hosted runtimes for building agents                   | A finished product for developers, not a framework        |
| Routers and gateways            | OpenRouter, Not Diamond, Martian, LiteLLM, Portkey (Palo Alto), Arch-Router                          | One API, many models; routing by popularity, opaque score or policy | Routing by measured competence, explained, local          |
| Governance and observability    | Langfuse (ClickHouse), LangSmith, AgentCore Policy, Copilot control plane                            | Traces after the fact; policy at a gateway                          | Hash-chained journal, budget and policy before execution  |

## 2. Comparison matrix (condensed)

✓ strong · ◐ partial · ✗ absent. "KP today" is what is built and tested at the end of phase 2
(commit 94ab19e); "KP target" is the requirements set. Full per-product tables: Annex A §3
(29 products, 16 criteria) and Annex B §1 (13 builders, 7 conception criteria).

| Criterion                               | KP today           | KP target    | Cursor 3       | Copilot (VS Code + agent) | Claude Code   | Codex | Kiro    | Cline / Kilo  | opencode | Devin    | Lovable / v0 | Figma Make + MCP | Builder Fusion |
| --------------------------------------- | ------------------ | ------------ | -------------- | ------------------------- | ------------- | ----- | ------- | ------------- | -------- | -------- | ------------ | ---------------- | -------------- |
| Explained competence routing            | ✓ CLI              | ✓            | ◐ opaque       | ◐ opaque                  | ◐             | ◐     | ✗       | ◐             | ✗        | ✗        | ✗            | ✗                | ✗              |
| Cross-provider verification (routed)    | ✓                  | ✓            | ✗              | ◐ fixed pair              | ◐ plugin      | ✗     | ✗       | ✗             | ✗        | ✗        | ✗            | ✗                | ✗              |
| Cost estimate before run                | ✓ point            | ✓ range      | ✗              | ✗                         | ✗             | ✗     | ✗       | ✗             | ✗        | ✗        | ✗            | ✗                | ✗              |
| Hard budget enforced                    | ✓                  | ✓            | ◐              | ◐                         | ◐ headless    | ◐     | ◐       | ✗             | ✗        | ◐        | ◐            | ◐                | ?              |
| Cross-vendor fallback                   | ✓                  | ✓            | ◐              | ◐                         | ◐ same vendor | ✗     | ?       | ✗             | ✗        | ✗        | ✗            | ✗                | ✗              |
| Local models                            | ✓ Ollama, l.cpp    | ✓            | ✗              | ✓ BYOK                    | ✗             | ◐     | ✗       | ✓             | ✓        | ✗        | ✗            | ✗                | ✗              |
| Tamper-evident audit and replay         | ◐ chain, no replay | ✓            | ◐ log          | ◐                         | ◐ transcripts | ◐     | ◐       | ◐ checkpoints | ◐        | ◐ replay | ✗            | ✗                | ✗              |
| Secret zones, sensitive work kept local | ◐ zones            | ✓            | ◐ privacy mode | ✓ air-gap BYOK            | ◐ sandbox     | ◐     | ◐       | ✓ BYOK        | ✓        | ◐        | ✗            | ✗                | ◐              |
| Task graph as main view                 | ◐ CLI render       | ✓            | ✗              | ✗                         | ◐ todos       | ✗     | ◐ tasks | ✗             | ✗        | ◐        | ✗            | ✗                | ✗              |
| Parallel agents in worktrees + manager  | ✗                  | ✓            | ✓              | ✓                         | ✓             | ✓     | ◐       | ◐             | ◐        | ✓        | ✗            | ✗                | ◐              |
| Checkpoints and rollback                | ✗                  | ✓            | ✓              | ◐                         | ✓             | ◐     | ◐       | ✓             | ◐        | ◐        | ✓            | ◐                | ◐              |
| Rules files (AGENTS.md, CLAUDE.md…)     | ✗                  | ✓            | ✓              | ✓                         | ✓             | ✓     | ✓       | ✓             | ✓        | ✓        | ◐            | ◐ guidelines     | ✓              |
| MCP tool bus with graded permissions    | ✓                  | ✓ + registry | ✓              | ✓ registry                | ✓             | ✓     | ✓       | ✓             | ✓        | ✓        | ◐            | ✓ server         | ◐              |
| Spec workflow (requirements → tasks)    | ✗                  | ✓ scaled     | ◐              | ◐                         | ◐             | ◐     | ✓✓      | ◐             | ✗        | ◐        | ◐            | ✗                | ◐              |
| Requirement → UI → code traceability    | ✗                  | ✓            | ✗              | ✗                         | ✗             | ✗     | ◐ specs | ✗             | ✗        | ✗        | ✗            | ✗                | ◐              |
| Design-system-aware generation          | ✗                  | ✓            | ◐ design mode  | ✗                         | ◐             | ✗     | ✗       | ✗             | ✗        | ✗        | ◐ shadcn     | ✓ Make kits      | ✓              |
| Provenance export (Agent Trace, notes)  | ✗                  | ✓            | ✗              | ◐ PR history              | ✗             | ✗     | ✗       | ✗             | ✗        | ✗        | ✗            | ✗                | ✗              |
| Multi-surface (desktop, web, TUI, ACP)  | ◐ CLI              | ✓            | ✓              | ✓                         | ✓             | ✓     | ◐       | ◐             | ✓        | ◐        | ◐ web        | ◐                | ◐              |
| Zero-markup BYOK pricing                | ✓ by design        | ✓            | ✗ credits      | ◐ BYOK                    | ✗ plans       | ✗     | ✗       | ✓             | ✓        | ✗        | ✗ credits    | ✗ credits        | ✗              |

Four facts stand out (Annex A §3 takeaways, confirmed by Annex B §3):

1. **No product shows the cost before a run.** Replit says estimates "would be inaccurate".
   KernelPAI already does it, with calibration (phase 1).
2. **No product routes the critic.** Copilot's Rubber Duck and Amp's Oracle are fixed
   pairings. KernelPAI already forces a critic from another provider (phase 2).
3. **No product explains routing.** OpenRouter Auto uses trailing spend ("wisdom of the
   market"), Cursor and Copilot Auto are opaque. KernelPAI prints a one-line reason (phase 1).
4. **No product links a requirement to the screen, component, commit and test that
   implement it** (Annex B §1, "conception gap").

KP Studio is behind on what is now table stakes: parallel agents in worktrees with a manager
view, checkpoints and rollback, rules files, a graphical console, background runs. Those are
known engineering, and phase 3 to 5 plan them (requirements R-3xx to R-5xx).

## 3. Table stakes for 2026 (must match, not differentiators)

From Annex A §4, with Annex B evidence where it adds to it.

1. Parallel agents in isolated worktrees or VMs, with a manager view.
2. Local ↔ cloud hand-off; background runs that survive a closed laptop.
3. Plan-first: a read-only plan, approved before execution, persistent and shareable.
4. MCP as the tool bus, with a registry, plugins and skills (AAIF-governed standards: MCP, AGENTS.md).
5. Repository rules and memory files (AGENTS.md first) and lifecycle hooks.
6. Multi-model with BYOK and local models; vendor lock-in is a stated objection.
7. AI code review as a product (Bugbot, Claude Code Review, Copilot review).
8. Usage-metered billing, so users expect live meters and spend limits.
9. Multi-surface presence: IDE, CLI/TUI, desktop, web, chat, mobile; ACP for "one agent, many editors".
10. Security and governance primitives: sandbox, per-tool permissions, audit, admin policy, air-gap.

## 4. White spaces KP Studio can own

Merged from Annex A §5 and Annex B "White spaces". Each is mapped to a requirement theme.

| #   | White space                                                                                                    | Evidence                                                                                                             | Already in KernelPAI                                 | Requirements |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------ |
| W1  | **Traceable conception chain**: requirement → UX flow → screen → component → commit → test                     | No builder links artifacts (B §1); SO 2026: 78.7 % want attribution                                                  | Journal, task graph                                  | R-7xx        |
| W2  | **Verification as the product**: routed cross-provider critics, debate, vote, disagreement shown               | SO 2026: 48 % trust AI only when easy to verify; DORA 2026: review is where ROI is won; Rubber Duck 74.7 % gap claim | Critic diversity, protocols                          | R-4xx, R-7xx |
| W3  | **Competence routing with evidence from your own outcomes**                                                    | Routers justify by popularity or opaque scores (B §3)                                                                | Router, calibration                                  | R-4xx        |
| W4  | **Cost before run as a contract**: range, hard cap, published accuracy                                         | Pricing backlash at Cursor, Anthropic, Copilot, Replit, Figma (B §6); token use varies up to 30x                     | Estimate, governor, calibration                      | R-3xx, R-4xx |
| W5  | **Tamper-evident provenance** exportable to Agent Trace, git notes, CycloneDX                                  | "Two specs, no standard" (B §4); ISO 42001 and EU AI Act Art. 50 create demand                                       | Hash-chained journal                                 | R-6xx        |
| W6  | **Secret zones and per-task data residency**: sensitive subtasks to local models only                          | Products offer global privacy mode or full air-gap only (A §5)                                                       | Forbidden zones, local adapters                      | R-6xx        |
| W7  | **Secure MCP tool bus**: allow-list, pinning, egress control, policy before execution                          | postmark-mcp, MCP config injection, s1ngularity, LiteLLM compromise (B §4)                                           | Graded permissions, jail, destructive-by-default MCP | R-5xx, R-6xx |
| W8  | **Cross-vendor resilience**: fallback across providers, survives product shutdowns                             | Claude limits, Gemini CLI free tier end, OpenAI Agent Builder sunset 2026-11-30                                      | Fallback executor                                    | R-4xx        |
| W9  | **Task graph as the primary interface**, editable before and during the run                                    | Managers list agents, not the dependency graph (A §5)                                                                | GraphRunner, protocol                                | R-3xx        |
| W10 | **Orchestrating other agents**: Claude Code, Codex, Gemini CLI as graph nodes under one budget, cross-reviewed | Agent HQ, Air, ACP host agents side by side but do not route or cross-review (A §5)                                  | Adapter port                                         | R-5xx        |
| W11 | **Design-system-aware generation across vendors**, with a conformance critic                                   | Builders are locked to one stack: v0/Vercel, AI Studio/GCP, Figma credits (B §1)                                     | —                                                    | R-7xx        |
| W12 | **Honest productivity measurement** from the journal                                                           | METR: 19 % slower while feeling 20 % faster; JetBrains: 66 % distrust metrics                                        | Journal, stats                                       | R-4xx        |
| W13 | **Regulated and offline teams**: air-gap with local models                                                     | About 15 % avoid AI over data concerns (JetBrains 2025); privacy is adoption barrier #2 (SO 2026)                    | Local-first                                          | R-6xx        |

## 5. Conception (design and requirements) landscape

- Builders win on speed (Lovable $500M ARR, Replit $9B, Base44 growth) but share three
  weaknesses: cost opacity, weak security of generated apps (CVE-2025-48757, row-level
  security missing in 170 of 1,645 Lovable apps) and poor hand-off to engineering.
- v0 and Builder Fusion are closest to engineering: PRs on the real repo, existing
  components. Figma owns the design system of record and is moving to code (Make kits, MCP
  server, code import beta) but bills by credits that users exhaust in hours.
- Claude Design (inside Claude since 2026-09 [U]) is the bundling threat: "good enough" and
  already paid for, single model.
- Nobody covers requirements well, and nobody keeps links between artifacts. Kiro's specs are
  the closest on the engineering side and are criticised as heavy for small tasks.

**Implication:** KP Studio should not become a no-code builder. It should own the chain from
intent to verified code for teams that already have a repository and a design system:
requirements and flows as first-class, linked artifacts; generation that respects the repo's
components and the Figma system; a critic from another provider that checks conformance,
accessibility and security; every link in the journal.

## 6. Pricing landscape and a position

- 2026 ended flat-rate pricing: Cursor (June 2025), Copilot AI Credits (June 2026), Codex
  credits, Claude limit changes, Figma credit caps, Replit effort-based billing. Each change
  caused a backlash; cost shock is the most common complaint.
- OpenRouter charges 5.5 % on credits; BYOK is free up to $25K a month, then 5 % [U].
- Precedents for BYOK as an escape from credits: Anima, Cline, Kilo, opencode, Copilot BYOK.

Recommended position (for the Sponsor, Q-6): **zero markup on inference** — users pay
providers directly or run local models for $0; KP Studio charges for the product (per-seat
or per-machine licence), never per token; reviewers and viewers (PMs, designers) free;
the self-hosted team server at no extra price. This removes the incentive conflict users
suspect in every "Auto" mode.

## 7. Governance and regulation (what buyers will ask)

- EU AI Act: GPAI obligations enforced since 2026-08-02; Article 50 transparency applies
  from 2026-08-02 and watermarking from 2026-12-02, not delayed by the Digital Omnibus [U on
  exact dates; check the Official Journal]. KP Studio is a deployer that orchestrates GPAI
  models: transparency, logging and AI-literacy duties, plus pass-through documentation.
- ISO/IEC 42001 is becoming a procurement gate (finance, health, public sector).
- Enterprise checklists (Annex B §4): SSO/SCIM/RBAC, zero retention, region pinning, immutable
  audit with SIEM export, SOC 2 / ISO 27001 / ISO 42001, budgets and chargeback, allow-listed
  and pinned tools, secret scanning, policy before tool execution, provenance and AIBOM,
  BYOK and approved-model lists.
- Incidents that shape buyers: Nx s1ngularity (malware driving local AI CLIs with bypass
  flags), Shai-Hulud, postmark-mcp, MCP config injection, the LiteLLM PyPI compromise
  (2026-03-24), Claude Code Action and Cursor allow-list bypasses.

## 8. Risks for KP Studio

| Risk                                                                                         | Likelihood | Mitigation                                                                                           |
| -------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| Copilot adds routed critics to Rubber Duck + Agent HQ, with GitHub distribution              | High       | Move first on the evidence (published accuracy, verification ROI); local-first and zero markup       |
| Bundling: Claude Design, Figma Make, AI Studio "free enough"                                 | High       | Integrate them as inputs (MCP, exports) instead of competing; win on traceability and verification   |
| Provider terms forbid routing, arbitrage or driving subscriptions from third-party tools [U] | Medium     | BYOK API keys as the supported path; external agent CLIs run under the user's own account (R-503)    |
| KP Studio itself becomes an injection or supply-chain target                                 | Medium     | No bypass flag can disable zones; pinned, minimal dependencies; signed releases; MCP pinning (R-6xx) |
| Multi-model review costs about 4x tokens for uncertain gains                                 | Medium     | Measure and show verification ROI per run; review spend policy by criticality (R-404)                |
| Two personas (PM and designer vs engineer) dilute the product                                | Medium     | Engineer-first through phase 6; conception views read and comment for PMs and designers (phase 7)    |
| Unverified market figures in this benchmark                                                  | Certain    | Re-check [U] items against primary sources before any public statement                               |

## 9. Sources

Per-claim sources are inline in the annexes. Main primary sources: cursor.com changelogs
2.0 and 3.0; code.claude.com changelog; github.blog changelog (BYOK, Copilot CLI GA, AI
Credits); ampcode.com news; kiro.dev; figma.com release notes and developers.figma.com;
openai.com AgentKit notice; agent-trace.dev; METR (2025-07-10 and February 2026);
Stack Overflow Developer Survey 2026 (2026-10-06); JetBrains Developer Ecosystem 2025;
DORA 2025 and 2026; GitHub Octoverse 2025; arXiv 2607.21656, 2603.00520, 2506.16655.
