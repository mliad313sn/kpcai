> Annex B of [BENCHMARK-2026-10](BENCHMARK-2026-10.md). Analyst report, kept as delivered (2026-10-23). **[U]** = unverified (single secondary or vendor-adjacent source).

# KP Studio competitive research: builders, orchestration, routing, governance, surveys, pricing (as of 2026-10-23)

How to read this: every fact has its source inline. **[U]** means unverified: it comes from one secondary or vendor-adjacent source, or it conflicts with other sources. "Verdict" lines are my judgement. I did not cover AI IDEs or coding agents, as you asked. They only appear where a security incident or pricing event affects the market as a whole.

---

## 1. AI app builders and design-to-code ("conception")

### Top players

- **Lovable**: the default prompt-to-full-stack-app tool for non-engineers.
  - Funding: $400M Series C at a $13.3B valuation (TechCrunch, 2026-08-12).
  - Revenue: $500M ARR in June 2026 (TechCrunch). A $600M+ headline appeared in Sept 2026 **[U]**.
  - Pricing: Free (5 credits/day), Pro $25/mo with 100 credits, Business $50 (SSO, security center). Top-ups cost $0.30 per credit on Pro and $0.60 on Business. Since Aug 2026 there is reportedly one credit pool covering build, Cloud and AI calls **[U]** (eesel.ai; banani.co, 2026).
  - Security record: CVE-2025-48757 (CVSS 9.3). Supabase row-level security was missing in 170 of 1,645 scanned apps (303 endpoints). MITRE lists the CVE as "disputed": Lovable says data protection is the customer's job (superblocks.com; SentinelOne CVE DB). An "April 2026 breach" of all pre-Nov-2025 projects was reported **[U]** (bastion.tech).
  - Verdict: the fastest idea-to-deployed-app path. Weak on security posture, cost predictability and engineering handoff.
- **Bolt.new (StackBlitz)**: a browser WebContainer builder with token-metered pricing.
  - Pricing: Free 1M tokens/mo (300K/day cap). Pro $25 for 10M tokens, which roll over. Teams $30 per seat. Pro 50 and Pro 100 tiers exist.
  - Hosting is not billed: apps deploy to the user's own Netlify, Cloudflare or Vercel account (jetadmin.io; banani.co, Sep 2026).
  - Reviewers say output quality depends heavily on how precise the prompt is.
  - Verdict: for devs who want speed with BYO hosting. Lowest handoff quality of the big three (techsy.io, 2026).
- **v0 (Vercel)**: the most developer-oriented builder.
  - Feb 2026 rebuild: works on existing codebases, uses sandboxes, Git branches and PRs, and adds governance (uibakery.io, 2026).
  - Pricing: Free with $5 credits and 7 messages/day, including Design Mode and GitHub sync. Plus $30 per user, Business $100 per user. The old $20 Premium plan is being sunset **[U]**.
  - Output defaults to shadcn/ui and arrives as a reviewable PR.
  - Verdict: best handoff to engineering, but tied to the Vercel and Next.js stack.
- **Replit (as builder)**:
  - Funding: $400M Series D at $9B (Mar 2026).
  - Revenue: about $525M annualized in Apr 2026, targeting $1B **[U]** (sacra/komo).
  - Effort-based Agent pricing replaced the flat $0.25 per checkpoint. The main complaint is the unpredictable cost of finishing an app. Gross margin swung between +36% and −14% in 2025 because of LLM costs **[U]**.
  - Verdict: strong all-in-one hosted runtime, but cost opacity is its Achilles heel.
- **Figma Make, Make kits and the Figma MCP server**: the incumbent design platform moving downstream into code.
  - Make kits (Apr 2026) bundle npm design-system packages, styles, variables and a guidelines file.
  - GitHub push is reportedly one-way: GitHub edits are overwritten by the next push **[U]** (buildmvpfast.com).
  - Config India (Oct 2026) announced: GitHub and npm code import (closed beta), library guidelines (open beta), and "centralized design systems" bundling libraries, code and guidelines (preview) (figma.com/release-notes).
  - MCP server: remote and desktop variants, Code Connect, `download_assets`, and write-back from browser UI to canvas for Claude Code, Codex and VS Code only. Free in beta; Figma says it will become usage-based paid (developers.figma.com; help.figma.com).
  - AI credits: Professional seats get 3,000 credits/mo since Mar 18, 2026. That works out to roughly 50–70 prompts, and forum users report burning through it in about 2 hours. Extra credits were argued to cost 5.6× more than adding a seat (forum.figma.com, 2026).
  - Q2-2026 call: more than 80% of paid customers with >$10K ARR consume AI credits weekly (Nasdaq, Q2 2026).
  - Verdict: owns the design system of record. Its code path is still maturing and depends on credits.
