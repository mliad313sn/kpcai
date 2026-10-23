> Annex A of [BENCHMARK-2026-10](BENCHMARK-2026-10.md). Analyst report, kept as delivered (2026-10-23). Source markers: [P] primary, [S] secondary, [W] web aggregator, [U] unverified.

# KP Studio — Competitive Landscape (as of 2026-10-23)

Method: about 40 web searches and fetches on 2026-10-23. **Confidence tags:** [P] means a primary source (vendor changelog, docs or blog). [S] means a credible secondary source (The Register, VentureBeat, InfoQ, Help Net Security, Visual Studio Magazine, 9to5Google, Wikipedia). [W] means weak sources (affiliate review and SEO blogs) or sources that conflict. [U] means unverified or contradictory. Prices are USD per month unless noted. Most pricing comes from [W] sources that disagree, so confirm it on vendor pages before quoting it externally. Several sources name models I could not confirm (for example "GPT-6 Astra", "Claude Mythos", "GPT-6.1 Sol"). I leave those names out except where they appear in a benchmark row.

---

## 1. Product-by-product snapshot

### A. AI IDEs and editors

**Cursor (Anysphere)**

- Releases. 2.0 shipped 2025-10-29 with the in-house Composer model and up to 8 parallel agents in worktrees or remote machines [P]. 3.0 "Glass" shipped 2026-04-02 [P] with:
  - an Agents Window: many agents across local, worktree, cloud and remote SSH, including agents started from Slack, GitHub, Linear or mobile;
  - Agent Tabs (grid view);
  - `/best-of-n`: the same task on several models in parallel worktrees, then a comparison;
  - an `Await` tool, Design Mode (annotate the UI in the browser), plans included in shared chats, MCP Apps, a plugin marketplace, and enterprise audit logs.
  - Composer 2 is the in-house model [W].
- Models and routing: multi-model, with an "Auto" router whose criteria are not published. Not competence-explained.
- Review: Bugbot on PRs. In May 2026 it reportedly dropped the $40/seat fee for usage billing at about $1–1.50 per review [U, conflicting].
- Plans: Hobby free, Pro $20, Pro+ $60, Ultra $200, Teams $40/seat [W].
- Spend controls: spend limits exist, but enforcement "is not instant, can overshoot". The dashboard showed only individual spend, and there is no cost per agent run [W].
- Weaknesses:
  - The June 2025 move from request limits to compute limits caused a backlash. The CEO publicly apologised and refunded charges from 16 June to 4 July [S]. A recurring complaint is cost opacity.
  - Auto mode was "unlimited" while chosen models were not [S].
- Rules and memory: `.cursor/rules` and memories. Local models: not first-class [W].

**Windsurf → Devin Desktop (Cognition)**

- Cognition bought Windsurf in December 2025 (about $250M reported) and rebranded it Devin Desktop in about June 2026 [W, several agree].
- Features: Cascade agent, Codemaps, in-house SWE-1.5 then SWE-1.6 models (free), with Devin embedded as a cloud VM agent.
- Plans: credits were replaced by quotas in March 2026. Free, Pro $20, Max $200, Teams $80 plus $40/seat [W].
- Weaknesses: brand churn, unclear roadmap and quota opacity [W].

**VS Code + GitHub Copilot (Microsoft/GitHub)**

- Agent mode in VS Code; plan mode and custom agents through AGENTS.md; a GitHub MCP Registry [S, Universe 2025].
- Copilot coding agent: issue → PR, runs in Actions.
- Agent HQ and Mission Control (announced Universe 2025): run and steer third-party agents (Anthropic, OpenAI, Google, Cognition, xAI), with an Enterprise Agent Control Plane [P/S].
- Copilot CLI went GA in February 2026 [P].
- BYOK in VS Code went GA on 2026-04-22, including local Ollama and Foundry Local models; it was extended to air-gapped installs in about May–June 2026 [P]. Local models cover chat and agents but not inline completions.
- **Rubber Duck** (Copilot CLI, experimental, April 2026): a _cross-family_ critic. With Claude as orchestrator, the critic runs on GPT-5.4. It fires automatically after the plan, after complex implementation, and after tests are written; it can also be requested or fire when the agent is stuck. GitHub claims Sonnet plus Rubber Duck closes 74.7% of the gap between Sonnet and Opus on SWE-bench Pro [S, Help Net Security]. **This is the closest existing analogue to KP Studio's cross-provider critic.**
- Model picker plus "Auto" (a 10% multiplier discount before June 2026) [W].
- Billing: on 2026-06-01, premium requests were replaced by **GitHub AI Credits**, charged per token [W, multiple]. Free, Pro $10, Pro+ $39, Business $19, Enterprise $39 per user.
- Strengths: enterprise reach (56% usage at companies with 10k+ staff [S, Pragmatic Engineer]).
- Weaknesses: billing churn, "love" at only 9% [S], and a coding agent that is slow and Actions-bound [W].

**JetBrains (AI Assistant, Junie, Air)**

