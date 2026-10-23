# KP Studio: whole-scope review (S10)

Author: seat S10, strategy and systems consultant (D-027) · Date: 2026-10-23 · Status: advice to the PO and the Sponsor. The PO decides and assigns (charter §1).
Base: branch `claude/adoring-euler-c7wa3f` at `ed8e5d2`, plus the uncommitted phase 4 gate fixes, which were read but not changed. The phase 5 design doc by S1 (`docs/design/`) did not exist yet when this was written. For Program mode I read `packages/program/src/*` (the D-025/D-026 engine built under D-013 pipelining) and decisions D-025/D-026.

Companion documents:

- [SIMPLICITY-CHARTER.md](SIMPLICITY-CHARTER.md): enforceable usability principles.
- [ECOSYSTEM-MODEL.md](ECOSYSTEM-MODEL.md): value flows, pack trust, benchmarks, pricing.
- [METRICS-NORTH-STAR.md](METRICS-NORTH-STAR.md): north star and guardrails, computed from the journal.
- [RISKS-AND-ETHICS.md](RISKS-AND-ETHICS.md): top risks of the virtual enterprise and their safeguards.

Conventions:

- **[U]** marks a claim I could not verify against a primary source.
- **(opinion)** marks a judgement, not a finding.
- File references are to this repository. Costs are in team-days of the current seat model: XS < 1, S 1–3, M 4–10, L > 10.

---

## Résumé (français)

**Verdict.** Le noyau est d'une qualité rare : plafond de coût appliqué (D-021), critique d'un autre fournisseur (principe 2), journal chaîné, enveloppe de délégation qui ne peut que se resserrer (`packages/program/src/envelope.ts`), rapports qui n'affirment rien sans preuve (`report.ts`). Le risque principal n'est plus la sûreté d'une exécution. C'est ce qui arrive quand des centaines d'exécutions tournent sans personne devant l'écran. Trois choses se dégradent alors :

1. **l'attention humaine** : trop de questions, des validations « en un clic » qui deviennent des tampons ;
2. **le retour d'information** : un démon silencieux ressemble à un démon qui va bien ;
3. **la simplicité** : un débutant affronte déjà environ 25 concepts, et l'entreprise virtuelle en ajoute une douzaine.

**Les cinq leviers les plus forts**, tous en phase 5, coût faible :

1. **Sources par abonnement.** Ne jamais piloter un abonnement grand public depuis le démon sans surveillance. Les conditions de certains fournisseurs l'interdisent désormais [U sur l'état exact]. C'est une décision du Sponsor.
2. **Battement de cœur et détection des échecs silencieux.** Le silence doit déclencher une alerte, pas rassurer.
3. **Limite de vitesse de dépense et dépense liée au progrès.** Plafonner les dollars par heure, et mettre en pause quand l'argent part sans résultat vérifié.
4. **Rapports par exception, utiles à la décision.** Trois lignes : ce qui a changé, ce qu'on attend de vous, le risque principal. Rien n'est envoyé quand il n'y a rien à dire, sauf le battement de cœur.
5. **Une seule étiquette de niveau de vérification par résultat** (V0 à V3), à la place d'une dizaine de signaux.

**Étoile polaire proposée : les résultats vérifiés durables** (DVO), c'est-à-dire les intentions humaines (une demande, ou un lot de travail d'une charte approuvée) qui aboutissent à un livrable :

- vérifié de façon indépendante ;
- accepté ;
- non annulé après 7 jours.

La métrique se calcule depuis le journal. Elle résiste au découpage artificiel, parce que l'unité est fixée par un humain. Six garde-fous l'accompagnent : coût par résultat, charge d'attention et taux de validation éclair, échecs silencieux, taux de reprise, invariants de sûreté, énergie.

**Simplicité.** Par défaut, une équipe à trois sièges (réalisateur, relecteur, spécialiste du pack). Les « départements » deviennent une vue avancée, pas un modèle imposé. Trois niveaux d'interface (débutant, habituel, expert), un budget de 7 mots de vocabulaire au niveau débutant, et une liste d'anti-fonctionnalités.

**Décisions du Sponsor** : abonnements et conditions des fournisseurs, politique d'usage acceptable, licence du format des packs, prix (Q-6), coureur cloud (Q-7), adoption de l'étoile polaire, affichage de l'énergie, gouvernance des bancs d'essai partagés.

## Executive summary (English)

**Verdict.** The kernel is unusually sound:

- cost before execution is enforced as a hard cap (D-021, ADR-0026);
- critics are routed to another provider (principle 2);
- the journal is hash-chained (ADR-0007);
- disputes fail closed (ADR-0029);
- memory is propose → confirm (ADR-0027);
- the Program-mode envelope can only narrow without the Sponsor (`envelope.ts` `widenings()`);
- reports refuse to call a delivery verified without CI evidence for the exact commit (`report.ts` `deliveryGap()`).

The single-run safety story is close to best in class (benchmark §2).

**The risk has moved.** D-025/D-026 change the product from a tool a person watches into an organisation that works while nobody watches. The failure modes of such systems are well documented in human factors and safety engineering:

- **Feedback goes missing.** A silent daemon looks like a healthy one. This is the classic "missing feedback" flaw of STPA.
- **Human approval degrades into rubber-stamping.** This is automation bias (Parasuraman & Riley 1997) and Bainbridge's "ironies of automation" (1983).
- **Optimisers game whatever is measured** (Goodhart, Campbell).
- **The organisation chart shapes the output** (Conway 1968), not always for the better.

**The product is also getting conceptually heavy.** A first-time user already meets about 25 concepts: node, protocol, criticality, band, cap, fallback, critic, dispute, checkpoint, worktree, pack, scope, memory layer, grade, bench, replay, fork… The virtual enterprise adds about 12 more: charter, envelope, department, seat, source policy, portfolio, gate, escalation, pre-answer, write policy, quota, cadence.

**Highest-leverage moves.** In Meadows' terms they act on information flows, rules and goals, not on parameters. All are phase 5 and S or XS, except where noted:

| #   | Move                                                                                                         | Why it matters                                                               |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1   | **Unattended mode uses API and local sources only**; subscription agents are interactive and opt-in          | Provider terms changed in 2026 [U on current state]; users risk account bans |
| 2   | **Heartbeat and dead-man's switch** for the daemon; absence of a report is an alert                          | Silent failure is the top failure mode of unattended automation              |
| 3   | **Spend-velocity cap and progress-gated burn**                                                               | Envelope caps bound the _amount_, not the _waste_                            |
| 4   | **Report by exception**: delta, asks, top risk, burn forecast; content-free notifications by default         | Decision-useful information, fewer leaks to chat services, less fatigue      |
| 5   | **One assurance label per outcome (V0–V3)**                                                                  | Compresses about 10 signals into the one bit the approver needs              |
| 6   | **North star: Durable Verified Outcomes**, plus four journal fields                                          | Gives the whole system one honest goal                                       |
| 7   | **One-team default charter**; departments as an expert view                                                  | Cuts about 12 concepts for most users; Conway-aware                          |
| 8   | **Risk-proportional approvals**: batch the trivial, force a look at the consequential, track rubber-stamping | Keeps human control meaningful, not ceremonial                               |
| 9   | **Calibrate the verifiers**: critic canaries and a small exploration share in routing                        | Verification is the product (W2); today its recall is unmeasured             |
| 10  | **Charter critique and a single-run baseline**                                                               | Principal–agent check on the PO assistant; stops agent bureaucracy           |

**What to remove or hide in exchange** is stated for each item. The net effect I propose is fewer default concepts, fewer default notifications and fewer CLI verbs than today.

**Sponsor decisions needed** (detail in §5):

1. subscription sources and provider terms;
2. acceptable-use policy;
3. pack format licence (Q-1);
4. pricing (Q-6);
5. cloud runner (Q-7);
6. adopting the north star and the "no time-saved claims" rule;
7. energy disclosure;
8. community benchmark data governance.

---

## 1. What is already right (keep, and say so loudly)

These choices are backed by evidence and should not be traded away for speed.