- **Google Stitch** (Labs): text or image → multi-screen UI, built on Gemini.
  - Exports reportedly include Figma, HTML/CSS, React+Tailwind and an MCP server for coding agents **[U]** (Aug 2026 guide). UXPin, a competitor, says it exports via Firebase Studio rather than as JSX.
  - Verdict: free ideation funnel into Google's stack.
- **Google AI Studio Build mode**: vibe coding with a one-click "Deploy app" to Cloud Run.
  - Full-stack runtimes with server logic and secrets (ai.google.dev).
  - Firestore, Firebase Auth and Cloud SQL integration, with the agent choosing the database (Google Cloud blog, May 2026).
  - Your Gemini API key is passed into Cloud Run environment variables (Cloud blog).
  - Verdict: free, Gemini-only, GCP lock-in.
- **Claude Design / Artifacts (Anthropic)**:
  - Launched 2026-04-17 as a Labs preview on Opus 4.7, producing prototypes, slides and mockups (TechCrunch, 2026-04-17).
  - Merged into Claude on 2026-09-16 **[U]**. Exports reportedly include Canva, PDF, PPTX and HTML, plus a dedicated "handoff bundle" for Claude Code **[U]** (magicpatterns.com; agence-scroll.com).
  - Verdict: single-model, but bundled into a subscription people already pay for. It is a serious threat for the "conception" front end.
- **ChatGPT Canvas**: no new 2026 data found. Treat it as a doc and code canvas, not a builder.
- **Builder.io Fusion** (1.0, Nov 2025): a visual canvas over the real repo.
  - Uses existing components and design systems, turns Figma frames into components, opens PRs to GitHub, and has a bot that answers review comments and fixes builds. It also has AI memory and granular permissions (builder.io/blog/introducing-fusion).
  - Verdict: the closest to "design-system-aware agent in a real codebase". Enterprise oriented.
- **Anima**:
  - Agentic playground with a "UX design agent" (Jan 2026) and an Anima MCP server that feeds code to Claude Code and Cursor.
  - Offers BYOK (OpenAI or Anthropic key, or a Codex subscription) so you avoid Anima credits, plus auto-created databases (animaapp.com blog; vendor claims).
  - Verdict: notable BYOK precedent in design-to-code.
- **Base44 (Wix)**:
  - Acquired June 2025 for about $80M plus earnout.
  - ARR $59M at end of 2025 (Wix Q4 call) and reportedly $200M by Aug 2026 (Calcalist). 10M users **[U]** (Sacra).
  - Verdict: proof that the non-dev market is huge and fast-growing.
- **Framer AI**: a website generator from a prompt with one-click publish, from about $15/mo **[U]**. Marketing sites only.
- **Uizard (Miro, acquired 2024)**: Autodesigner 2.0 multi-screen generation. Reviews say it has seen no major updates since 2024 **[U]** (banani.co). It is stagnating.
- **Galileo AI**: acquired by Google in 2025; its technology became Stitch (prior knowledge **[U]**).
- **Create.xyz**: no 2026 data found.

### Matrix: design-to-code and conception

H = strong, M = partial, L = weak or absent. Ratings are my synthesis of the sources above.