- Junie agent left beta in about June 2026 [W]. Junie CLI is LLM-agnostic, with BYOK through OpenRouter and no markup [W].
- **Air**, an agentic development environment in preview, runs Codex, Claude Agent, Gemini CLI and Junie _in parallel_ [W, two sources].
- Co-developed ACP with Zed [W].
- AI Pro $10, AI Ultimate $30, credits at 1 credit = $1 [W].
- Weakness: a confusing credits and quota story [W].

**Zed**

- A Rust editor with an agent panel. Through **ACP (Agent Client Protocol)** it hosts external agents (Claude Code, Codex, OpenCode, Gemini).
- Edit predictions use the Zeta model.
- Plans: Personal free (unlimited BYOK and external agents), Pro $10 (includes $5 of hosted credits, then list price +10%), Business $30/seat (May 2026) [W].
- Ollama is supported. No native cloud or background agents [W].

**Kiro (AWS)**

- Spec-driven: requirements are user stories with EARS acceptance criteria, then design.md, then tasks.md under `.kiro/specs/`, and task status updates live [P].
- Also: agent hooks on file events, steering files, Autopilot and Supervised modes, and a Kiro CLI [P/W].
- GA was most likely 7 May 2026 [W, conflicting]. It is replacing Amazon Q Developer, which reaches end of support 2027-04-30 [W].
- Credits: Free 50, Pro $20 (1,000 credits), Pro+ $40, Pro Max $100, Power $200, overage $0.04 per credit [W].
- Mostly Anthropic models. Complaints are about credit burn and specs that feel heavy for small tasks [W].

**Trae (ByteDance)**

- An IDE with a SOLO autonomous mode; SOLO became a standalone app on 2026-03-31 [W].
- Usage moved to token billing in February 2026. Free tier; Pro $10–20 [W, conflicting].
- **Privacy is the main complaint.** Telemetry goes to ByteDance and is on by default; data is kept 5 years; Privacy Mode is only partial; no enterprise tier [W]. Reviewers advise against it for proprietary code.

**Google: Antigravity, Firebase Studio, IDX**

- **Antigravity 2.0** (I/O 2026-05-19) has five surfaces [S, 9to5Google; P, Google blog]:
  - desktop app with a Manager surface that runs parallel agents;
  - CLI, which succeeds Gemini CLI for individuals;
  - SDK;
  - Managed Agents API;
  - Enterprise platform.
- **Firebase Studio** was announced as discontinued on 2026-03-19; new workspaces stopped 2026-06-22; shutdown is set for 2027-03-22 [S, Wikipedia]. IDX was folded in earlier.
- Gergely Orosz on Google: "keeps abandoning [dev tools]" [S]. Trust in Google's continuity is a real issue.

**Void**: open-source Cursor alternative with local models. "Work on Void is currently paused" (README); the repo was reportedly archived June 2026 [W/U].

**Eclipse Theia (Theia AI / Theia IDE)**

- Monthly releases; 1.76 shipped 2026-10-08 [P, EclipseSource].
- Recent additions: Copilot subscription support, model auto-discovery, an external AI session API, an MCP and skills registry (1.73), and agent plugins, memory and MCP Apps (1.75).
- An open, vendor-neutral base. It is the closest open base to a "studio" shell.

### B. Terminal and CLI agents

**Claude Code (Anthropic)**

- Surfaces: CLI, VS Code, JetBrains, desktop, web and cloud sessions, Slack ("Claude Tag"), and a self-hosted runner [P, changelog Oct 2026].
- Agents: subagents, which are forked and backgrounded by default since 2.1.302 (Oct 2026); **agent teams** (research preview February 2026, with TeammateIdle and TaskCompleted hooks) [P/W].
- Extensibility: hooks (PreToolUse, PermissionRequest, PreCompact…), skills, a plugin marketplace (`claude plugin install --marketplace`, October 2026), MCP, and CLAUDE.md memory.
- Code Review (`@claude review`) with Quick, Standard and Deep levels per org or repo [P].
- Cost and safety controls:
  - `/cost`, `/usage` with one-key fixes, and **`--max-budget-usd`** [P];
  - an auto-mode permission classifier and a sandbox;
  - an OTel `safety_event` that records each blocked or prompted tool call [P].
- Plans: Pro $20, Max $100/$200, Team $25/$125, and API metering [W, consistent].
- Strengths: **most loved: 46% vs Cursor 19% vs Copilot 9%** (Pragmatic Engineer survey, 906 respondents, Jan–Feb 2026) [S]. 75% usage at startups [S].
- Weaknesses: **rate-limit and weekly-cap backlash** recurs — August 2025 weekly caps; Oct 2025; Jan 2026 "surprise limits"; a June 2026 bug that hit about 3% of users [S, VentureBeat and The Register]. Single-vendor models (the Codex plugin adds cross-provider review [W]).

**OpenAI Codex (CLI + cloud + IDE + app)**

- Surfaces: open-source CLI (Rust); cloud containers that run parallel tasks; IDE extension; a macOS **Codex app** (2026-02-02) with parallel threads, worktrees, skills and automations [W].
- Billing became token-based credits on 2026-04-02 [W]. Included in ChatGPT Plus $20 and Pro $100/$200; Business $25–30 [W].
- DevDay October 2026 reportedly brought Codex Cloud with `/agents`, Code Review for GitHub and GitLab, and security scanning [U, single blog].
- Uses AGENTS.md. Models are OpenAI-only. Ships an official plugin so Claude Code can call Codex as a reviewer [W].

