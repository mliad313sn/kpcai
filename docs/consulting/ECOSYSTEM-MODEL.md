# KP Studio: ecosystem model

Author: S10 (D-027) · 2026-10-23 · Status: proposal. Pricing items depend on the Sponsor (Q-6, SD-3, SD-4). Lens: platform economics (Rochet & Tirole 2003; Parker, Van Alstyne & Choudary 2016), commons governance (Ostrom 1990), software supply-chain security (SLSA, Sigstore, TUF). Opinions are marked; unverified claims are [U].

## 1. Actors and what each needs

| Actor                                           | Gives                                                                             | Gets                                                                                        | What would make them leave                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Individual user** (any domain)                | Attention, intent, their own keys or local compute, a licence fee (if commercial) | Verified results, cost known before spending, privacy, learning                             | A surprise bill; a bad change that lands silently; jargon; lock-in                   |
| **Team / enterprise** (phase 8)                 | Seats, a self-hosted server, policies                                             | Pooled budgets, audit (ISO 42001, AI Act Art. 50), shared packs and memory, outcome metrics | No SSO or audit; unclear liability; vendor-hosted data                               |
| **Pack author** (community, vendors, educators) | Domain knowledge as data (`PACK-AUTHORING.md`)                                    | Reach, attribution, quality feedback, reputation; optionally income (later, opinion)        | Their work is unseen, uncredited or cloned without credit; heavy publishing ceremony |
| **Model provider**                              | Models, APIs, terms                                                               | Fair, explained selection on quality and price; paying BYOK traffic; no terms abuse         | Abuse of subscriptions (R1); opaque ranking; scraping or arbitrage                   |
| **Tool / MCP server author**                    | Tools                                                                             | Distribution through suggestions; pinned trust                                              | Silent blocking; no path to "verified"                                               |
| **Society**                                     | Tolerance, regulation, energy                                                     | Accountable AI use, less waste, no harm to third parties                                    | Misuse, opacity, energy waste                                                        |
| **KP (Sponsor)**                                | The product, curation, governance                                                 | Licence revenue, reputation                                                                 | Paying for inference it does not sell; policing costs                                |

## 2. Value flows

```
            licence (per seat/machine)                       BYOK tokens at list price (no markup)
  User ───────────────────────────────▶ KP        User ──────────────────────────────────────▶ Provider
   ▲  verified outcomes, cost contract    │          ▲  explained routing = fair selection          │
   │                                      │ curation, signing, governance                           │ models, terms
   │                                      ▼                                                         ▼
   │      packs (data)  ◀────────── Pack authors ◀─── attribution + outcome-based reputation (opt-in stats)
   │                                      ▲
   └── opt-in anonymised competence evidence ──▶ Community benchmark ──▶ better priors for all users,
                                                    (aggregated, k-thresholded)    fair trials for providers
```

**Principles:**

1. **No money flows on tokens through KP.** Zero markup keeps the router credibly neutral (benchmark §6). KP never earns more when the user spends more on inference, so the "Auto mode" incentive conflict cannot arise.
2. **KP earns on the product, not on the complement.** Packs and the pack format stay open (SD-3). This is the classic platform rule: commoditise the complement to grow the platform (opinion, consistent with Parker et al.).
3. **Credit flows to authors through the journal.** Every run records `pack id@version#hash` (R15). With the author's and the users' opt-in, aggregated outcome counts return to the author.

## 3. Cold start and network effects

- **The supply side is seeded.** 18 built-in packs plus `general` (D-019) is the right subsidy. Next, convert the `PERSONAS-AND-USE-CASES.md` "first 10 minutes" scenarios into pack fixtures, so community authors have a test to pass.
- **Same-side effects (users) are weak in a local-first product.** Cross-side effects (packs ↔ users) and the data effect (benchmarks) are the real ones. Both are fragile to pollution, so governance comes _before_ scale (§4, §5).
- **Team effects (phase 8).** Shared project memory and packs inside a team server give KP its strongest lock-in. It should be _earned_ lock-in: export everything as Markdown and JSON (ADR-0027 already does this for memory).

## 4. Pack governance: signing, reputation, contribution

### 4.1 Trust ladder (R15)

| Level        | How it is reached                                                                                                                                                                                                      | What it unlocks                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **local**    | Any YAML in `$KPAI_HOME/packs` or `<repo>/.kpstudio/packs`                                                                                                                                                             | Works on that machine; repository packs untrusted and tighten-only (ADR-0025)                                                        |
| **signed**   | Sigstore keyless signature (OIDC identity of the author, entry in the Rekor transparency log); content hash in the signature                                                                                           | Installable from the registry; the identity is shown                                                                                 |
| **reviewed** | Automated checks pass: `kpai pack check`; no model ids or prices; zone relaxations narrow and never credential; injection lint on prose (imperatives aimed at models, URLs, hidden Unicode); plan fixture runs offline | Shown in suggestions (never auto-installed)                                                                                          |
| **curated**  | Maintainer review plus at least 30 days without an open security report                                                                                                                                                | May relax name-heuristic zones (already restricted to built-in and `$KPAI_HOME` packs), may set `requiresScope` packs as suggestions |

- Packs are **pinned by content hash**. An update is a new version that the user approves, with a diff of the YAML, as R-501 does for MCP servers.
- The registry metadata follows **TUF** (The Update Framework) roles, so a compromised mirror cannot serve old or altered packs (opinion: the proportionate choice; it is what PyPI and others adopted or proposed [U on current adoption status]).
- Pack prose (`reviewCriteria`, `tips`, `glossary`, plan titles) is **always quoted as untrusted** when it reaches a model or a UI, whatever the level.
- **Offensive-security, reverse-engineering and physical-effect packs:** curated level only in the registry; interactive only (R13); bound by the acceptable-use policy (SD-2).