| Tool              | Requirements / PRD | UX flows (multi-screen)    | UI generation | Design system                    | Code export quality                 | Collaboration                | Deploy                      |
| ----------------- | ------------------ | -------------------------- | ------------- | -------------------------------- | ----------------------------------- | ---------------------------- | --------------------------- |
| Lovable           | M (chat plan mode) | M                          | H             | L–M (templates on Business)      | M (GitHub full repo, "first draft") | M (workspaces)               | H (Lovable Cloud, Supabase) |
| Bolt.new          | L                  | M                          | H             | L                                | L–M (prompt-dependent)              | M (Teams)                    | H (BYO Netlify/CF/Vercel)   |
| v0                | M                  | M                          | H             | M (shadcn defaults)              | **H** (PRs, branches)               | M (team sharing)             | H (Vercel only)             |
| Replit            | M (Agent plans)    | M                          | M–H           | L                                | M                                   | H (multiplayer)              | H (Replit hosting)          |
| Figma Make + MCP  | L–M                | **H** (canvas, prototypes) | H             | **H** (Make kits, Code Connect)  | M (one-way GitHub push **[U]**)     | **H**                        | M (publish Make sites)      |
| Google Stitch     | L                  | H (multi-screen)           | H             | L–M                              | M (HTML/React **[U]**)              | L                            | L (via Firebase/AI Studio)  |
| AI Studio Build   | L                  | L–M                        | M–H           | L                                | M                                   | L                            | H (Cloud Run, Gemini-only)  |
| Claude Design     | M (writes briefs)  | M–H                        | H             | M (reads brand/codebase **[U]**) | M (HTML, Claude Code handoff)       | M (org sharing)              | L                           |
| Builder.io Fusion | M                  | M                          | H             | **H** (your components)          | **H** (PRs on the real repo)        | H (PM, design and dev roles) | M (your CI)                 |
| Anima             | L                  | M                          | H             | M                                | M–H (React from Figma)              | M                            | M (publish)                 |
| Base44            | M                  | M                          | M             | L                                | L (platform-bound)                  | M                            | H (hosted)                  |
| Framer AI         | L                  | L (sites)                  | H (marketing) | M (site styles)                  | L (no app code)                     | H                            | H (hosting)                 |
| Uizard            | L                  | H (wireframes)             | M             | L                                | L                                   | M                            | L                           |

**Conception gap (verdict).** No tool covers requirements → UX flows → UI → code → deploy with traceability between artifacts. Specifically, nothing links which requirement produced which screen, component and commit. Requirements and PRD support is weak everywhere. Design systems are either Figma-centric (Make kits) or repo-centric (Fusion, v0). Security of the generated apps, such as row-level security and secrets, is the most visible failure mode. The Cloud Security Alliance counts 20+ incidents in AI-built apps exposing tens of millions of users, Jan 2025–Feb 2026 **[U]** (via pluto.security).

---

## 2. Multi-agent and orchestration platforms

Software-developer focus is marked as High, Medium or Low.

- **LangGraph / LangSmith (LangChain)**: High. The de facto code-first graph runtime.
  - Pricing: LangSmith Developer free (5K traces, 14-day retention), Plus $39 per seat (10K traces). Managed Platform "from $35/mo" **[U]** (truefoundry.com, Jul 2026). The rename to "LangSmith Deployment" is unconfirmed.
  - Covers observability, evals, human-in-the-loop interrupts and checkpointing.
  - Verdict: the reference for durable agents with human approval.
- **Microsoft Agent Framework**: High for .NET and Python developers.
  - 1.0 GA on 2026-04-02, merging AutoGen orchestration with Semantic Kernel connectors. Supports MCP, A2A, OpenAPI and graph workflows.
  - AutoGen is in maintenance mode. Semantic Kernel gets fixes for at least one more year **[U]** (futureagi.com; Visual Studio Magazine, Oct 2025).
  - **Copilot Studio** is the low-code business layer, with Microsoft 365 governance (Entra, Purview).
  - Verdict: the enterprise default inside Microsoft shops.
- **OpenAI Agents SDK / AgentKit**:
  - OpenAI is phasing out Agent Builder and Evals; they become unavailable after 2026-11-30.
  - Migration targets: the Agents SDK for agents built in code, and "Workspace Agents" in ChatGPT for natural-language agents (openai.com/index/introducing-agentkit, notice 2026-06-03).
  - Verdict: platform churn risk is real. Hosted eval and builder products can disappear within a year.
- **Google ADK / Gemini Enterprise Agent Platform**:
  - At Next '26 (2026-04-22), Vertex AI Agent Builder, Agentspace and ADK were unified under the Gemini Enterprise Agent Platform **[U]** (pasqualepillitteri.it).
  - ADK is Apache-2.0 in Python, TypeScript, Go and Java. ADK 2.0 adds graph workflows **[U]** (futureagi.com).
  - Verdict: strong evaluation and simulation tooling. GCP-centric.