**Gemini CLI → Antigravity CLI**

- Open source (Apache-2.0), 1M context, extensions, Conductor (markdown plans), and Jules hand-off [W].
- **The free individual tier ended 2026-06-18.** Individuals were moved to Antigravity CLI, whose free quota is much smaller [W, several].
- Lesson: generous free tiers are unstable.

**opencode (SST/anoma)**

- An open-source TUI and the most-starred CLI agent (about 160–209k stars [W]). 75+ providers, model switching mid-session, a client/server design, LSP.
- Paid options: Zen (a pay-as-you-go gateway at cost), Go ($10 for open-weight models), Black ($200, sold out) [W].
- Strong local-model story.

**Crush (Charm)**: open-source Go TUI. Multi-provider with model switching mid-session and context kept; best-in-class LSP integration; SQLite sessions; MCP; `crush run` one-shot mode [W].

**Aider**: the pioneering git-native pair programmer (about 49k stars) [W]. Supports many models and local models. "Architect/editor" model pairing was an early form of role routing. No MCP [W]. Development pace has slowed relative to peers [U].

**Goose**

- Founding project of the Linux Foundation **Agentic AI Foundation** (December 2025, alongside MCP and AGENTS.md); governance moved to the AAIF in April 2026 [S, The New Stack and Block].
- v1.55 (October 2026) [W]. MCP-native (70+ extensions), Ollama, and recipes.

**Amp (spun out of Sourcegraph, December 2025)**

- Main model plus an **Oracle**. The Oracle is a second model _from another provider_ (GPT-5, then GPT-5.4) used for planning, review and debugging. Amp reports Oracle quality rising from 60.8% to 68.2% on its internal eval [P, ampcode.com].
- Subagents ("Librarian" and others), effort modes, threads that can be shared.
- Pricing: provider API cost with no markup (enterprise reportedly carries a markup). Ads ended March 2026 [W, conflicting].
- **This is a de-facto cross-provider author/critic, but fixed rather than routed.**

**Cline**

- Open-source VS Code agent with a CLI for headless CI.
- **Plan/Act modes, each with its own model** (manual role routing); per-step approvals; **checkpoints** in a shadow git repo; **per-task cost display**; BYOK [W, consistent; Addy Osmani endorsement [S]].
- Teams $20; Enterprise with SSO, SCIM and auth logs. No hosted cloud agents [W].

**Roo Code → Kilo Code**: Roo is reportedly shut down, with Kilo as its main successor fork [U]. Kilo offers modes such as Orchestrator → Architect/Coder/Debug (Orchestrator possibly deprecated [U]), 500+ models via a zero-markup gateway (about 5% fee), Teams $15, and Kilo Pass $19–199 [W]. Orchestrator runs cost about 3–4x a single chat [W].

**Warp ("agentic development environment")**

- Warp 2.0 (2025); the client was open-sourced in April 2026 under MIT/AGPL [W].
- Cloud agents: Oz (renamed Warp Agent) plus Warp Factories (early access) for fleets [W].
- Hosts any CLI agent. Free with BYOK; Build $20; Max $200; Business $50/seat [W].

**Factory (Droids)**

- Claims #1 on Terminal-Bench 1.0 at 58.75% with Opus 4.1 (self-reported) [W].
- Enterprise focus: ZDR, on-prem, audit logs; customers include Nvidia, Adobe and EY [W].
- Pro $20, Plus $100, Max $200 with 5-hour, 7-day and 30-day rolling limits [W]. Funding reports conflict [U].

### C. Autonomous and cloud agents

**Devin (Cognition)**

- Cloud VM "AI engineer", with Fusion harness claims [W].
- Self-serve moved from ACUs to quotas in March 2026: Pro $20, Max $200; ACUs remain for enterprise [W].
- Complaints: opaque, unpredictable cost; drift in long sessions that "needs babysitting" [W, consistent].

**Jules (Google)**

- Asynchronous GitHub agent: exited beta August 2025; Jules Tools CLI and API on 2025-10-02 [S, InfoQ and VentureBeat].
- Tasks per day: Free 15, AI Pro 100, Ultra 300 [W]. "Jules V2 / Project Jitro" (goal-driven) [U].
- Its future overlaps with Antigravity's.

**GitHub Copilot coding agent**: see section A. Runs on Actions, opens a PR, can be steered through PR comments; Agent HQ hosts third-party agents.

**Codex cloud**: see section B.

**Replit Agent (v4)**

- Builds and hosts the app end to end, aimed at non-developers.
- **Effort-based pricing causes cost shock.**
  - Agent 3 (September 2025): a user reported $1k in a week [S, The Register].
  - Agent 4: one report of $8k in a month, where a 23-item request spawned 770 tasks [W].
- Core $20, Pro $100. Running estimates per checkpoint and budget alerts exist; Replit says upfront estimates "would be inaccurate" [W].

**OpenHands (All Hands)**

- MIT-licensed, self-hostable, any model including local ones. Cloud with BYOK and enterprise options.
- Earlier state of the art used inference-time scaling with a critic model (April 2025) [P].
- SWE-bench Verified is about 62–72% depending on model [W, inconsistent].