### 4.2 Reputation that resists gaming

Do **not** use downloads or stars (anti-feature 7). They are cheap to fake and measure popularity, not value. Use the following:

| Signal                                        | Source                                                                               | Gaming resistance                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Durable verified outcomes using this pack** | Opt-in aggregated counts (METRICS DVO) from distinct installations, per pack version | Counted per _installation key_: a signed, rate-limited per-install key, not per run; k-threshold (§5); outliers trimmed |
| **Rollback rate with this pack**              | Same channel                                                                         | Hard to fake low without real use                                                                                       |
| **Security record**                           | Open and closed reports, time to fix                                                 | Public tracker                                                                                                          |
| **Maintenance**                               | Signed releases in the last 12 months                                                | Transparency log                                                                                                        |

Reputation is shown as **bands** ("used to good effect in 50–200 installations"), not as exact ranks. Bands blunt the incentive to game small differences (opinion).

### 4.3 Contribution governance (after Ostrom's principles)

1. **Clear boundaries.** A pack is one YAML file with a schema. The registry accepts only that.
2. **Rules fit local conditions.** Domain stewards (for example the GIS or security packs) review their domain.
3. **Those affected take part in rule-making.** A public RFC process for schema changes. Proposed task types (`proposedTaskTypes`) go to S1 through ADRs, as today (ADR-0024).
4. **Monitoring.** Automated checks plus community reports.
5. **Graduated sanctions:** warning → delisting of a version → revocation of the signing identity in the registry.
6. **Conflict resolution.** A named maintainer group with a published decision log.
7. **Right to organise.** Anyone can host a fork of the registry. The format is open (SD-3).

## 5. Shared competence benchmark (R-804, phase 8), opt-in and anonymised

**Purpose.** Better cold-start priors for every user, and fair trials for new models. It replaces the tier-based judgement in `descriptors/COMPETENCE.md` (B-2) with outcome evidence.

**What is shared** (default nothing; opt-in per project):

```
{ model: "provider/model@descriptor-version", taskType, packId@version?,
  grade: 0|1 (g ≥ 0.5, ADR-0028), assurance: V0..V3, inBand: bool,
  costBucket: log2 bucket, energyBucket?: bucket, week: ISO week }
```

**What is never shared:** prompts, outputs, code, file names, repository identity, user identity, exact cost, timestamps finer than a week, memory.

**Privacy:**

- Each record goes through **randomised response** on the grade bit before upload (local differential privacy; ε chosen by the maintainers and published — opinion: start at ε ≈ 1–2 per record).
- **Aggregates are published only** for cells with at least k = 20 distinct installations (k-anonymity floor).
- Installation keys rotate yearly.

**Integrity (Sybil and poisoning resistance):**

- Uploads are signed by a per-install key, issued once per licence or install and rate-limited.
- Aggregation uses robust statistics (trimmed mean or median of per-install means).
- Each cell is capped in how much weight one installation can carry.
- Provider-affiliated installations self-declare and are reported separately.
- Methodology and code are public.

**Use in routing:** community evidence enters as the **prior** (ADR-0028's `p`), never as measured competence. Local evidence always dominates once n ≥ 5, which keeps the bounded blend.

**Governance:**

- A data steward is named.
- A retention limit is set (for example 24 months).
- A public changelog is kept.
- Providers **cannot pay** to be included, ranked or excluded.
- Under GDPR, the controller role and the lawful basis are Sponsor decisions (SD-8).

## 6. Fair and transparent pricing (aligned with Q-6)

This is the PO default applied while Q-6 is open; the final call is the Sponsor's.

| Element                                          | Proposal                                                                                                                               | Rationale                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Inference                                        | **Zero markup.** BYOK at the provider's list price; local models $0. KP never resells tokens                                           | Neutral routing; removes the incentive conflict (benchmark §6)         |
| Individual non-commercial, students, education   | **Free**                                                                                                                               | Reach, learning, society (opinion)                                     |
| Commercial use                                   | **Licence per seat or per machine**, flat, published, with no usage tiers                                                              | Predictability. Users hated credit schemes (benchmark §6)              |
| Reviewers and viewers (PMs, designers, auditors) | **Free seats**                                                                                                                         | The conception chain (phase 7) needs them; verification is the product |
| Team server (phase 8)                            | **Included** in seat licences; self-hosted                                                                                             | No hosting obligations (Q-7)                                           |
| Community packs                                  | **Free and open**; no take rate                                                                                                        | Grows the complement                                                   |
| Paid packs (later, optional)                     | Only if authors ask for it. If so: published flat take rate, refunds, the same signing ladder (opinion: ≤ 15 %, below app-store norms) | Avoid extractive marketplace dynamics                                  |
| Regional fairness                                | Purchasing-power-adjusted prices (opinion)                                                                                             | Inclusion                                                              |
| Transparency                                     | A public price page and a public "how KP makes money" page                                                                             | Trust                                                                  |

**What KP must never do** (anti-features):

- earn on inference volume;
- sell routing placement;
- sell or share user data;
- gate safety features (zones, caps, review, audit export) behind a higher tier.

Safety is not a premium feature (opinion, strongly held).

## 7. Ecosystem health metrics (opt-in data only)

| Metric                                                 | Target (opinion)          |
| ------------------------------------------------------ | ------------------------- |
| Distinct domains with a signed or reviewed pack        | Grows every quarter       |
| Median time from pack submission to "reviewed"         | < 7 days                  |
| Packs with at least one security report open > 30 days | 0                         |
| Share of DVO from community (non-built-in) packs       | Rising; no target         |
| Benchmark cells meeting k ≥ 20                         | Published count           |
| Providers represented in benchmark cells               | No single provider > 50 % |