- **AWS Bedrock AgentCore**: High for infrastructure teams.
  - Modules: Runtime, Gateway, Memory, Identity, Policy and Evaluations.
  - Policy uses Cedar rules (natural language compiled to Cedar), enforced at the gateway before tool calls run. Evaluations is GA **[U]** (dio.me, 2026).
  - Metered per module, about $0.0895 per vCPU-hour **[U]** (cipherprojects.com).
  - Verdict: the best "policy before tool execution" story among the hyperscalers.
- **CrewAI**: Medium.
  - Role-based crews. Crew Studio (Aug 2026) with Arize tracing and evals **[U]**.
  - CERT/CC disclosed CrewAI CVEs (RCE/SSRF via insecure fallbacks) in Mar 2026 **[U]** (getpanto.ai).
  - Verdict: popular for prototypes; its security track record is a liability.
- **Mastra**: High for TypeScript developers.
  - YC W25, $13M raised, 1.0 in Jan 2026, about 19K GitHub stars **[U]**.
  - Verdict: the TypeScript-native LangGraph alternative, relevant to a TypeScript stack.
- **Dify**: Medium. Raised $30M Series Pre-A (BusinessWire, 2026-03-09). Visual low-code LLM apps with an enterprise compliance team.
- **Flowise**: Low–Medium. Acquired by Workday (2025-08-14), now oriented to the HR and ERP ecosystem.
- **n8n**: Medium.
  - Valuation $2.5B in Oct 2025 (Series C) and $5.2B with SAP investing in May 2026 **[U]** (devtoollab, multiples.vc).
  - AI workflows are about 25–30% of new workflows **[U]**.
  - Self-hostable. Verdict: the ops and integration glue.
- **Zapier Agents**: Low. Agents plus MCP. AI steps on the Premium tier bill each AI call as 5 tasks **[U]**.

**Cross-cutting.** Observability is consolidating: ClickHouse acquired Langfuse on 2026-01-16, keeping the MIT core and self-hosting (Orrick; InfoWorld). Cost appears mostly as post-hoc traces, not as a budget set before the run. Human-in-the-loop exists as interrupts in LangGraph, MAF and ADK, and as Cedar policy in AgentCore. None of these platforms ship a cross-provider critic or vote as a first-class primitive, and none ship a tamper-evident (hash-chained) journal. Their audit is log-based.

---

## 3. Model routing and gateways

- **OpenRouter**: the market leader.
  - Funding: $113M Series B led by CapitalG at about $1.3B (May 2026).
  - Scale: 25T tokens/week, 400+ models, 8M+ users (dealroom, 2026-05-26). Stripe reportedly explored a deal around $10B **[U]** (implicator.ai).
  - Fees: 5.5% on credit purchases (min $0.80); 8% on the Business plan **[U]**. BYOK: the first $25K/mo of usage is free, then 5% of the equivalent OpenRouter price **[U]** (truefoundry, Oct 2026). This supersedes the earlier "1M free BYOK requests" policy (openrouter.ai blog, Oct 2025).
  - **Auto Router (`openrouter/auto`)**: picks the model "by the wisdom of the market", meaning trailing 7-day spend. There is no routing fee, and `cost_tier` ranges from low to max. It reportedly replaced its earlier Not Diamond backend **[U]** (openrouter.ai/openrouter/auto; aireiter.com, Aug 2026).
  - Verdict: its "competence" signal is popularity, not task-measured quality. That is a weak spot.
- **Not Diamond**: learned router.
  - "Not Diamond Code" routes coding sessions step by step and is aware of cache state and task complexity. It claims 20–30%+ savings and is waitlist-only.
  - Funding: $2.3M pre-seed **[U]** (bito.ai; bestaiweb.ai).
  - Verdict: its benchmark claims are vendor-reported.
- **Martian**: router at the prompt level across 200+ models. Reportedly repositioning as a research lab (ARES, K-Steering) **[U]**, with a near-$1.3B valuation rumoured **[U]** (orcarouter.ai, a competitor; bestaiweb.ai).
- **LiteLLM**: the open-source proxy and SDK, used everywhere.
  - **Supply-chain compromise on 2026-03-24**: TeamPCP stole PyPI publishing credentials via the Trivy CI dependency and published v1.82.7 and v1.82.8. The 1.82.8 release used a `.pth` infostealer that ran on every Python interpreter startup. It was live for about 40 minutes per LiteLLM, while other sources give a window of several hours. The Docker image was not affected. v1.83.0 is the clean release (docs.litellm.ai advisory; BleepingComputer; Datadog Security Labs).
  - Verdict: the risk of a gateway sitting in your dependency tree is now a demonstrated fact.