**Augment Code**

- Context Engine (semantic index, 400k+ files) unbundled as an **MCP server**, GA 2026-02-06 [W]. Auggie CLI with `/model` switching.
- Token billing at provider rate +40% [P docs/W]. The 2025 move to credits hurt trust [W].

**Tabnine**

- Privacy and **air-gap** leader. Context Engine; Code Assistant $39, Agentic $59 per user per year-billed; headless tiers [W].
- No free or individual plans since 2025. Acquired by **Tricentis in July 2026** [W]. Local indexing removed in 6.3 [W].

**Sourcegraph**: after Amp spun out, Cody Free and Pro were shut down; enterprise focus on code search, Deep Search and batch changes [W].

---

## 2. Benchmarks (snapshot; models matter more than harnesses)

| Benchmark                         | Top public numbers (late Oct 2026)                                                                                               | Note                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Terminal-Bench 2.0                | GPT-5.5 ≈82–82.7%; Claude (preview model) 82.0%; Claude Sonnet 5 80.4%; GPT-5.3-Codex 77.3% [W, benchlm and llm-stats]           | TB 2.1 also exists; scores do not transfer between versions [U]                          |
| SWE-bench Pro (Scale, public set) | Muse Spark 1.1 61.5; GPT-5.4 xHigh 59.1; Opus 4.6 thinking 51.9; Gemini 3.1 Pro 46.1 [W, page mixes eras]                        | A "V2" page shows ~98% entries [U, do not cite]                                          |
| SWE-bench Verified                | Saturated, above 80% for frontier models; OpenHands about 62–72% depending on model [W]                                          | Contamination concerns; SWE-ABS paper finds inflated success rates [S, arXiv 2603.00520] |
| Harness claims                    | Factory TB1 58.75% (Opus 4.1); Rubber Duck closes 74.7% of the Sonnet→Opus gap on SWE-bench Pro; Amp Oracle 60.8→68.2 (internal) | All self-reported                                                                        |
| Cross-model review research       | arXiv 2607.21656, "Should you use Claude to review Codex or vice versa?" (116 tasks) [S]                                         | Results not read; worth reading before marketing claims                                  |

Productivity evidence:

- METR RCT (July 2025): experienced developers were 19% _slower_ with AI while believing they were 20% faster.
- February 2026 follow-up: inconclusive (−18% to +4%, intervals cross zero) [W summaries of a primary source].
- SO Survey 2026 (released 2026-10-06): 66% use coding agents or assistants. Only about 7% trust AI for important decisions; **48% trust it when they can easily verify the output**. About 79% (SO says 93%) want source attribution. Security and privacy is the #2 barrier to adoption [S, The Register and SO blog].

---

## 3. Comparison matrix

Legend: ✓ = strong, native · ◐ = partial or manual · ✗ = absent · ? = unverified.

The 16 columns are split into two tables of 8. Products are in the same order in both.

**Table A — routing, verification, cost, control**