| Choice                                                                                                 | Where                                                    | Why it is right (discipline)                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved cost = band top = enforced cap                                                                | D-021, ADR-0026                                          | Behavioural economics: it removes the "surprise bill" that drove the 2025–26 pricing backlash (benchmark §6). The user anchors on the _maximum_, so outcomes are never worse than the anchor |
| Silence means no; disputes fail closed                                                                 | ADR-0019, ADR-0029 §4                                    | Safety engineering: fail-safe defaults (Saltzer & Schroeder 1975)                                                                                                                            |
| Envelope only narrows without the Sponsor; reserved items have no envelope field                       | `program/src/envelope.ts`, `actions.ts` `RESERVED_ITEMS` | Defence in depth; there is structurally no way to delegate the undelegable                                                                                                                   |
| Run output reaches the program only as typed fields; free text never parsed                            | `program/src/driver.ts` header                           | Security: it closes the "agent asks its manager for more budget" injection path                                                                                                              |
| Reports claim success only with evidence for the exact commit                                          | `program/src/report.ts` `deliveryGap`                    | Epistemics: no unsupported success claims, which is the opposite of vendor "time saved" numbers (METR 2025)                                                                                  |
| Productivity metrics from the journal only, with no "time saved"                                       | `docs/metrics/PRODUCTIVITY.md`                           | Measurement validity: it answers JetBrains' "66 % distrust metrics" and METR's perception gap                                                                                                |
| Grades bounded (±0.3 from the prior), self-review ignored, `revisedVerdicts` beside `acceptedFindings` | ADR-0028 §5–6, P4-F12                                    | Anti-Goodhart by design                                                                                                                                                                      |
| Domains as data (packs); repository packs can only tighten                                             | D-019, ADR-0025, `PACK-AUTHORING.md`                     | Platform economics: complements without code forks; safe default for untrusted contributions                                                                                                 |
| Source policies only narrow down the org chart (`sources.ts` `effectivePolicy`)                        | D-026                                                    | "Security is local-only" cannot be undone by a seat: a rule enforced at the right level of the control structure                                                                             |

---

## 2. Findings by lens

Each finding names the discipline, the evidence (a file or a source) and links to the recommendations in §3 (R-n).

### 2.1 Systems thinking: loops, leverage, autonomy at scale

Disciplines: system dynamics (Forrester; Sterman 2000), Meadows, _Leverage Points_ (1999), Cook, _How Complex Systems Fail_ (1998), Perrow, _Normal Accidents_ (1984).

**Main loops in the virtual enterprise:**