- **Portkey**: raised a $15M Series A (Feb 2026), then was acquired by Palo Alto Networks (closed 2026-05-29). It becomes the AI gateway for Prisma AIRS (paloaltonetworks.com press, 2026).
  - Verdict: gateways are being absorbed into security vendors.
- **Requesty**: 400+ models. **Unify**: router driven by live benchmarks refreshed every 10 minutes **[U]**. No 2026 status news found for either (respan.ai, llmreference.com).
- **Arch-Router / Plano (Katanemo)**: a 1.5B router that maps queries to user-written domain and action policies. New models can be added without retraining. Claims state-of-the-art matching to human preferences and "93%" accuracy **[U]** (arXiv 2506.16655; VentureBeat). Weights are open on Hugging Face.
  - Verdict: the most credible open, local "preference/competence" router. Embeddable.
- **Evidence base**: RouterArena (ICLR 2026) and RouteLLM benchmarks exist. Third-party write-ups cite 30–85% cost cuts **[U]**. Multi-model "council" consensus reportedly cut hallucination by 41.7% relative, at 4.2× token cost **[U]** (Council Mode paper, pith.science 2604.02923).
  - Consumer validation: Perplexity Model Council (2026-02-05) runs 3 frontier models with a synthesizer, on Max ($200/mo) (resultsense.com).

**Verdict for KP Studio.** Nobody publishes per-task competence evidence tied to the user's own outcomes. Routers justify their choices with popularity (OpenRouter), opaque learned scores (Not Diamond, Martian) or static policies (Arch). "Routing with justification plus local evidence from your own review outcomes" is genuinely open ground.

---

## 4. Governance, enterprise and security

### Regulatory

- **EU AI Act, GPAI**:
  - Provider obligations started 2025-08-02. The Commission's enforcement powers apply from 2026-08-02. Models already on the market have until 2027-08-02.
  - The GPAI Code of Practice is voluntary. Reported signatories include Amazon, Anthropic, Google, IBM, Microsoft and OpenAI **[U]**.
  - Fines up to €15M or 3% of turnover **[U]** (CSA research note 2026-08-03; medialaws.eu).
- **Digital Omnibus**:
  - Annex III high-risk obligations move to **2027-12-02**; Annex I products to 2028-08-02. In force around 2026-07-27.
  - Article 50 transparency obligations are **not** delayed (Aug 2, 2026), and watermarking stays on 2026-12-02 (Gibson Dunn; Orrick, Jul 2026; Jones Walker).
- **Implication.** Coding assistants are generally not high-risk systems. A studio that _orchestrates_ GPAI models is a downstream deployer or provider of an AI system. Its obligations are transparency, logging that supports the providers' documentation, and AI literacy. Buyers will still ask for evidence (my analysis).

### Certifications and procurement

- **ISO/IEC 42001** is becoming a procurement gate, much as SOC 2 did. Requests show up in finance, health and public-sector RFPs.
- Augment Code claims to be the first ISO 42001-certified coding assistant. Anthropic is reportedly certified (Jan 2025) **[U]** (augmentcode.com; knowlee.ai; timewell.jp).
- Auditors warn buyers to check that the certificate's scope actually covers the deployment being bought (tarrysingh.com).
- Gartner published a **2026 Magic Quadrant for Enterprise AI Coding Agents**. Its lens covers governance, pricing, support, deployment models, workflow integration and durability (gartner.com webinar).

### Provenance and SBOM for AI

- No standard yet.
- **Agent Trace** RFC v0.1.0 (Jan 2026) is a vendor-neutral record linking code ranges to conversations and models. Backers reportedly include Cloudflare, Vercel and git-ai (agent-trace.dev).
- **git-ai** stores line-level AI provenance in `refs/notes/ai`.
- **CycloneDX ML-BOM** and OWASP AIBOM cover models, not code attribution.
- Commentators call this "two specs, no standard" (thinkscientist.com; mattgoodrich.com; OWASP AISVS).

### Incidents shaping buyers, 2025–2026