| Product                  | Competence routing (explained) | Cross-provider verify              | Plan visible       | Cost before run            | Budget enforced                 | Auto fallback          | Interrupt / redirect  | Local models                   |
| ------------------------ | ------------------------------ | ---------------------------------- | ------------------ | -------------------------- | ------------------------------- | ---------------------- | --------------------- | ------------------------------ |
| **KP Studio (target)**   | ✓ + 1-line why                 | ✓ critic ≠ provider                | ✓ task graph       | ✓                          | ✓ hard                          | ✓                      | ✓                     | ✓ Ollama, llama.cpp            |
| Cursor 3                 | ◐ Auto, opaque                 | ◐ best-of-n is compare, not critic | ◐ plans            | ✗                          | ◐ spend limit, can overshoot    | ◐                      | ✓                     | ✗                              |
| Devin Desktop / Windsurf | ◐                              | ✗                                  | ◐                  | ✗                          | ◐ quotas                        | ?                      | ✓                     | ✗                              |
| VS Code + Copilot        | ◐ Auto                         | ✓ Rubber Duck (CLI, exp.)          | ✓ plan mode        | ✗                          | ◐ AI-credit caps                | ◐                      | ✓                     | ✓ BYOK Ollama (no completions) |
| JetBrains Junie / Air    | ✗ manual                       | ◐ parallel agents in Air           | ◐                  | ✗                          | ◐ credits                       | ?                      | ✓                     | ◐ BYOK                         |
| Zed                      | ✗                              | ✗                                  | ◐                  | ✗                          | ◐                               | ✗                      | ✓                     | ✓                              |
| Kiro                     | ✗                              | ✗                                  | ✓ specs, tasks     | ✗                          | ◐ credits                       | ?                      | ✓ supervised          | ✗                              |
| Trae                     | ◐                              | ✗                                  | ◐                  | ✗                          | ✗                               | ?                      | ✓                     | ◐ BYOK                         |
| Google Antigravity       | ◐                              | ✗                                  | ✓ artifacts/plans  | ✗                          | ◐ quota                         | ?                      | ✓                     | ✗                              |
| Theia AI                 | ✗                              | ✗                                  | ◐                  | ✗                          | ✗                               | ✗                      | ✓                     | ✓                              |
| Claude Code              | ◐ per-subagent model, effort   | ◐ via Codex plugin                 | ✓ plan mode, todos | ✗                          | ✓ `--max-budget-usd` (headless) | ◐ model alias fallback | ✓ Esc, steer mid-turn | ✗ (only via 3rd-party proxies) |
| Codex                    | ◐ effort levels                | ✗                                  | ✓                  | ✗                          | ◐ plan limits                   | ✗                      | ✓                     | ◐ OSS provider flag            |
| Gemini / Antigravity CLI | ✗                              | ✗                                  | ◐ Conductor        | ✗                          | ✗                               | ◐ Pro→Flash fallback   | ✓                     | ✗                              |
| opencode                 | ✗ manual                       | ✗                                  | ◐ plan agent       | ✗                          | ✗                               | ✗                      | ✓                     | ✓                              |
| Crush                    | ✗                              | ✗                                  | ◐                  | ✗                          | ✗                               | ✗                      | ✓                     | ✓                              |
| Aider                    | ◐ architect/editor pair        | ◐ (2 models)                       | ◐                  | ◐ token report             | ✗                               | ✗                      | ✓                     | ✓                              |
| Goose                    | ◐ lead/worker                  | ✗                                  | ◐                  | ✗                          | ✗                               | ◐                      | ✓                     | ✓                              |
| Amp                      | ◐ fixed roles                  | ✓ Oracle (GPT) vs main model       | ◐                  | ✗                          | ✗                               | ?                      | ✓                     | ✗                              |
| Cline                    | ◐ Plan≠Act model               | ✗                                  | ✓ Plan mode        | ✗ (live cost)              | ✗                               | ✗                      | ✓ approve each step   | ✓                              |
| Kilo (Roo successor)     | ◐ mode→model map               | ✗                                  | ✓ Architect        | ✗                          | ✗                               | ✗                      | ✓                     | ✓                              |
| Warp                     | ◐ hosted routing               | ✗                                  | ◐                  | ✗                          | ◐ credits                       | ?                      | ✓                     | ◐ custom endpoint              |
| Factory Droids           | ◐                              | ✗                                  | ✓ spec mode        | ✗                          | ◐                               | ?                      | ✓                     | ✗                              |
| Devin (cloud)            | ✗                              | ✗                                  | ✓ plan             | ✗                          | ◐ quota                         | ✗                      | ◐ chat steer          | ✗                              |
| Jules                    | ✗                              | ✗                                  | ✓ plan approval    | ✗                          | ◐ task quota                    | ✗                      | ◐                     | ✗                              |
| Copilot coding agent     | ◐                              | ◐                                  | ◐                  | ✗                          | ◐                               | ✗                      | ◐ PR comments         | ✗                              |
| Replit Agent             | ✗                              | ✗                                  | ◐                  | ✗ ("estimates inaccurate") | ◐ alerts                        | ✗                      | ◐                     | ✗                              |
| OpenHands                | ✗                              | ◐ critic model (research)          | ◐                  | ✗                          | ◐ max-budget flag ?             | ✗                      | ✓                     | ✓                              |
| Augment                  | ◐ /model                       | ✗                                  | ◐                  | ✗                          | ◐                               | ✗                      | ✓                     | ✗                              |
| Tabnine                  | ✗                              | ✗                                  | ◐                  | ✗                          | ✗                               | ✗                      | ✓                     | ✓ self-hosted models           |

**Table B — data, audit, extensibility, scale**