| Loop                                     | Type        | Mechanism (file)                                                                                                   | Failure at scale                                                                                                                                                                                                                                   |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 Competence learning                   | Reinforcing | Router picks a model → outcome → grade → measured competence → router picks it again (ADR-0028, `router/score.ts`) | **"Success to the successful"** (Senge archetype). Models never picked never gather evidence, so new or cheaper models are starved. There is no exploration term in ADR-0028 §5. → R9                                                              |
| L2 Budget                                | Balancing   | Estimate → gate → cap → stop (ADR-0014, D-021)                                                                     | Works per run. Across a portfolio, the balancing signal arrives only at the cap. **Delay plus a hard limit gives overshoot and then waste**: the whole envelope is spent before anyone looks. → R3                                                 |
| L3 Review                                | Reinforcing | More critics → more findings → more revisions → more cost (ADR-0029 §5–6)                                          | Contained by `revisedVerdicts` (P4-F12) and the review policy, but critic _recall_ is unknown, so the loop's value is assumed, not measured. → R9                                                                                                  |
| L4 Human attention                       | Balancing   | Escalations and confirmations → human answers                                                                      | As the portfolio grows, questions grow linearly with runs while attention is fixed. Response quality drops (alarm fatigue: Sendelbach & Funk 2013) or the human stops reading. → R4, R8                                                            |
| L5 Shifting the burden                   | Reinforcing | Humans rely on critics → their own review skill atrophies → more reliance                                          | The deskilling evidence is real: Budzyń et al., _Lancet Gastroenterol Hepatol_ 2025, adenoma detection fell from 28.4 % to 22.4 % after AI exposure. Shen & Tamkin (Anthropic) 2026 RCT: AI users scored 17 % lower on a comprehension quiz. → R14 |
| L6 Program bureaucracy (Parkinson's law) | Reinforcing | The PO assistant staffs seats → seats generate work packages → more runs                                           | An organisation of agents has no salary constraint, so it tends to grow process. Envelope caps bound money, not ceremony. → R7, R10                                                                                                                |

**Leverage points**, highest first:

- **Goal of the system.** Today there is no single goal. Metrics are a list (`PRODUCTIVITY.md`). A north star tied to _durable verified outcomes_ aligns the PO assistant, the router and the user. → R6
- **Information flows.** Reports and notifications decide whether the Sponsor's mental model stays true. → R2, R4
- **Rules.** The envelope, reserved items and source policies are already strong. Add a velocity rule and a heartbeat rule. → R2, R3
- **Parameters** (weights, caps). These are lowest leverage. Do not spend design time here.

**Autonomy at scale (Cook 1998).** "Complex systems run in degraded mode" and "catastrophe requires multiple failures". The defence-in-depth here is good. The weak layer is **detection**: nothing today notices that _nothing_ is happening. Examples: a daemon that crashed after `run.started`, a queue stuck behind a rate limit, a program `paused` by the PO with no report due because the cadence is `gate`. → R2

### 2.2 Human factors: load, trust, involvement, disclosure

Disciplines: cognitive load theory (Sweller 1988), working-memory limits (Cowan 2001: about 4 chunks), Hick–Hyman law, situation awareness (Endsley 1995), trust calibration (Lee & See 2004), levels of automation (Sheridan & Verplank 1978; Parasuraman, Sheridan & Wickens 2000), cognitive forcing functions (Buçinca et al., CSCW 2021), progressive disclosure (Nielsen).

1. **Concept count is over budget.**
   - Evidence: `kpai` usage (`apps/cli/src/i18n/en.ts`) lists 22 verbs and about 30 flags. The studio has 38 UI components (`apps/studio/src/ui/`).
   - The glossary needed to read a plan has about 25 terms (S9 F-JARG-1). Program mode adds about 12 more (`program/src/schemas.ts`).
   - Cowan's limit means a beginner can hold about 4 new things at once. → Simplicity Charter tiers, R7, R12.
2. **Trust is shown but not calibrated.**
   - The UI shows reason lines, score breakdowns, critic verdicts, bands, evidence counts and dispute options. Explanations _raise_ over-reliance unless they make verification easier (Bansal et al., CHI 2021; Vasconcelos et al., CSCW 2023).
   - The approver needs one calibrated signal: "how strongly has this been checked, and by what?" → R5 (assurance label).
3. **The level of automation is implicit.** Program mode automates acquisition, analysis and action inside worktrees. Decision selection (merge, envelope, reserved items) stays with the human. That is the right split, but nowhere is it a table a user can read. → Simplicity Charter §4, R8.
4. **Approval quality is unobserved.**
   - The journal records the decision and `durationMs` of a tool call (`tools/src/bus.ts` `record`). That duration mixes execution time with human wait.
   - Nothing records whether the human opened the diff or evidence before approving. Rubber-stamping is invisible. → R6 (journal fields), R8.
5. **Situation awareness across long absences (Endsley level 3: projection).** A Sponsor returning after 3 days needs "what changed, what is coming, what do you need from me". `report.ts` sections are state-shaped (progress, evidence, budget, gates, decisions, waiting, risks), not delta-shaped, and carry no forecast. → R4.

### 2.3 Behavioural economics and incentives

Disciplines: default effects (Johnson & Goldstein 2003), zero-price effect (Shampanier, Mazar & Ariely 2007), framing and anchoring (Tversky & Kahneman 1974), Goodhart's law (1975), Campbell's law (1979), Holmström–Milgrom multitask problem (1991).

1. **Defaults are well chosen.** `isolated-only` write policy, `preAnswer: []`, auto-merge opt-in, `KPAI_MEMORY_TOKENS` bounded, $0 local path in onboarding. Keep them. The Simplicity Charter makes them a rule.
2. **Subscriptions and local models look free, so they are overused.** Quotas are counted in runs and hours (`SubscriptionQuotaSchema`). Local compute is "$0". Zero-price items attract disproportionate demand (Shampanier et al.). Unattended overuse of a subscription is exactly what providers have moved against (§2.10).
   - Show a **shadow price**: energy for local, quota share for subscription. → R11, R1.
3. **Cost is shown per run, not per outcome.** Users decide on value, not tokens. `costPerAcceptedChangeUsd` exists (`PRODUCTIVITY.md`) but is a stats-page figure. Bring cost per _durable verified outcome_ to the run and program summary. → R6.
4. **Goodhart exposures, concrete:**
   - `costPerAcceptedChangeUsd` and `timePerAcceptedChangeMs` **reward splitting** one change into many patches. The PO assistant, an optimiser that plans work packages, will find this if it ever sees these numbers (Campbell's law).
   - `reworkRate` **punishes deliberate iteration** (acknowledged in `PRODUCTIVITY.md`, "over-counts rework").
   - Critic approval is a grade signal (w = 1). A lenient critic provider **inflates** its authors' competence. ADR-0028 halves the same-provider critic, but a lenient _cross_-provider critic is not detected. → R9.
   - The `testsPassed` signal is hardened (P4-F10), but the model still chooses the test command. A test suite that tests nothing passes. → R9 (canaries), and mutation score as a later phase 7 signal (opinion).
   - Fix by design: the north star counts **human-fixed units of intent**, so splitting cannot inflate it. The PO assistant must never be given metrics as an objective. → R6, METRICS doc §4.
5. **Principal–agent (Jensen & Meckling 1976; Holmström 1979).** The PO assistant knows more than the Sponsor about the plan (information asymmetry). Its "effort" (runs) is billed to the Sponsor. Classic remedies are monitoring (journal ✓), bonding (envelope ✓) and **outcome-based evaluation** (missing → R6), plus **independent audit of the plan, not only of the delivery** (missing → R10).

### 2.4 Safety engineering: STPA of the virtual enterprise

Discipline: STPA, System-Theoretic Process Analysis (Leveson, _Engineering a Safer World_, MIT Press 2011; _STPA Handbook_ 2018). Safety is a control problem: hazards come from unsafe control actions (UCAs) and flawed feedback, not only from component failures.

**Losses:**

| #   | Loss                                                    |
| --- | ------------------------------------------------------- |
| L1  | Money lost without value                                |
| L2  | Integrity loss in the user's code or data               |
| L3  | Confidential data disclosed                             |
| L4  | Physical or irreversible harm (devices, infrastructure) |
| L5  | Legal or terms breach (provider account, law)           |
| L6  | Loss of human agency or skill                           |

**System-level hazards:**

| #   | Hazard                                                                    | Leads to |
| --- | ------------------------------------------------------------------------- | -------- |
| H1  | The portfolio spends while making no verified progress                    | L1       |
| H2  | An unverified or wrong change reaches a branch the user relies on         | L2       |
| H3  | Data leaves the machine outside policy (including notifications)          | L3       |
| H4  | An actuating or irreversible step runs without an informed human decision | L4       |
| H5  | The system is used against a third party or breaks provider terms         | L5       |
| H6  | The Sponsor's mental model diverges from the real state                   | L1–L6    |

**Control structure (top controls bottom; feedback flows up):**

```
Sponsor (human) ──charter approval, envelope, answers, kill switch──▶ PO assistant (model)
   ▲  reports, notifications, escalations, Enterprise view                │ proposed actions
   │                                                                     ▼
   │                                           Envelope checker + program machine (code)
   │                                                                     │ allowed runs
   │                                                                     ▼
   │                         Scheduler / daemon ──jobs──▶ Kernel (gates, zones, cap, critic)
   │                                                                     │ calls, tools
   │                                                                     ▼
   └─────────────── journal (hash chain) ◀──────────── Providers · tool bus · worktrees · devices
```

**Unsafe control actions and their gaps:**

| UCA    | Controller → action                                                      | UCA type                    | Hazard | Existing control                                                    | Gap → recommendation                                                                                                             |
| ------ | ------------------------------------------------------------------------ | --------------------------- | ------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| UCA-1  | Sponsor approves a charter they do not understand                        | Provided, unsafe            | H1, H6 | Approval bound to the charter hash (`machine.ts approve`)           | No comprehension aid and no independent critique of the plan → **R10**                                                           |
| UCA-2  | Sponsor does not pause or kill when needed                               | Not provided                | H1–H4  | Kill switch (`PortfolioSchema.killSwitch`), pause from anywhere     | The Sponsor is never told the system is stuck or silent → **R2**                                                                 |
| UCA-3  | PO assistant keeps starting runs that do not advance the goal            | Provided too long           | H1     | Envelope caps per run, phase, department and total                  | No progress or velocity check → **R3**                                                                                           |
| UCA-4  | Auto-merge with weak evidence                                            | Provided, unsafe            | H2     | Tests, critic, CI for the commit, zones, size limits (`checkMerge`) | Critic recall and test strength unmeasured → **R9**; label the evidence → **R5**                                                 |
| UCA-5  | Sponsor approves an escalation remotely without looking                  | Provided, unsafe            | H2, H4 | Phase 6 design: passkeys, single-decision links (D-026)             | Nothing measures or forces inspection proportional to risk → **R8**                                                              |
| UCA-6  | Approval arrives too late, and the run times out or the envelope expires | Wrong timing                | H1     | Silence means no (safe)                                             | Blocked work is not reported as "waiting on you since…" with cost of delay → **R4**                                              |
| UCA-7  | Scheduler drives a subscription agent unattended                         | Provided, unsafe            | H5     | Quotas, source policy                                               | Provider terms can forbid it → **R1**                                                                                            |
| UCA-8  | Notifications carry project content to third-party chat services         | Provided, unsafe            | H3     | `redactLine` drops code and secrets; local-only lines dropped       | Goal text, decisions and risk lines still leave, to services such as Slack, Discord and Telegram → **R4** (content-free default) |
| UCA-9  | Physical-effect step runs in a program                                   | Provided, unsafe            | H4     | `confirm.physical` always escalates (`envelope.ts`)                 | Good. Add: physical and offensive packs never run in unattended mode → **R13**                                                   |
| UCA-10 | Report says "running, phase 2/4" while the daemon is dead                | Feedback flaw (stale model) | H6     | Reports built from state, not from model text                       | A report is produced only by a live daemon; absence is not detected → **R2**                                                     |

**Process-model flaws (the controller believes something false):**

- **The PO assistant believes a run "finished" means "done well".** `gate.open` requires every work package to have a finished run (`machine.ts gateOpen`), but `finished` is not `verified`. Make the gate use the assurance level (R5).
- **The Sponsor believes "no news is good news".** This is the most dangerous belief in unattended systems. Fix with R2.

### 2.5 Organisation design: Conway, team topologies, principal–agent

Disciplines: Conway's law (1968), the "inverse Conway manoeuvre", Skelton & Pais, _Team Topologies_ (2019), Galbraith's information-processing view of organisations (1974), agency theory.

1. **Conway's law applies to agents too.** The department taxonomy (`DepartmentKindSchema`: product, design, engineering, data, security, qa, documentation, operations, review, domain) will shape the architecture of what is built.
   - Hand-offs between departments are lossy context transfers. Each is a run boundary with a fresh context, memory injected within a 2 000-token budget (ADR-0027 §5).
   - A functional org (design → engineering → qa) reproduces the waterfall hand-off losses that real companies spent decades removing (opinion, consistent with DORA's findings on small batches).
2. **Team Topologies suggests a better default:**
   - **stream-aligned** teams own an outcome end to end: one work package → one small cross-functional seat group;
   - **enabling** teams map to packs, which teach a domain;
   - the **platform** maps to the kernel: gates, zones, routing;
   - the only separate function that must exist is **independent review**, which the charter schema already enforces (`checkOrg`).

   → R7: the default charter is one stream-aligned team (builder, reviewer, pack specialist). Departments are an expert option for large, multi-domain programs.

3. **Galbraith.** More departments mean more coordination information to process: escalation lines, department caps, per-level source policies. Each level adds a place where a budget can block work for reasons the Sponsor cannot see. Use departments only where they carry a _rule_ (a source policy, a cap). Otherwise they are a visual grouping.
4. **Principal–agent chain:** user → PO assistant → seats → providers. Three agency relations, each with information asymmetry.
   - Existing mitigations are strong at the PO → kernel boundary (typed actions, envelope).
   - The weak point is **user ↔ PO assistant at planning time**. The assistant writes the charter that bounds its own work, and the Sponsor approves it. → R10 (independent charter critique from another provider, plus a "single-run baseline" cost so over-staffing is visible).
5. **Anthropomorphism risk.** "Departments", "seats" and "PO" invite users to attribute responsibility to agents. Accountability must stay with named humans (§2.9). Keep role names functional ("builder", "reviewer"). Avoid personas with human names (Simplicity Charter, anti-features).

### 2.6 Platform and ecosystem economics

Disciplines: two-sided markets (Rochet & Tirole 2003), complements and platform governance (Parker, Van Alstyne & Choudary 2016), commons governance (Ostrom 1990), software supply-chain security (SLSA, Sigstore, TUF).

1. **Packs are the complement that makes KP Studio general.** 18 built-ins plus `general` seed the supply side, which is the classic cold-start subsidy. Pack authors today get no signal back: no attribution in outcomes, no usage, no quality feedback. The journal could tell an author "your pack's plans reached durable verified outcomes in N of M runs" (opt-in). That is the reputation currency that resists gaming, unlike downloads or stars. → ECOSYSTEM §3–4.
2. **Pack text is an injection channel.** `reviewCriteria`, `tips`, `glossary` and plan titles are prose that reaches prompts or the UI. Repository packs are already untrusted (ADR-0025 addendum). Packs from a future registry need the same treatment, plus signing and pinning by content hash, exactly as R-501 does for MCP servers. → R15.
3. **Network effects are weak and pollutable.** Shared competence benchmarks (R-804) give a _data network effect_ only if submissions are honest. Without Sybil resistance a provider or a fan can poison them. Design governance before collecting data. → ECOSYSTEM §5.
4. **Provider relations.** A neutral, zero-markup router that explains choices (benchmark W3, §6) is good for providers that win on quality and price. It threatens those that rely on default placement. Neutrality must be _credible_:
   - no paid placement;
   - published routing formula (ADR-0011/0028 already are);
   - exploration so new models get a fair trial (R9).

### 2.7 Information theory and decision science: what a report must contain

Disciplines: value of information (Howard 1966), Shannon's measure of information (a message the receiver already expects carries little information), forecasting calibration (Brier 1950; Tetlock), bottom-line-up-front writing.

1. A report is decision-useful only if it can change one of the Sponsor's few actions:
   - continue;
   - pause or stop;
   - answer an ask;
   - change the envelope or the charter;
   - inspect something.

   Lines that cannot change any of these have near-zero value of information and cost attention.

2. **Content today** (`report.ts buildReport`) has 7 sections, all shown every time. It contains no **delta since the last report**, no **forecast** (cost-at-completion and date with an interval), no **cost of waiting** on open asks, and no **confidence** in its own forecasts.
3. **Proposed minimum content** (order matters: Endsley levels 1 → 3):
   1. **Asks**: what needs you, by when, and the default if you do nothing ("silence = no; WP-3 stays blocked").
   2. **Delta**: what changed since the last report, in outcomes (durable verified outcomes, DVO) and in risk.
   3. **Forecast**: spend at completion and finish date as an 80 % interval, plus the historical hit rate of past forecasts (a calibration score, so the PO assistant's forecasts become accountable).
   4. **Top risk**: one, with evidence.
   5. A link to the rest.

   → R4.

4. **Report by exception.** If nothing changed and nothing is asked, send nothing, except a small **heartbeat** that proves liveness (R2). Fewer messages raise the signal value of each one.

### 2.8 Accessibility and inclusive design

Disciplines: WCAG 2.2, plain-language standards (ISO 24495-1:2023), inclusive design (Microsoft Inclusive Design toolkit: "solve for one, extend to many").

1. **Good base.** Phase 3 reports 0 axe violations on 12 screens in both themes. State badges carry icon plus word (`StateBadge.tsx`). French-first i18n (D-020).
2. **The Enterprise view is a visual graph by nature.** It needs an equivalent outline or table view, navigable by keyboard and screen reader (WCAG 1.3.1, 2.1.1). Live changes go through a polite `aria-live` summary, not per-node chatter (A-012). → R12.
3. **Notifications and emails** must be plain text first, under 60 words, with the ask in the first sentence. They must not rely on emoji or colour. This also suits screen-reader users on phones.
4. **Remote approvals (phase 6).** Passkeys satisfy WCAG 2.2 SC 3.3.8 (accessible authentication). Avoid CAPTCHAs and timed approvals. "Silence = no" is already accessible because there is no penalty for slowness.
5. **Economic inclusion.** The $0 path needs a capable local machine. Users without a GPU need a visible **cheapest-cloud** path with a hard cap (for example "economy, at most $0.50 per task") (opinion). Students and the Global South are where the `learning` pack lives.
6. **Cognitive accessibility.** The beginner tier (Simplicity Charter) is also the cognitive-accessibility tier: 7 words, one action per screen, undo everywhere.

### 2.9 Ethics and philosophy of technology

Disciplines: meaningful human control (Santoni de Sio & van den Hoven, _Frontiers in Robotics and AI_ 2018: _tracking_ and _tracing_ conditions), the responsibility gap (Matthias 2004), value-sensitive design (Friedman & Hendry 2019), Bainbridge (1983), environmental ethics of computing (Strubell et al. 2019; Luccioni et al. 2024), EU AI Act (Art. 4 AI literacy, Art. 50 transparency).

1. **Tracing.** Every outcome can be traced to a human who authorised it: charter hash, envelope, escalation answers, merges. The hash-chained journal satisfies this better than any competitor (benchmark §2). Keep it unconditional.
2. **Tracking.** The system must respond to the _reasons and values_ of the human, not just their approvals. Today the charter carries `goal` and `outOfScope`, but values ("never collect personal data", "accessibility first", "prefer reversible changes") have no field. They do not reach critics as review criteria. → R10: charter values become cross-provider review criteria, the same mechanism packs use (`reviewCriteria`).
3. **Responsibility gap.** In unattended mode, harm can occur with no human decision at that moment. Mitigation: every unattended action is inside an envelope a named human approved, with a bounded expiry (`envelope.expires`). **Make expiry mandatory for unattended portfolios** (proposed default 14 days, renewable in one click). → R3.
4. **Human agency and deskilling.** See L5 in §2.1 and RISKS §4. Offer a **learn mode** (explain before apply, "you write the test first") as a pack-level default for the `learning` profile. Never use engagement-maximising design. → R14.
5. **Environmental cost.**
   - Multi-model review costs about 4× tokens (benchmark §8).
   - Google reports a _median_ Gemini text prompt at about 0.24 Wh (Aug 2025). Agentic runs with long contexts and reasoning are plausibly 10–1000× that per run [U: no primary measurement for agentic workloads].
   - The product shows dollars before running but no energy. → R11: show an energy estimate band next to cost (descriptor coefficients with source and uncertainty), and prefer lower-energy routes in economy mode.
6. **Dual use.** The `security-offensive` and `reverse-engineering` packs, plus unattended portfolios, form a capability a bad actor could point at third parties. Authorised scope exists (A-004), but it is self-declared. → R13: offensive or physical packs never run unattended, scopes in Program mode are re-attested by the Sponsor with re-authentication, and an acceptable-use policy (Sponsor decision).

### 2.10 Provider terms (cross-cutting)

Third-party harnesses and subscription authentication: secondary reports say Anthropic's consumer terms were clarified in February 2026 to bar subscription OAuth tokens in third-party tools, with enforcement from April 2026; extra usage or API keys are the remaining path [U: secondary sources (winbuzzer, gigazine, letsdatascience); check the current Anthropic terms before relying on it].

D-026 and `SourceKindSchema` include `subscription` sources that the daemon schedules (`scheduler.ts` candidates). R-503 runs agent CLIs "under the user's own account", which may be fine interactively. An unattended daemon driving them at portfolio scale is the pattern providers have moved against. The risk falls on users (account suspension), not on KP. → R1, and Sponsor decision SD-1 (reserved: third-party terms, charter §5).

### 2.11 Performance and robustness at scale

Disciplines: queueing theory (Little's law; Kingman), resilience patterns (circuit breakers, exponential backoff with jitter: Nygard, _Release It!_ 2007/2018).

1. **The journal is the system of record and grows linearly with a portfolio.**
   - Several readers scan windows of recent events: `productivity` reads the last 100 000 (`PRODUCTIVITY.md`); `CompetenceStore` is rebuilt in about 60 ms per 12 000 events (ADR-0028 §4); merge looks up runs across 500 sessions (B-23); `readRun` scans sessions (ADR-0029).
   - At 24/7 portfolio scale these are O(n) per plan. Truncation windows will silently drop evidence, a silent-failure mode of its own.
   - → R16: hash-chained **rollup checkpoints** (periodic signed summaries), a run index (B-23), and per-program partitions.
2. **Fallback storms.** When a provider throttles, every job falls back at once, typically to a more expensive provider. Caps hold the money (D-021), but throughput collapses and the scheduler's per-provider limits fill.
   - Add per-provider **circuit breakers** with half-open probes, and backoff with jitter (`scheduler.ts` skips rate-limited providers but has no breaker state [U: from reading the header only]).
3. **Little's law for humans.** Queue length = arrival rate × wait. If asks arrive faster than the Sponsor answers, blocked work grows without bound. Show the **ask queue** and its age (R4). Throttle new program starts when the ask queue exceeds a threshold (R3).

---

## 3. Recommendations

Format for each item: problem · evidence · proposal · cost · risk · who benefits · success metric · phase · **remove or hide in exchange**.

### R1. Unattended mode uses only API and local sources; subscription agents are interactive and opt-in

- **Problem.** The daemon may schedule `subscription` sources (`SourceKindSchema`, `scheduler.ts`). Provider terms may forbid this, and the user bears the ban.
- **Evidence.** §2.10 [U]; benchmark annex A line 381 flagged this as "not researched".
- **Proposal.**
  - The scheduler refuses `subscription` candidates for jobs started without an attached interactive client, unless the Sponsor has recorded that the provider's current terms allow it. That record is the reserved item `third-party-terms`, already in `RESERVED_ITEMS`.
  - Interactive R-503 use stays allowed, with a one-line notice naming the provider's terms.
  - Descriptors gain `terms.unattended: allowed | forbidden | unknown`; the default is `unknown`, which is treated as forbidden.
- **Cost.** XS–S (S4 scheduler, S2 descriptors).
- **Risk.** Some users lose a cheap path. Mitigation: show the API cost delta.
- **Who benefits.** Users (accounts safe), providers (terms respected), KP (reputation).
- **Success metric.** 0 unattended subscription runs without a recorded terms decision (journal query).
- **Phase.** 5.
- **Remove or hide.** Hide subscription sources in the beginner and regular tiers. Remove `subscription` from default charter templates.

### R2. Heartbeat, dead-man's switch and silent-failure watchdog

- **Problem.** No component notices the _absence_ of progress or reports (UCA-2, UCA-10).
- **Evidence.**
  - STPA missing-feedback flaw (Leveson 2011).
  - The cadence can be `gate` only (`CadenceSchema`), so a stuck phase can stay silent for days.
  - Industry practice: dead-man's-switch monitoring (for example cron "healthchecks" services).
- **Proposal.**
  1. The daemon journals a `heartbeat` every N minutes and sends a tiny liveness ping on the configured channel. Proposed default: daily, plus whenever a watchdog fires.
  2. Watchdog invariants:
     - no state change in a live program for more than X hours;
     - a run `running` past its stall timeout;
     - an ask older than 24 h;
     - a queue blocked by rate limits for more than 1 h;
     - a report overdue.

     Each one fires an _exception report_ (R4).

  3. Optional external dead-man: the user points a free monitoring endpoint at the heartbeat, so a dead machine is noticed by someone else (opinion: best simple defence for a home server).
- **Cost.** S (S4 or S8 daemon, S6 display).
- **Risk.** Alert fatigue if thresholds are tight. Mitigation: defaults tuned by G3 (METRICS).
- **Who benefits.** Sponsor and user (trust), enterprise operators.
- **Success metric.** Silent-failure rate G3 (METRICS): share of stalled programs detected within 1 h ≥ 95 % in fault-injection tests (S8 can script crashes).
- **Phase.** 5 (with the daemon).
- **Remove or hide.** Remove periodic "all is well" digests (`every: hours`) as a default. The heartbeat replaces them.

### R3. Spend-velocity cap and progress-gated burn

- **Problem.** Caps bound the amount. A looping or unproductive portfolio can still burn the whole envelope overnight (UCA-3, H1).
- **Evidence.** Loop L2 (delay plus hard limit gives overshoot). `envelope.ts` checks totals only. Industry: rate limits as a second control on cloud spend.
- **Proposal.**
  - Add `velocity: { usdPerHour, usdPerDay }` at portfolio and program level.
  - Add **progress gating**: after each 25 % of a phase cap, the program must show at least one new verified outcome (assurance ≥ V1, R5) or it auto-pauses with an exception report ("25 % spent, no verified result yet: continue / change plan / stop").
  - Make `envelope.expires` mandatory for unattended portfolios. Default 14 days, renewable in one click.
- **Cost.** S (program package: pure functions; S3 for defaults).
- **Risk.** False pauses on research-heavy phases. Mitigation: the Sponsor sets the checkpoint fraction per phase; pause is cheap and resumable.
- **Who benefits.** User wallet, providers (no runaway bills that end in churn), society (less wasted compute).
- **Success metric.** Spend per DVO (G1) does not regress, and the fault-injection "loop" scenario is halted at ≤ 25 % of the phase cap.
- **Phase.** 5.
- **Remove or hide.** Hide per-department caps (`DepartmentSchema.capUsd`) in the regular tier. Velocity plus phase caps cover the need for most users.

### R4. Report by exception; decision-useful format; content-free notifications by default

- **Problem.** Reports are state dumps with 7 sections, carry no delta or forecast, and send project text to third-party chat services.
- **Evidence.** §2.7, UCA-6, UCA-8; `report.ts`, `notify.ts outboundLines`.
- **Proposal.**
  - (a) Report schema v2: **Asks** (with deadline, default-if-silent and cost of delay) → **Delta** (DVO, risks) → **Forecast** (spend at completion and date, 80 % interval, plus the forecast hit rate so far) → **Top risk** → link.
  - (b) **Send only when** there is an ask, a delta of note, a watchdog event or a gate; otherwise only the heartbeat (R2).
  - (c) **Outbound default is content-free**: "Program `p-7`: 2 decisions waiting, 34 % of budget used, no incident. Open KP Studio." Richer content (decisions, risks) is opt-in per channel. Email to self is lower risk than a team chat.
  - (d) Plain text first, under 60 words, ask in the first sentence (accessibility, §2.8).
- **Cost.** S (S6 or S8 in `program/report*`, `notify.ts`).
- **Risk.** Sponsors who like detail feel under-informed. Mitigation: the full report stays one click away, locally.
- **Who benefits.** Sponsor (attention), privacy (less egress), teams (less noise).
- **Success metric.**
  - Median notifications per program-week ≤ 3, with asks answered faster (G2).
  - 0 project text in outbound payloads at the default setting (test).
  - Forecast 80 % intervals contain the outcome 70–90 % of the time.
- **Phase.** 5.
- **Remove or hide.** Remove "decisions" and "risks" sections from outbound defaults. Hide the 7-section layout behind "full report".

### R5. One assurance label per outcome (V0–V3)

- **Problem.** About ten trust signals (reason, score, critic verdicts, evidence phrase, disputes, band, tests, CI, review policy) and no single answer to "how well was this checked?".
- **Evidence.** §2.2 (Bansal 2021; Lee & See 2004); SO 2026 "48 % trust AI when easy to verify" (benchmark W2).
- **Proposal.** A derived, journal-computed label on every deliverable, run, report line and approval card:

  | Label  | Meaning                                                                                                                             |
  | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
  | **V0** | Unchecked                                                                                                                           |
  | **V1** | Reviewed by a model from another provider, no open major issue                                                                      |
  | **V2** | V1, plus objective evidence (tests that ran per the P4-F10 rules, CI on the exact commit, or a validator for non-code deliverables) |
  | **V3** | V2, plus a human inspected the evidence before accepting (requires the `viewed` journal field, R6)                                  |

  Gates, auto-merge and DVO use the label (gate ≥ V2 for code by default). The word "verified" in the UI and reports means ≥ V2 and nothing else.

- **Cost.** S (S3 derives it from existing signals; S6 shows it).
- **Risk.** A label can be over-trusted. Mitigation: always show _what_ earned it ("V2: critic + 14 tests").
- **Who benefits.** Every user, reviewers, auditors (ISO 42001), Program-mode gates.
- **Success metric.** In usability tests, users answer "how was this checked?" correctly ≥ 90 % (Sponsor-reserved human check). Rubber-stamp rate (G2) falls on V0/V1 items.
- **Phase.** 5 (label); V3 needs R6 fields.
- **Remove or hide.** Hide score breakdowns, runner-up models and raw verdict lists behind the expert tier. They stay one click away (R-303 remains satisfied).

### R6. Adopt the north star "Durable Verified Outcomes", plus four journal fields

- **Problem.** There is no single goal. Current metrics invite splitting (Goodhart, §2.3.4) and cannot observe approval quality or reverts.
- **Evidence.** `PRODUCTIVITY.md` ("What these numbers do not say"); §2.3.
- **Proposal.** See METRICS-NORTH-STAR.md. Journal additions:
  - **J1** `intent` on `run started`: an id and origin (`human-request`, `charter-wp:<hash>`).
  - **J2** `asked` and `answered` timestamps on every confirmation, and `viewed: [diff|evidence|none]` from the client.
  - **J3** pre- and post-image file hashes on each kernel write, so a later write restoring the pre-image is a _revert_, not "touched again".
  - **J4** `energyWh` estimate on `response` events (R11).
- **Cost.** M (S1 kernel and journal fields, S8 metrics, S6 client `viewed`).
- **Risk.** Journal size grows; privacy of `viewed` (it is local only).
- **Who benefits.** Everyone. The PO, because it gives phase gates an outcome metric.
- **Success metric.** DVO and guardrails computed in `kpai stats` with documented formulas. The rework false-positive rate drops (J3).
- **Phase.** Fields in 5. They must not disturb the phase 4 gate; a backlog line now.
- **Remove or hide.** Demote `costPerAcceptedChangeUsd` and `timePerAcceptedChangeMs` to expert stats. They reward splitting.

### R7. One-team default charter; departments become an expert view

- **Problem.** Ten department kinds, six seat kinds, escalation lines and four policy levels are heavy for individuals. A functional org reproduces hand-off losses (Conway).
- **Evidence.** §2.5; `schemas.ts` `DepartmentKindSchema`, `checkOrg`.
- **Proposal.**
  - The PO assistant drafts the **smallest charter that fits**: one stream-aligned team (builder, plus a pack specialist if a pack applies) and the mandatory independent reviewer.
  - Departments appear only when a rule needs them (a different source policy, a separate cap) or the Sponsor asks.
  - The Enterprise view renders the same data as an org chart for those who want it.
  - Charter validation stays as is: reviewer independence is the one structural rule.
- **Cost.** S (design now; prompt and template work in the PO assistant).
- **Risk.** Less "wow" in demos. Mitigation: the Enterprise view still exists, and big programs still get departments.
- **Who benefits.** Beginners, small teams; lower cost (fewer hand-offs, smaller contexts).
- **Success metric.**
  - Median seats per charter ≤ 4 for single-domain goals.
  - Charter approval time falls.
  - DVO per dollar ≥ the departmental baseline in a small A/B on fixtures.
- **Phase.** 5 design (S1 doc).
- **Remove or hide.** Hide department kinds, escalation lines and per-seat source policies in the beginner and regular tiers.

### R8. Risk-proportional approvals; measure rubber-stamping

- **Problem.** Every confirmation looks alike. Approvals degrade under load (automation bias), worst on phones (phase 6).
- **Evidence.** Parasuraman & Riley 1997; Bainbridge 1983. Buçinca et al. 2021: cognitive forcing functions reduce over-reliance. P3-F1 showed a single approval silently covering two diffs.
- **Proposal.**
  - **Low risk** (in-worktree writes, V2, inside the envelope) are already pre-answerable. Batch them into one digest approval.
  - **Consequential** items (merge to a user branch, envelope widening, physical, destructive, V0/V1 merges): the Approve control becomes active only after the evidence panel was opened (journaled as `viewed`, J2). The card leads with the _strongest dissent_ (the critic's top issue) and the assurance label.
  - **Remote phone approvals** (phase 6) are limited to consequential-but-reversible items. Irreversible items need the desktop.
  - **Metric G2**: share of consequential approvals with `viewed = none` or decision time < 3 s.
- **Cost.** M (S6 UI, S1 protocol field, S7 phase 6 rules).
- **Risk.** Friction annoys experts. Mitigation: friction applies only to consequential items; experts can expand evidence by default.
- **Who benefits.** Users (fewer bad merges), accountability (tracking condition, §2.9).
- **Success metric.** G2 rubber-stamp rate < 10 %; rollback rate of approved consequential items does not rise.
- **Phase.** 5 (local), 6 (remote).
- **Remove or hide.** Remove per-item prompts for low-risk batched writes. Remove "approve all" for consequential items. Never add one.

### R9. Calibrate the verifiers: critic canaries and an exploration share

- **Problem.** Verification is the product (W2), but critic recall is unmeasured. Learning starves untried models (L1, L3).
- **Evidence.**
  - ADR-0028 has no exploration term. Critic approval feeds grades (w = 1).
  - Mutation testing as a test-adequacy method (DeMillo, Lipton & Sayward 1978).
  - Bandit exploration (Thompson 1933; Russo et al. 2018 tutorial).
- **Proposal.**
  - (a) **Canaries.** With small probability (for example 2 % of critic calls, capped per day, opt-in in the expert tier, on by default in Program mode), give a critic a known-defective variant of a real diff (a deterministic mutation: flipped condition, removed check). Record whether it is caught. Critic **recall per provider** weights its grade signal and is shown in routing evidence. Canary output is never applied (it runs in replay mode, ADR-0029).
  - (b) **Exploration.** Reserve at most 5 % of eligible low-criticality nodes for the best untried candidate within budget, labelled "exploring" in the reason line (Thompson sampling on the blended score).
- **Cost.** M (S3, S4).
- **Risk.**
  - Canaries cost tokens (small and capped).
  - Exploration may pick a worse model on low-stakes nodes. It is labelled, bounded and never on critical nodes.
- **Who benefits.** Users (real assurance), providers (fair trials of new models), the community benchmark (better data).
- **Success metric.**
  - Critic recall measured for every provider used more than 50 times.
  - The routing-change rate after learning (REQUIREMENTS proof point 5) is non-zero for new models.
- **Phase.** 5 (canaries in review policy), 6 (exploration after live data, Q-2).
- **Remove or hide.** Remove the manual `kpai bench` from the beginner path. Continuous canaries and grades replace most of its purpose. Keep it in the expert tier.

### R10. Independent charter critique, a single-run baseline, and values as review criteria

- **Problem.** The PO assistant writes the charter that bounds it (agency). Values have no field (tracking condition).
- **Evidence.** §2.3.5, §2.5.4, §2.9.2, UCA-1.
- **Proposal.** Before the Sponsor sees a charter:
  - (a) a critic from another provider reviews it for scope creep, missing risks and over-staffing;
  - (b) the charter shows the **single-run baseline**, the estimated band to attempt the goal as one ordinary `kpai do`, next to the program's total cap;
  - (c) a `values` list (plain sentences) is added to the charter and passed to every critic as review criteria, like pack `reviewCriteria`;
  - (d) the charter has a one-screen summary in beginner language.
- **Cost.** S–M (program package and PO prompts).
- **Risk.** The baseline estimate may be poor for big goals. Label it "rough".
- **Who benefits.** Sponsor (informed consent), wallet, society (value alignment made explicit).
- **Success metric.** Share of charters amended after critique; program cost ÷ baseline tracked over time (should fall).
- **Phase.** 5.
- **Remove or hide.** Hide the full charter YAML (`CharterSchema` detail) behind "details". The Sponsor approves the summary bound to the same hash.

### R11. Energy and carbon as a shown cost dimension

- **Problem.** Compute has an environmental cost that is invisible today. "Free" local and subscription runs encourage overuse (§2.3.2).
- **Evidence.** Google, Aug 2025: median text prompt about 0.24 Wh, 0.03 gCO₂e (market-based). Luccioni et al., FAccT 2024 (_Power Hungry Processing_): order-of-magnitude differences across task types. No measurement exists for agentic workloads [U].
- **Proposal.**
  - Descriptor fields `energy: { whPer1kTokens: [low, high], source, date }`, default _unknown_.
  - Local models are estimated from runtime × a declared device power.
  - Show "≈ 3–20 Wh" next to the cost band at the regular tier; per-DVO energy in stats (G6).
  - Economy profile weights energy.
  - Never claim precision. Always show a range and the source.
- **Cost.** M (S2 descriptors, S3 weighting, S6 display).
- **Risk.** Bad coefficients mislead. Mitigation: ranges, sources, "unknown" shown as such.
- **Who benefits.** Society, EU-regulated buyers (CSRD reporting), users who care.
- **Success metric.** At least 80 % of calls carry an energy range; the economy profile reduces Wh per DVO in fixtures.
- **Phase.** 5 (fields, display); 6 (weighting).
- **Remove or hide.** Do not add a separate "green mode". Fold energy into the existing economy profile (one fewer setting).

### R12. Accessible Enterprise view and notifications

- **Problem.** The visual org chart and graph exclude screen-reader and keyboard users. Notifications rely on chat formatting.
- **Evidence.** §2.8; WCAG 2.2 1.3.1, 2.1.1, 4.1.3.
- **Proposal.**
  - The Enterprise view ships with an outline or table twin (the default for screen readers) and a polite live summary.
  - Notifications are plain text, under 60 words, ask first.
  - The axe-in-CI scope is extended to the new views.
- **Cost.** S (S6).
- **Risk.** Low.
- **Who benefits.** Disabled users, phone users, everyone (inclusive design).
- **Success metric.** 0 axe serious issues on Enterprise views; keyboard-only e2e for the "answer an ask" flow.
- **Phase.** 5.
- **Remove or hide.** No animation or motion in the Enterprise view by default (respect `prefers-reduced-motion`; less to build).

### R13. Unattended-mode allow-list and misuse controls

- **Problem.** Offensive or physical packs, run unattended at portfolio scale, enable harm (H4, H5).
- **Evidence.** §2.9.6; packs `security-offensive.yaml`, `reverse-engineering.yaml`, `smart-home.yaml`, `embedded-iot.yaml`.
- **Proposal.**
  - Packs with `requiresScope` or `physicalEffects` are **interactive-only**: they cannot be staffed in an unattended portfolio.
  - In Program mode a scope is re-attested by the Sponsor with strong re-authentication (phase 6 passkeys) and journaled.
  - Publish an acceptable-use policy (Sponsor). Refuse charters whose goal names an unauthorised third-party target: a cross-provider critic check on the charter (R10) with a fixed rubric.
- **Cost.** S.
- **Risk.** Legitimate red teams want automation. They can still run interactive programs.
- **Who benefits.** Third parties, society, KP's reputation, providers (usage policies).
- **Success metric.** 0 unattended runs with a scope-requiring or physical pack (journal query); red-team fixtures refused.
- **Phase.** 5 (rule), 6 (re-auth).
- **Remove or hide.** Hide offensive packs from pack suggestions unless the user opts into "security work" once.

### R14. Learn mode and skill-preserving defaults

- **Problem.** Shifting the burden (L5): deskilling evidence in medicine and coding.
- **Evidence.** Budzyń et al. 2025; Shen & Tamkin (Anthropic) 2026: AI users scored 17 % lower in a 52-person RCT, and conceptual-question users fared better [U on per-pattern figures].
- **Proposal.**
  - A `learn` toggle, default on in the `learning` pack and offered to beginners:
    - the plan explains each step in plain words;
    - the user is asked to predict or write one part (for example the test) before the model does;
    - patches come with a 3-line "why".
  - A monthly "you drive" suggestion in the regular tier.
  - No streaks, badges or engagement loops.
- **Cost.** M (S6, S4 prompts, S9 pack defaults).
- **Risk.** Slower output for those who opt in, which is the point.
- **Who benefits.** Students, juniors, long-term competence of teams, society.
- **Success metric.** Opt-in rate; self-reported understanding (human study, Sponsor-reserved); V3 share among learn-mode users.
- **Phase.** 7 (with conception), pilot in the `learning` pack in 5.
- **Remove or hide.** Nothing added to other tiers. Learn mode lives in the pack, not in global settings.

### R15. Pack trust ladder, signing and pinning

- **Problem.** Packs will travel. Their prose reaches prompts and UIs, and their zones affect safety.
- **Evidence.** ADR-0025 addendum (repository packs untrusted); R-501 pinning for MCP; supply-chain incidents (benchmark §7).
- **Proposal.** Ladder:

  | Level        | Meaning                                                                       |
  | ------------ | ----------------------------------------------------------------------------- |
  | **local**    | Unsigned; your own machine only                                               |
  | **signed**   | Sigstore keyless, author identity in the transparency log                     |
  | **reviewed** | Passed automated checks: validator, injection lint, no model ids, zone sanity |
  | **curated**  | Built-in or maintainer-reviewed                                               |

  Every pack is pinned by content hash in the journal per run. A changed pack is re-approved, as R-501 does for MCP. Pack prose is always quoted as untrusted in prompts. See ECOSYSTEM §4.

- **Cost.** M (S9, S7).
- **Risk.** Ceremony for casual authors. Mitigation: local packs stay frictionless.
- **Who benefits.** Pack authors (credible reputation), users (safety), enterprises (allow-lists).
- **Success metric.** 100 % of runs journal pack id, version and hash; 0 unsigned registry packs installable.
- **Phase.** 6 (signing, pinning), 8 (registry).
- **Remove or hide.** No stars or download counts in the UI. Reputation is outcome-based (ECOSYSTEM §4).

### R16. Scale hygiene: journal rollups, run index, circuit breakers

- **Problem.** O(n) journal scans and truncation windows; fallback storms (§2.11).
- **Evidence.** B-23; ADR-0028 §4; ADR-0029 consequences; `PRODUCTIVITY.md` 100 000-event window.
- **Proposal.**
  - Signed periodic rollups that chain to the journal (the competence, productivity and spend aggregates of a closed window).
  - A run-id index.
  - Per-program journal partitions under the same chain root.
  - Provider circuit breakers with half-open probes and jittered backoff in the scheduler.
  - A warning when a metric's window truncates evidence.
- **Cost.** M (S1, S4, S8).
- **Risk.** Rollups must stay verifiable. Include the window hash range.
- **Who benefits.** Heavy users, enterprises, phase 8.
- **Success metric.** Plan-time competence build under 50 ms at 1 M events; no silent truncation (warning test).
- **Phase.** 5 (index, breakers), 6 (rollups).
- **Remove or hide.** Remove `limit` knobs from user-facing stats commands. The system manages windows.

### R17. Consolidate the CLI and the vocabulary

- **Problem.** 22 verbs with overlapping paths (phase-1 `run`/`route`/`ask` next to `do`/`plan`).
- **Evidence.** `apps/cli/src/i18n/en.ts` usage; S9 F-JARG-1.
- **Proposal.**
  - The beginner surface is four verbs: `kpai do`, `kpai undo`, `kpai status`, `kpai stop`.
  - `plan` = `do --dry-run`.
  - `run`/`route` fold into `do` (single-node plans are `do` with one node).
  - `ask -m` becomes `do -m … --solo`.
  - Expert verbs move under `kpai x <verb>`.
  - A deprecation period with aliases.
- **Cost.** M (S1, S6, docs).
- **Risk.** Breaks scripts and demos. Mitigation: aliases for one phase.
- **Who benefits.** All new users.
- **Success metric.** First-task time under 3 min (R-308); help-screen length halves.
- **Phase.** 6 (hardening is the right time to change surface).
- **Remove or hide.** This _is_ the removal: about 10 top-level verbs leave the default help.

### Ranking by value / effort

Value: H = 3, M = 2, L = 1, judged on reach × severity of the problem. Effort: XS = 0.5, S = 1, M = 2. The score is a heuristic for ordering, not a measurement (opinion).

| Rank | Rec                                  | Value | Effort | Score | Phase       | Lead seat(s)    |
| ---- | ------------------------------------ | ----- | ------ | ----- | ----------- | --------------- |
| 1    | R1 Subscriptions not unattended      | H     | XS     | 6.0   | 5           | S4, S2, Sponsor |
| 2    | R2 Heartbeat and watchdog            | H     | S      | 3.0   | 5           | S4, S8          |
| 3    | R3 Velocity and progress gating      | H     | S      | 3.0   | 5           | PO, S3          |
| 4    | R4 Report by exception               | H     | S      | 3.0   | 5           | S6, S8          |
| 5    | R5 Assurance label V0–V3             | H     | S      | 3.0   | 5           | S3, S6          |
| 6    | R7 One-team default charter          | H     | S      | 3.0   | 5 design    | S1, PO          |
| 7    | R13 Unattended allow-list and misuse | H     | S      | 3.0   | 5/6         | S7, S9          |
| 8    | R12 Accessible Enterprise view       | M     | S      | 2.0   | 5           | S6              |
| 9    | R10 Charter critique and baseline    | M     | S      | 2.0   | 5           | PO, S4          |
| 10   | R6 North star and journal fields     | H     | M      | 1.5   | 5           | S1, S8          |
| 11   | R8 Risk-proportional approvals       | H     | M      | 1.5   | 5/6         | S6, S7          |
| 12   | R9 Critic canaries and exploration   | H     | M      | 1.5   | 5/6         | S3, S4          |
| 13   | R15 Pack trust ladder                | M     | M      | 1.0   | 6/8         | S9, S7          |
| 14   | R16 Scale hygiene                    | M     | M      | 1.0   | 5/6         | S1, S4          |
| 15   | R17 CLI consolidation                | M     | M      | 1.0   | 6           | S1, S6          |
| 16   | R11 Energy dimension                 | M     | M      | 1.0   | 5/6         | S2, S3          |
| 17   | R14 Learn mode                       | M     | M      | 1.0   | 5 pilot / 7 | S6, S9          |

**Top ten for the PO's attention** (value-weighted, not pure score): R1, R2, R3, R4, R5, R6, R7, R8, R9, R10. R6, R8 and R9 rank lower on score only because they cost more. They are the foundation that gives R5, G2 and verification meaning, so I would schedule them in phase 5 regardless (opinion).

---

## 4. Net simplicity ledger (D-027: every addition names a removal)

| Added to the default experience          | Removed or hidden from the default experience                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| One label (V0–V3)                        | Score breakdowns, runner-up, raw verdicts (expert)                                                                           |
| One heartbeat                            | Periodic digests, 7-section outbound reports                                                                                 |
| "Asks" inbox                             | Per-item low-risk confirmations (batched)                                                                                    |
| Energy range next to cost (regular tier) | A separate green mode (never added)                                                                                          |
| Charter summary and baseline             | Full charter YAML, department kinds, escalation lines, per-seat policies (expert)                                            |
| —                                        | About 10 CLI verbs, `limit` knobs, subscription sources, offensive packs in suggestions, `kpai bench` from the beginner path |

The net change in beginner-visible concepts is about −15 by my count (opinion; S9 can recount with the glossary).

---

## 5. Decisions the Sponsor must take

The Sponsor reserves these under charter §5 or they change the product's direction. Each has a recommended default.

| #    | Decision                                                                                                         | Recommendation                                                                                                                                              | Why reserved                   |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| SD-1 | May unattended programs use subscription agents, and under which providers' terms?                               | No by default (R1). Allow per provider only after the Sponsor has read and recorded its current terms                                                       | Third-party terms              |
| SD-2 | Publish an acceptable-use policy (offensive security, surveillance, weapons, harassment)?                        | Yes, before any public release; also binds community packs                                                                                                  | Legal, publishing              |
| SD-3 | Licence of the pack format and built-in packs (part of Q-1)                                                      | Open the pack schema and built-ins (Apache-2.0 or CC-BY-4.0) even if the core stays proprietary: ecosystems need an open complement                         | Licence                        |
| SD-4 | Pricing (Q-6)                                                                                                    | Confirm zero markup, a seat licence, free viewer and reviewer seats, free for individual non-commercial and education; no take rate on free community packs | Money, go-to-market            |
| SD-5 | Cloud runner (Q-7)                                                                                               | Keep "no" until phase 8. Self-hosted daemon only; R2 makes home servers safe enough                                                                         | Hosting, data obligations      |
| SD-6 | Adopt DVO as north star and a "no time-saved claims" public rule                                                 | Yes. It is the honest position the benchmark recommends (W12)                                                                                               | Public claims                  |
| SD-7 | Show energy estimates with ranges?                                                                               | Yes, labelled estimates with sources                                                                                                                        | Public claims, reputation      |
| SD-8 | Community benchmark (R-804): data controller, consent, retention                                                 | Design now, collect nothing before phase 8; aggregated counts only (ECOSYSTEM §5)                                                                           | Legal (GDPR), external service |
| SD-9 | Human-only checks to fund: usability test of the beginner tier, screen-reader sessions, a small deskilling study | Fund one round of each before v1.0                                                                                                                          | Human-only checks              |

## 6. Sources

**Safety and systems**

- N. Leveson, _Engineering a Safer World_, MIT Press, 2011; N. Leveson & J. Thomas, _STPA Handbook_, 2018.
- D. Meadows, "Leverage Points: Places to Intervene in a System", 1999.
- R. Cook, "How Complex Systems Fail", 1998.
- C. Perrow, _Normal Accidents_, 1984.
- J. Sterman, _Business Dynamics_, 2000.
- M. Nygard, _Release It!_, 2nd ed., 2018.

**Human factors and automation**

- L. Bainbridge, "Ironies of Automation", _Automatica_ 19(6), 1983.
- R. Parasuraman & V. Riley, "Humans and Automation: Use, Misuse, Disuse, Abuse", _Human Factors_ 39(2), 1997.
- R. Parasuraman, T. Sheridan & C. Wickens, "A model for types and levels of human interaction with automation", _IEEE SMC-A_ 30(3), 2000.
- J. Lee & K. See, "Trust in Automation", _Human Factors_ 46(1), 2004.
- M. Endsley, "Toward a Theory of Situation Awareness", _Human Factors_ 37(1), 1995.
- Z. Buçinca, M. Malaya & K. Gajos, "To Trust or to Think", CSCW 2021.
- G. Bansal et al., "Does the Whole Exceed its Parts?", CHI 2021.
- H. Vasconcelos et al., "Explanations Can Reduce Overreliance on AI Systems During Decision-Making", CSCW 2023.
- N. Cowan, "The magical number 4", _BBS_ 24, 2001.
- J. Sweller, "Cognitive load during problem solving", _Cognitive Science_ 12, 1988.
- M. Sendelbach & M. Funk, "Alarm fatigue", _AACN Adv Crit Care_ 24(4), 2013.

**Economics and organisation**

- E. Johnson & D. Goldstein, "Do Defaults Save Lives?", _Science_ 302, 2003.
- K. Shampanier, N. Mazar & D. Ariely, "Zero as a Special Price", _Marketing Science_ 26(6), 2007.
- M. Jensen & W. Meckling, "Theory of the Firm", 1976.
- B. Holmström & P. Milgrom, "Multitask Principal–Agent Analyses", _JLEO_ 1991.
- D. Campbell, "Assessing the impact of planned social change", 1979.
- M. Conway, "How Do Committees Invent?", _Datamation_, 1968.
- M. Skelton & M. Pais, _Team Topologies_, 2019.
- J. Galbraith, "Organization Design: An Information Processing View", _Interfaces_ 4(3), 1974.
- J.-C. Rochet & J. Tirole, "Platform Competition in Two-Sided Markets", _JEEA_ 2003.
- E. Ostrom, _Governing the Commons_, 1990.

**Decision science**

- R. Howard, "Information Value Theory", _IEEE SSC_ 1966.
- G. Brier, "Verification of forecasts expressed in terms of probability", 1950.

**Ethics and environment**

- F. Santoni de Sio & J. van den Hoven, "Meaningful Human Control over Autonomous Systems", _Frontiers in Robotics and AI_, 2018.
- A. Matthias, "The responsibility gap", _Ethics and Information Technology_ 6, 2004.
- B. Friedman & D. Hendry, _Value Sensitive Design_, 2019.
- E. Strubell et al., ACL 2019.
- A. S. Luccioni, Y. Jernite & E. Strubell, "Power Hungry Processing", FAccT 2024.
- Google, "Measuring the environmental impact of AI inference" (Aug 2025), as reported by [MIT Technology Review](https://www.technologyreview.com/2025/08/21/1122288/google-gemini-ai-energy/).

**Deskilling**

- K. Budzyń et al., _Lancet Gastroenterol Hepatol_ 10:896–903, 2025 ([Warwick repository](https://wrap.warwick.ac.uk/id/eprint/191005)).
- J. H. Shen & A. Tamkin, "How AI assistance impacts the formation of coding skills", Anthropic, 2026 ([anthropic.com](https://www.anthropic.com/research/AI-assistance-coding-skills); [InfoQ](https://infoq.com/news/2026/02/ai-coding-skill-formation/)).

**Provider terms [U]**

- [winbuzzer, 2026-02-19](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/).
- [gigazine, 2026-02-20](https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block).
- [letsdatascience](https://letsdatascience.com/news/anthropic-revises-terms-to-bar-third-party-harnesses-b7377cc7).

**Standards**

- WCAG 2.2 (W3C, 2023).
- ISO 24495-1:2023 (plain language).
- SLSA v1.0; Sigstore; The Update Framework (TUF).
- Regulation (EU) 2024/1689 (AI Act), Art. 4 and Art. 50.

**Repository evidence**

- `packages/program/src/{schemas,envelope,machine,report,notify,scheduler,sources,driver,actions}.ts`.
- ADR-0007, 0011, 0014, 0021, 0025–0029.
- D-018 to D-027.
- `docs/metrics/PRODUCTIVITY.md`, `docs/adoption/*`, `docs/benchmark/*`.