- **Nx "s1ngularity"** (2025-08-26): malware drove _locally installed_ AI CLIs with `--dangerously-skip-permissions`, `--yolo` and `--trust-all-tools` to search the filesystem for secrets. Wiz reports hundreds of successes. About 1,700 users' secrets leaked (InfoQ; Cloudsmith).
- **Shai-Hulud**: a self-propagating npm worm that used TruffleHog to steal tokens, compromising 187+ packages (Trend Micro, Sep 2025).
- **postmark-mcp**: the first malicious MCP server. Version 1.0.16 BCC'd every outgoing email after 15 clean releases (The Hacker News, Sep 2025).
- **CVE-2025-6514**: MCP infrastructure RCE, CVSS 9.6.
- **OX Security**: command injection through MCP JSON config edits driven by prompt injection, across Cursor, Claude Code, Gemini CLI and Copilot. The only CVE issued is Windsurf's, CVE-2026-30615 (ox.security).
- **Claude Code GitHub Action**: a prompt-injection permission bypass (CVSS 7.8) led to the "Clinejection" npm compromise of Cline. CVE-2026-21852 allowed API-key exfiltration before the trust dialog. A deny-rule bypass used 50 no-op subcommands (CSA research note; truefoundry, 2026). **[U]** on exact numbers.
- **Cursor CVE-2026-22708**: allowlisted commands were weaponized (secondary sources).
- **LiteLLM PyPI compromise**: see section 3.
- **OWASP (Jun 2026)**: prompt injection still drives most agentic AI failures in production (Help Net Security, 2026-06-11).
- **Veracode 2025**: insecure choices in about 45% of 80 curated tasks across 100+ LLMs. Java had a failure rate above 70%. Security has not improved as models got better (Veracode press, 2025-07-30).

### 10 requirements enterprises and teams impose

Synthesized from the sources above plus standard RFP practice.

1. **Identity and access**: SSO/SAML, SCIM, RBAC, plus per-agent and per-tool permissions with least privilege (Fusion, AgentCore Policy and Lovable Business all sell this).
2. **Data control**: zero data retention and no training on customer data by default (v0 Business sells "training opt-out by default"), region pinning and data residency, and on-prem or VPC options.
3. **Audit trail**: immutable, exportable logs of prompts, tool calls, model choices and approvals, ready for SIEM, with retention policies.
4. **Certifications**: SOC 2 Type II and ISO 27001 as the floor; ISO 42001 increasingly; trust-center evidence whose scope matches the deployment.
5. **Cost governance**: budgets, caps and alerts per team and project, no surprise overages, chargeback. Uber reportedly exhausted an annual AI budget in four months **[U]**.
6. **Supply-chain security**: an allowlisted MCP and tool registry, pinned and signed dependencies, sandboxed execution, network egress control (in response to postmark-mcp, LiteLLM and Nx).
7. **Secrets hygiene**: secret scanning on inputs and outputs, vault integration, keys never in the model context, redaction in logs.
8. **Prompt-injection defenses**: policy enforced _before_ tool execution (the Cedar-at-gateway pattern), human approval for destructive actions, trust boundaries for repository content.
9. **Provenance and IP**: attribution of AI-generated code (Agent Trace or git-notes), license and snippet checks, IP indemnity from the vendor, an SBOM or AIBOM in CI.
10. **Model choice and continuity**: BYOK or BYO-cloud (Bedrock, Azure, Vertex), approved-model lists, fallback when a provider fails or deprecates a model, and immunity to vendor product churn (the OpenAI Agent Builder shutdown).

---

## 5. Developer surveys, 2025–2026

- **Stack Overflow 2026** (30,903 respondents, 169 countries; press release and The Register, 2026-10-10):
  - 66% use coding assistants or agents; 26% use automated agent workflows.
  - Only **6.6%** trust AI for important decisions. **48%** trust it "when it's easy to verify."
  - **78.7%** say source attribution matters.
  - 2025 baseline: 46% distrust vs 33% trust accuracy, 3% high trust.
- **METR**:
  - RCT, early 2025: experienced open-source developers were **19% slower** with AI but _believed_ they were 20% faster (metr.org, 2025-07-10).
  - Feb 2026 update (57 developers, 800+ tasks): an estimated −18% task time for returning developers and −4% for new ones. Both confidence intervals include zero. Selection bias came from developers refusing the no-AI arm. METR is redesigning the study. Net: small or uncertain gains.