| Product                  | Residency / secret zones    | Audit / replay                    | MCP / tool bus     | Parallel / background     | Spec workflow | Memory / rules       | Team / enterprise | UI surfaces                   |
| ------------------------ | --------------------------- | --------------------------------- | ------------------ | ------------------------- | ------------- | -------------------- | ----------------- | ----------------------------- |
| **KP Studio (target)**   | ✓ zones                     | ✓ hash-chain replay               | ✓ graded perms     | ✓                         | ◐ (graph)     | ?                    | ?                 | web, desktop, TUI             |
| Cursor 3                 | ◐ privacy mode              | ◐ audit log, shared chats         | ✓ + plugins        | ✓ local, cloud, SSH       | ◐             | ✓ rules, memories    | ✓                 | IDE, web, mobile, Slack       |
| Devin Desktop / Windsurf | ◐                           | ✗                                 | ✓                  | ✓ Devin VM                | ◐             | ✓                    | ✓                 | IDE, CLI, web                 |
| VS Code + Copilot        | ✓ air-gap BYOK              | ◐ agent control plane             | ✓ registry         | ✓ coding agent, HQ        | ◐             | ✓ AGENTS.md          | ✓✓                | IDE, CLI, web, GitHub         |
| JetBrains Junie / Air    | ◐                           | ✗                                 | ✓                  | ✓ Air                     | ◐             | ✓                    | ✓                 | IDE, CLI, Air                 |
| Zed                      | ✓ local                     | ✗                                 | ✓ + ACP            | ✗                         | ✗             | ◐                    | ◐ Business        | editor                        |
| Kiro                     | ◐ AWS                       | ◐                                 | ✓                  | ◐                         | ✓✓            | ✓ steering           | ✓                 | IDE, CLI                      |
| Trae                     | ✗ telemetry                 | ✗                                 | ✓                  | ✓ SOLO                    | ◐             | ◐                    | ✗                 | IDE, SOLO app                 |
| Google Antigravity       | ◐                           | ◐ artifacts                       | ✓                  | ✓ Manager                 | ◐             | ◐                    | ✓                 | desktop, CLI, SDK, API        |
| Theia AI                 | ✓ self-host                 | ◐                                 | ✓ registry         | ◐                         | ✗             | ✓ memory             | ◐                 | IDE (web, desktop)            |
| Claude Code              | ◐ sandbox, managed settings | ◐ transcripts, OTel safety events | ✓ + plugins, hooks | ✓ subagents, teams, cloud | ◐             | ✓ CLAUDE.md, skills  | ✓                 | CLI, IDE, desktop, web, Slack |
| Codex                    | ◐ cloud sandbox             | ◐                                 | ✓                  | ✓ cloud, app              | ◐             | ✓ AGENTS.md          | ✓                 | CLI, IDE, app, web            |
| Gemini / Antigravity CLI | ✗                           | ✗                                 | ✓ ext              | ◐ via Jules               | ◐             | ✓ GEMINI.md          | ◐                 | CLI                           |
| opencode                 | ✓                           | ◐ sessions                        | ✓                  | ◐                         | ✗             | ✓ AGENTS.md          | ✗                 | TUI, desktop, web             |
| Crush                    | ✓                           | ◐ SQLite                          | ✓                  | ✗                         | ✗             | ✓                    | ✗                 | TUI                           |
| Aider                    | ✓                           | ✓ git commits                     | ✗                  | ✗                         | ✗             | ◐ conventions        | ✗                 | CLI                           |
| Goose                    | ✓                           | ◐                                 | ✓✓ native          | ◐                         | ◐ recipes     | ✓                    | ◐                 | CLI, desktop                  |
| Amp                      | ✗ cloud threads             | ◐ shared threads                  | ✓                  | ✓ subagents               | ✗             | ✓                    | ✓                 | CLI, IDE ext                  |
| Cline                    | ✓ BYOK                      | ◐ checkpoints                     | ✓ marketplace      | ✗                         | ◐             | ✓ rules, memory bank | ✓                 | IDE, CLI                      |
| Kilo (Roo successor)     | ✓                           | ◐                                 | ✓                  | ◐                         | ◐             | ✓                    | ◐                 | IDE, CLI                      |
| Warp                     | ◐                           | ◐                                 | ✓                  | ✓ Oz/Factories            | ◐             | ✓                    | ✓                 | terminal, cloud               |
| Factory Droids           | ✓ on-prem, ZDR              | ✓ audit logs                      | ✓                  | ✓                         | ✓             | ✓                    | ✓✓                | CLI, IDE, web, Slack          |
| Devin (cloud)            | ◐ VPC enterprise            | ◐ session replay                  | ✓                  | ✓                         | ◐             | ✓ knowledge          | ✓                 | web, Slack                    |
| Jules                    | ✗                           | ◐                                 | ✗?                 | ✓ async                   | ◐             | ◐                    | ◐                 | web, CLI, API                 |
| Copilot coding agent     | ✓                           | ✓ PR history                      | ✓                  | ✓                         | ◐             | ✓                    | ✓✓                | GitHub                        |
| Replit Agent             | ✗                           | ◐ checkpoints                     | ◐                  | ✓                         | ✗             | ◐                    | ◐                 | web, mobile                   |
| OpenHands                | ✓ self-host                 | ✓ event-stream replay             | ✓                  | ✓                         | ✗             | ◐                    | ✓                 | web, CLI                      |
| Augment                  | ◐                           | ✗                                 | ✓ (context MCP)    | ✓ remote agents           | ◐             | ✓                    | ✓                 | IDE, CLI                      |
| Tabnine                  | ✓✓ air-gap                  | ◐                                 | ◐                  | ◐                         | ✗             | ✓                    | ✓✓                | IDE                           |

Matrix takeaways:

- Nobody has a ✓ in "cost before run".
- Only Claude Code (`--max-budget-usd`, headless) enforces a hard budget.
- Only Copilot's Rubber Duck and Amp's Oracle ship cross-provider critique, and both are fixed pairings, not routed.
- Nobody explains routing decisions.
- Replay exists only in OpenHands' event stream and as git history in Aider and Cline. Nobody offers tamper-evident (hash-chained) audit.

---

## 4. Ten table-stakes trends (2025–2026) a new studio must match