- **DORA 2025** (about 5,000 respondents): about 90% use AI. AI is an "amplifier" of existing strengths and weaknesses. Throughput gains are offset by a higher change-failure rate in weaker clusters (InfoQ; robbowley.net).
- **DORA 2026 "ROI of AI-assisted Software Development"**: a J-curve with an initial dip. **Code review is where ROI is won or lost** (InfoQ, May 2026; kodus.io).
- **JetBrains 2025** (24,534 respondents):
  - 85% use AI regularly; 19% save 8+ hours a week.
  - 23% worry about low-quality code.
  - 66% don't trust productivity metrics and want transparency.
  - About 15% avoid AI, citing data protection or quality (JetBrains Research, Oct 2025).
- **GitHub Octoverse 2025**: TypeScript became the #1 language by contributors (Aug 2025), attributed partly to AI. Types catch LLM errors; 94% of LLM compilation errors were type failures. 1.1M public repos import an LLM SDK (github.blog, 2025-10-28).
- **What developers want next (synthesis)**:
  - Verifiability: tests, review, sources.
  - Cost predictability.
  - Control over autonomy.
  - Attribution.
  - Fewer subtle bugs, especially "almost right" code.
  - Code review capacity.

---

## 6. Pricing models and backlash

### Models in use

- **Seat plus included credits**: Copilot after June 2026, Lovable, v0, Figma.
- **Pure tokens**: Bolt.
- **Effort-based metering**: Replit Agent.
- **Marketplace fee**: OpenRouter (5.5%, and 5% above the $25K BYOK allowance).
- **BYOK to skip vendor credits**: Anima, Cline-style tools.
- **Metered infrastructure**: AgentCore.
- **Open source plus a cloud product**: LiteLLM, Langfuse, n8n, Mastra.

### Backlash timeline

- **Cursor, June 2025**: Pro moved from request caps to a $20 dollar pool, with overage at API rates. The CEO apologized, and Cursor refunded charges from June 16 to July 4, 2025 (fintechweekly; Cursor forum).
- **Anthropic, 2025**: first Claude Code weekly limits. Then on Sep 14, 2026, a "+25%" change that works out to a **17% cut** versus the expiring +50% promotion. Anthropic acknowledged this, and there was a June 2026 limit bug affecting about 3% of users (pasqualepillitteri.it; VentureBeat).
- **GitHub Copilot, 2026-06-01**: moved to usage-based "AI Credits" at API token rates. List prices stayed the same, but "an hour of agentic work consumed 8%+ of a monthly allowance" (github.blog, 2026-05-01; windowsforum).
- **Replit**: effort-based Agent pricing. The main complaint is the cost to finish, including being billed for checkpoints that failed (usecarly; jetadmin).
- **Figma, March 2026**: AI credit caps. Complaints about 2-hour exhaustion and overage priced 5.6× a seat (forum.figma.com).
- **Overall**: "Flat-rate era ended in 2026." Copilot, Cursor, Codex and Claude Code all moved to usage billing within 12 months, and fixed-price or open-source rivals gained share (usagebox.com; gcn.com) **[U]** on share figures.

### Pricing that would differentiate a BYOK multi-model studio

- **Zero markup on inference.** The user pays providers directly via BYOK and local models cost $0. Charge for the studio itself (a flat per-seat or per-machine license), never for tokens. This removes the incentive conflict that both credits and OpenRouter-style fees create.
- **A budget before the run, as a contract.** Show an estimate with a confidence band and require approval. Enforce a hard cap with interrupt-and-resume. Publish the accuracy of past estimates against actuals. Nobody does this today; Copilot, Replit and Lovable bill after the fact.
- **Show the cost of verification.** Display the marginal cost of critic, debate or vote modes against the defects they caught, and let teams set a "review spend" policy per risk level (Council Mode: 4.2× token cost for −42% hallucination **[U]**).
- **Local-first by default.** Route to local models when competence evidence says they are good enough. Report the savings.
- **Team tier.** Pooled budgets and chargeback, unlimited viewers and reviewers (designers and PMs shouldn't need paid seats; Figma's credit fight is the anti-pattern), and a self-hosted option at no extra price.

---

## White spaces a multi-model, local-first, verifiable studio could own

1. **Traceable conception chain.** Link requirement → UX flow → screen → component → commit → test, with every link in the hash-chained journal. No builder links requirements to code today.
2. **Verification as the product.** Cross-provider author and critic for design, code and security (row-level security, authorization, secrets), the very failure class behind Lovable's CVE. Stack Overflow 2026 found 48% trust AI when output is "easy to verify". DORA 2026 says review is where ROI is decided.
3. **Competence routing with evidence.** Routing justified by measured outcomes on the user's _own_ tasks (critic verdicts, test passes, reverts), not market popularity (OpenRouter Auto) or opaque scores. Publish the evidence locally, and optionally share it as anonymized benchmarks.
4. **Cost predictability.** A budget before every run plus a hard cap and BYOK. This answers the 2025–2026 pricing backlash directly.
5. **Tamper-evident provenance.** A hash-chained journal that exports to Agent Trace, git-notes and CycloneDX AIBOM. It turns "audit" from logs into evidence for ISO 42001, EU AI Act Article 50 transparency and customer due diligence. No standard has won yet, so you could be the reference implementation.
6. **A secure MCP tool bus.** Graded permissions, secret zones, allowlisted and pinned servers, egress control, and policy enforced before execution. These are exactly the defenses that s1ngularity, postmark-mcp and MCP config injection call for. Bring AgentCore's Cedar-style pattern to the desktop.
7. **Design-system-aware generation across vendors.** Ingest Figma (MCP, Code Connect), Make kits, Stitch or Claude Design exports and the repo's components. Generate with any model and check conformance with a critic model. Builders are each locked into one stack (v0/Vercel, AI Studio/GCP, Figma credits).
8. **Durability against vendor churn.** Orchestration that survives provider product shutdowns (OpenAI Agent Builder and Evals, gone after 2026-11-30) and model deprecations, with automatic fallback.
9. **Regulated and offline teams.** Local models with an air-gap mode, for the roughly 15% of developers (JetBrains) and the public, finance and health buyers who avoid cloud AI over data concerns.
10. **Honest productivity measurement.** Built-in before-and-after metrics for time, rework and defects caught. This answers METR's perception gap and JetBrains' 66% metric distrust.

---

## Risks

**Regulatory**

- Article 50 transparency and Dec-2026 watermarking duties apply to generated content, including UI and copy.
- High-risk timelines could shift again (Omnibus precedent). GPAI enforcement has been live since 2026-08-02, so expect pass-through documentation requests from buyers.
- ISO 42001 is costly for a small vendor; plan for its scope. Code-licensing and attribution law is unsettled. Data-transfer rules apply when routing to non-EU providers, so region-aware routing is needed.

**Security**

- The studio _is_ an agent with a tool bus, so it is a prime target for prompt injection (from repos, issues, web, design files) and for MCP and dependency compromise (LiteLLM, Nx, Shai-Hulud precedents).
- Local models can be weaker at refusing malicious instructions.
- Secret zones must hold against agents running with bypass flags (the s1ngularity pattern).
- Keep the gateway and router dependency surface minimal and pinned. Sign releases.

**Market**

- **Bundling.** Claude Design inside Claude, Figma Make inside Figma seats, AI Studio free, Copilot inside GitHub: "good enough" is free to the buyer at the margin.
- **Builder momentum and funding.** Lovable ($13.3B), Replit ($9B), Base44/Wix and OpenRouter ($1.3B, possible Stripe deal) are well capitalized.
- **Gateway consolidation into security vendors.** Palo Alto now owns Portkey.
- **Provider terms risk for BYOK.** Rate limits, subscription-only models, terms that forbid routing or arbitrage.
- **Weak evidence for multi-agent quality and productivity claims.** METR's intervals include zero; council gains cost about 4× tokens. KP Studio must prove that review mode pays for itself.
- **Selling a "studio" to two personas.** Designers and PMs on one side, engineers on the other. Figma owns the first and IDEs own the second.

---

### Source notes

- Many 2026 data points come from aggregators and vendor blogs. Items marked **[U]** should be re-checked against primary pages: vendor pricing pages, the NVD, the EU Official Journal (Regulation (EU) 2026/1744) and METR's Feb 2026 post. I could not fetch these directly.
- I found no 2026 data for: ChatGPT Canvas, Create.xyz, Framer's "Workshop" feature, JetBrains 2026 survey results, Requesty or Unify news, Helicone M&A, and the internals of Copilot Studio pricing.