1. **Parallel agents in isolated worktrees or VMs, plus an "agent manager" view.** Examples: Cursor 3 Agents Window, Antigravity Manager, Copilot Mission Control, JetBrains Air, Codex app, Claude agent teams, Warp Factories. A single chat pane is no longer enough.
2. **Local ↔ cloud hand-off and background or asynchronous runs** that go on with the laptop closed and are reachable from Slack, mobile or GitHub. Examples: Cursor, Codex Cloud, Claude Code web and Slack, Devin, Jules, Copilot coding agent.
3. **Plan-first, spec-lite workflows.** Read-only plan mode followed by approval (Cline, Copilot, Claude, Jules); full specs (Kiro, Factory). Plans have to be persistent and shareable (Cursor 3 puts plans in shared chats).
4. **MCP as the standard tool bus, plus plugin and skill marketplaces.** Examples: Claude plugins and skills, Cursor plugins, GitHub MCP Registry, Theia AI Registry, Goose 70+ extensions. MCP, AGENTS.md and Goose now sit under the Linux Foundation AAIF, so they are neutral standards.
5. **Repository rules and memory files** (AGENTS.md, CLAUDE.md, GEMINI.md, .cursor/rules, Kiro steering) and hooks on lifecycle events. AGENTS.md compatibility is expected.
6. **Multi-model choice with BYOK and local models.** Copilot BYOK with Ollama (including air-gap), Zed, opencode (75+ providers), Kilo (500+), JetBrains BYOK. Lock-in to one vendor is a stated objection.
7. **AI code review as a product.** Bugbot, Claude Code Review (Quick, Standard, Deep levels), Codex Code Review, Copilot review, Rubber Duck. Verification is now a separate SKU.
8. **Usage-metered and credit billing replacing flat "requests".** Cursor (June 2025), Copilot AI Credits (June 2026), Codex credits (April 2026), Kiro, Devin quotas (March 2026), Trae tokens. Users now expect live usage meters and spend limits.
9. **Multi-surface presence.** IDE, CLI/TUI, desktop app, web, Slack and mobile, with ACP letting one agent run inside many editors (Zed, JetBrains). A protocol-based agent core outlasts any single UI.
10. **Security and governance primitives.** Sandboxing, auto-approval classifiers, per-tool permission prompts, enterprise audit logs, admin policies (Cursor 3 enterprise settings, Copilot agent control plane, Claude managed settings and OTel safety events), ZDR and air-gap options. Security and privacy is the #2 adoption barrier in the SO 2026 survey.

---

## 5. White spaces (poorly covered or not covered at all)

1. **Explained, competence-based routing.** Every "Auto" mode (Cursor, Copilot) is opaque, and users suspect it routes to whatever is cheapest for the vendor. Cursor's 2025 "unlimited Auto" episode increased that suspicion. Nobody publishes a per-task "routed to X because Y" line, and nobody keeps a track record per task type.
2. **Cost before run, and hard budgets.** No product estimates cost before execution. Replit says outright that estimates "would be inaccurate". Cursor's limits can overshoot. Cost shock dominates complaints about Cursor, Replit, Devin, Kiro credits and Claude limits. A guaranteed ceiling with a range estimate and early stopping is open territory. Research shows agent token use varies up to 30x, so present a range or confidence interval, not a point estimate.
3. **Routed cross-provider verification.** Only fixed pairs exist (Rubber Duck: Claude→GPT-5.4; Amp: X→GPT Oracle; the Codex plugin for Claude). Nobody offers configurable critic selection, debate or vote, or reports where critics disagree. GitHub's own 74.7% gap-closing claim supports the value. Evidence: SO 2026 found that 48% trust AI only when output can be verified.
4. **Tamper-evident, replayable audit.** Audit logs today are admin events (Cursor, Factory) or transcripts. Nobody offers a hash-chained, deterministic replay of what model saw what, on which provider, at what cost. That matters for regulated teams and incident review.
5. **Secret zones and data-residency rules per task.** Products offer either global privacy mode or full air-gap (Tabnine, Copilot BYOK air-gap). None route _sensitive subtasks to local models and the rest to cloud_ automatically. Trae's privacy backlash and Tabnine's acquisition plus removal of local indexing leave privacy-conscious mid-market users underserved.
6. **Provider-outage and rate-limit resilience.** Claude limit backlash keeps recurring; Gemini CLI's free tier ended June 2026; Firebase Studio is shutting down. Most products have no transparent fallback across providers (Claude Code falls back only within Anthropic's own model aliases). Multi-vendor fallback is a direct answer to "my agent stopped at 3pm Tuesday".
7. **A task graph as the primary view.** Managers show _agents_ as lists or tabs. None shows a _dependency graph of the request_, with each node's model, cost, status and critic verdict, that can be edited before and during the run.
8. **Vendor-neutral orchestration of _other_ agents.** Agent HQ, JetBrains Air, Zed ACP and Warp host third-party agents side by side. None of them routes subtasks across those agents, cross-reviews them, or keeps one budget across them.
9. **Learning from outcomes.** Memory today is static rules files. Nobody uses accept, reject or revert signals and critic verdicts to update routing preferences for each repository.
10. **Honest productivity measurement.** The METR results (19% slower; follow-up inconclusive) show perception differs from reality. A studio that shows time and cost per accepted change from its own journal would stand out.

---

## 6. Top 15 features users love most (with evidence)

| #   | Feature                                                                          | Evidence                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Terminal-native agent that "just does the task" end to end (Claude Code style)   | Most loved at 46% vs 19% and 9% (Pragmatic Engineer 2026, n=906) [S]; 75% use at startups [S]                                                                             |
| 2   | Parallel agents in isolated worktrees or cloud                                   | Headline of Cursor 2.0 and 3.0, Antigravity 2.0, Codex app, JetBrains Air; widely covered [P/S]                                                                           |
| 3   | Tab / next-edit prediction (fast inline completion)                              | Cursor's original moat; Zed made Zeta predictions its metered free unit (2,000 per month) [W]; Copilot completions stay on hosted models because users depend on them [W] |
| 4   | Plan mode: read-only proposal, then approve                                      | Cline Plan/Act, Copilot plan mode, Jules plan approval, Kiro specs; Addy Osmani on Cline [S]                                                                              |
| 5   | Checkpoints and one-click rollback                                               | Cline shadow-git checkpoints, Replit checkpoints, Cursor restore; "roll back to any previous state" is a frequently praised feature [W]                                   |
| 6   | Model choice and BYOK with no markup                                             | opencode, Kilo, Cline, Amp, JetBrains BYOK, Copilot BYOK GA; "zero markup" is a lead feature in reviews [W, consistent]                                                   |
| 7   | Background and asynchronous agents with PR output                                | Copilot coding agent, Codex cloud, Jules, Devin; handing off from Slack, mobile or Linear in Cursor 3 [P]                                                                 |
| 8   | Automatic AI PR review that catches real bugs                                    | Bugbot, Claude Code Review levels, Codex review, Rubber Duck's 74.7% gap claim [P/S]                                                                                      |
| 9   | Project rules and memory files                                                   | AGENTS.md is now an AAIF standard [S]; CLAUDE.md, rules and steering are adopted everywhere                                                                               |
| 10  | MCP integrations and plugins/skills                                              | Goose 70+ extensions; Claude and Cursor marketplaces; registries in GitHub and Theia [P]                                                                                  |
| 11  | Live cost and usage visibility                                                   | Cline per-task cost is praised [W]; Claude `/usage` with one-key fixes (October 2026) [P]; absence of visibility is the #1 complaint (Cursor, Replit, Devin) [S]          |
| 12  | Interrupt and steer mid-run (Esc, then a new instruction) without losing context | Universal in CLIs; Devin criticised for drift needing a "kill and restart" [W]                                                                                            |
| 13  | Local and offline models for privacy                                             | Copilot BYOK with Ollama including air-gap [P]; Tabnine air-gap; Void, opencode and Crush users; privacy is the #2 adoption barrier (SO 2026) [S]                         |
| 14  | Spec-driven docs that persist (requirements, design, tasks)                      | Kiro's core differentiator; tasks.md updates live [P]; complaint: heavy for small tasks [W]                                                                               |
| 15  | Browser and UI-aware agents (design mode, screenshots)                           | Cursor 3 Design Mode and browser [P]; Antigravity browser agent; Replit full-stack preview                                                                                |

---

## 7. Implications for KP Studio (brief)

- The differentiators that hold up are #1–#7 in section 5: explained routing, pre-run cost with a hard ceiling, routed cross-provider critics, a hash-chained journal with replay, secret zones that route sensitive tasks to local models, cross-vendor fallback, and a task graph as the main UI.
- Do not compete on agent raw skill or benchmarks. Model choice drives benchmark scores, and harness claims are self-reported.
- Table stakes to plan for early:
  - ingest AGENTS.md and CLAUDE.md, and use the MCP registry;
  - worktree isolation for parallel nodes;
  - checkpoints and rollback;
  - a plan-approval gate;
  - ACP or an equivalent so KP can run inside Zed and JetBrains, and so external CLIs can run as KP graph nodes.
- Risks:
  - Copilot (Rubber Duck plus Agent HQ plus AI Credits) is the closest incumbent to "multi-vendor plus critic" and has distribution. Watch for routed critics in its next release.
  - Provider ToS and subscription-auth limits on driving Claude, Codex or Gemini subscriptions from third-party tools [U, not researched]; BYOK API keys are the safe path.
  - Present cost estimates as ranges; token variance between runs is high (up to 30x reported).

## Key sources

- cursor.com/changelog/3-0 and /2-0 [P]
- code.claude.com/docs/en/changelog [P]
- helpnetsecurity.com 2026-04-07 (Rubber Duck) [S]
- github.blog changelog: BYOK 2026-04-22, Copilot CLI GA 2026-02-25 [P]
- ampcode.com/news/gpt-5-oracle and /gpt-5.4-the-new-oracle [P]
- kiro.dev docs and blog [P]
- 9to5google.com 2026-05-19 and blog.google I/O 2026 [S/P]
- en.wikipedia.org/wiki/Firebase_Studio [S]
- newsletter.pragmaticengineer.com/p/ai-tooling-2026 [S]
- stackoverflow.blog 2026-10-06; theregister.com 2026-10-10 [S]
- theregister.com 2025-09-18 (Replit) and 2026-01-05 (Claude limits) [S]
- venturebeat (Claude rate limits) [S]
- forum.cursor.com (pricing clarification) [P]
- thenewstack.io (Goose and AAIF) [S]
- eclipsesource.com Theia 1.73–1.76 [P]
- labs.scale.com SWE-bench Pro; benchlm.ai and llm-stats Terminal-Bench 2.0 [W]
- arXiv 2607.21656, 2603.00520 [S]
- [W] reviews from morphllm, vibecoding.app, theaiagentindex, rywalker.com, devtoolsreview and others for pricing
