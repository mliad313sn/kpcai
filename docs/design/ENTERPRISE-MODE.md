# Enterprise mode: the AI Product Owner and the virtual enterprise

Status: **design** (D-025, D-026; ADR-0031 Proposed) · Author: S1 (kernel architect) · Date: 2026-10-23 · Build: phase 5 (remote approvals: phase 6; multi-user: phase 8)

Skeleton: [`packages/program`](../../packages/program/src/index.ts) (pure logic, no kernel calls, no network).

This document started as "Program mode" (D-025). The Sponsor widened it to a whole virtual enterprise (D-026). A **Program** is still the unit of work. The enterprise is the machinery that runs many programs, unattended, across departments and model sources.

## 1. What it is

The user states a goal: "a parametric 3D-printable bracket with its slicing profile", "a GIS dashboard of our flood zones", "OAuth login with tests". An AI Product Owner (PO) assistant then runs the work end to end, the way KernelPAI itself is built (`docs/governance/CHARTER.md`):

1. It writes a **charter**: goal, scope, out of scope, departments and seats, phases and work packages, a **budget envelope** and a report cadence.
2. The user, acting as **Sponsor**, approves the charter and the envelope. Nothing is spent before that.
3. The PO **delegates** each work package as a kernel run (a planned graph with domain packs), **integrates and verifies** the results, and runs an **independent review** at each phase gate.
4. It **reports** at the cadence the user set and **escalates** what the envelope does not cover.
5. It **delivers** the product with a final report whose every claim cites journal evidence.

It works for any domain: departments and seats are lenses, and domain knowledge comes from packs (D-019, `docs/adoption/PACK-AUTHORING.md`).

## 2. Concepts

| Concept                 | Definition                                                                                                                                                                                                                                   | In the skeleton                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Portfolio**           | All programs of one user or machine, with a portfolio cap, concurrency limits, a source policy and a global kill switch.                                                                                                                     | `PortfolioSchema`, `QueueSchema`   |
| **Program**             | One goal taken from charter to delivery. Has a state (§4), a run ledger, gates, a decision log, escalations and reports.                                                                                                                     | `ProgramStateSchema`               |
| **Charter**             | The Sponsor-approved contract of a program: goal, packs, out of scope, departments, seats, phases, envelope, report cadence. Strict schema: an unknown key is an error. Approval is bound to the charter's SHA-256 (`charterHash`).          | `CharterSchema`                    |
| **Department**          | A group of seats with a kind (product, design, engineering, data, security, QA, documentation, operations, review, or a pack's domain), an optional cap, a source policy and an **escalation line** that ends at the Sponsor.                | `DepartmentSchema`                 |
| **Seat / role**         | An agent role: kind (architect, builder, specialist, security, QA, reviewer), free title ("CAD engineer"), mandate, packs, source policy. A seat is a lens, not a process: each of its work packages is a separate run.                      | `SeatSchema`                       |
| **Review function**     | The `review` department. It holds only reviewer seats and never leads a work package. A review runs on a provider that built nothing in the phase, with no shared context.                                                                   | charter refinements, `passBlocker` |
| **Phase**               | A set of work packages with a goal, exit criteria and a phase cap. It ends with a gate.                                                                                                                                                      | `PhaseSchema`                      |
| **Work package (WP)**   | One delegated unit: lead seat, request, deliverables, acceptance tests. It becomes one kernel run (re-runs after a hold are new runs).                                                                                                       | `WorkPackageSchema`                |
| **Gate**                | The end of a phase: every WP finished, an independent review run, then the PO's verdict `pass`, `pass-with-notes` or `hold`. A pass needs evidence, zero open Critical/High findings and a reviewer provider different from every builder's. | `GateRecordSchema`, `gate.close`   |
| **Decision log**        | Every decision of the PO or the Sponsor, with date, text, rejected alternative and evidence. PO text is model output, shown quoted.                                                                                                          | `DecisionSchema`                   |
| **Escalation**          | A question to the Sponsor, raised when the envelope says `escalate`. It carries the rule that raised it and, for a run, the exact subject (WP and band top). A yes covers one action, once.                                                  | `EscalationSchema`, `sponsorYes`   |
| **Delegation envelope** | What the PO may do without asking: total, run, phase and department caps, subscription quotas, write policy, pre-answerable confirmations, expiry. It has no field that can name a Sponsor-reserved item.                                    | `EnvelopeSchema`, `checkAction`    |
| **Model source**        | Where a model runs: `local` (Ollama, llama.cpp: $0, offline), `api` (BYOK keys, USD per token), `subscription` (the user's own agent CLI or plan, R-503; quota in runs and hours). A subscription agent counts as its provider.              | `SourceKindSchema`, `sources.ts`   |
| **Report**              | An executive summary built by code from the program state and journal metrics: progress, evidence, budget by source, gates, decisions taken, decisions waiting, risks. FR/EN.                                                                | `buildReport`                      |
| **Job**                 | A WP run waiting in the portfolio queue, with priority, band top and candidate (provider, source) list in fallback order.                                                                                                                    | `JobSchema`, `schedule`            |

## 3. User journey

1. **Goal.** In KP Studio (or `kpai program new "goal"`), the user states a goal and optionally a budget, deadline, cadence and language.
2. **Onboarding of sources.** The daemon detects local servers (`/api/tags`, `/v1/models`), API keys named in descriptors (env or keychain; values never read into the journal), and agent CLIs on `PATH` (`claude`, `codex`, `gemini`, `opencode`). It proposes a staffing plan: "security and data local-only on qwen-coder; engineering on your Claude Code subscription with API fallback; independent review on Gemini API".
3. **Charter draft.** The PO assistant drafts the charter. Its text is model output: it is parsed by `CharterSchema`, then shown to the user as a document with the org chart, the phase timeline and the envelope in figures (likely and cap, D-021).
4. **Approval.** The Sponsor edits and approves. The approval records the charter hash. Changing a comma afterwards needs a new approval.
5. **Autonomous execution.** The daemon queues the current phase's WPs. Each is planned by the kernel, checked by the envelope on its band top, started in its own worktree, reviewed by a critic of another provider, and settled with typed results.
6. **Reports.** Digests at the cadence (every N hours: daily, weekly), plus a report at each gate and milestone. Executive style, figures first, every claim with evidence.
7. **Escalations.** Anything outside the envelope lands in the Inbox (and, from phase 6, can be answered from a phone). The program continues with what does not depend on the answer.
8. **Gates.** At the end of a phase, the review function runs on another provider with the exit criteria only. The PO closes the gate on the verdict; a hold sends the phase back to work.
9. **Milestone merge.** Merging a run's worktree into the user's branch is one click (or a pre-authorised auto-merge, §6.3). The default branch is always the Sponsor's.
10. **Delivery.** The last gate passes, the final report is written. It says "verified" only with CI green for the exact head commit and passing tests.

## 4. Program state machine

```
draft ──propose──▶ proposed ──approve(hash)──▶ approved ──start──▶ running(phase N)
  ▲                    │reject                                       │ gate.open (all WPs finished, none live)
  └────────────────────┘                                             ▼
                                         running(N+1) ◀──pass── gate ──hold──▶ running(N)
                                                                      │pass on last phase
                                                                      ▼
                                                                  delivered
approved | running | gate ──pause──▶ paused ──resume──▶ (previous)      any live ──stop──▶ stopped
```

- **Actors** are stamped by the host: `sponsor` (an authenticated click), `po` (the assistant), `kernel` (journaled facts). `EVENT_ACTORS` lists who may send each event: only the Sponsor approves, rejects, answers or approves amendments; only the kernel reports run starts and settlements, so the PO cannot fabricate costs or evidence.
- **Amendments** do not interrupt the program: the approved charter stays in force until the Sponsor approves the new hash. An amendment cannot drop the current phase.
- **Defence in depth:** `run.started` is re-checked against the envelope inside the machine, so a host bug that starts a run without asking still cannot record it as allowed.
- **Durability (R-507):** the state is a strict JSON document. The daemon persists it after every event, and the event itself is journaled. After a restart the daemon reloads the state, asks the kernel for every `running` run, and settles or resumes them; paused programs stay paused.

## 5. How seats map to kernel runs

| Program element    | Kernel element                                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work package       | `Kernel.plan(request, {packs, isolated: true})` then `startRun({planId})`: a planned graph run in its own worktree (ADR-0021), with the program's and the seat's domain packs (ADR-0025), rules and memory.                                                                              |
| Seat               | The run's routing hints: department and seat source policy narrow the router's candidates (§8); the seat's packs and mandate are added to the request.                                                                                                                                   |
| Envelope check     | Before `startRun`, `checkAction({kind: 'run.start', capUsd: plan.estimate.capUsd, …})`. D-021: the band top is reserved while the run lives; the real cost replaces it when it settles.                                                                                                  |
| Critic             | Unchanged: every code, test and file node keeps its cross-provider critic (ADR-0017, ADR-0029).                                                                                                                                                                                          |
| Independent review | A separate run, purpose `review`, keyed by the phase id: read-only, request built from the phase goal and exit criteria only (`reviewRequest`), no builder conversation, memory scoped to the review session, and a provider absent from every builder run of the phase (`passBlocker`). |
| External agents    | A seat may run on a subscription agent CLI (R-503) as the node author, under the user's own auth, in the node's worktree; KP never handles its credentials.                                                                                                                              |
| Results            | Only typed fields return: status, cost, hours, tests passed, evidence ids. Free text is `untrustedSummary`, for people only (§9).                                                                                                                                                        |

The skeleton injects the kernel as a `RunStarter` interface (`plan`, `start`), so `packages/program` stays pure and testable. Phase 5 adds the adapter in the kernel or the daemon.

## 6. Delegation envelope (safety)

`checkAction(state, action, now)` returns `allow`, `escalate` (ask the Sponsor) or `refuse`, with a stable rule id that is journaled and shown in the decision log. Order of checks:

1. **Parse.** The action is model output: strict schema, anything else is `refuse(action.invalid)`.
2. **Reserved items first.** `kind: 'reserved'` always escalates, whatever the state, envelope or expiry.
3. **Envelope changes.** Any widening (total or run cap up, new pre-answer, write policy relaxed, subscription quota up or added, expiry later or removed) escalates as `widen-envelope`. A narrowing is allowed (still recorded as an amendment).
4. **Program state.** Unapproved, paused, stopped or delivered: refuse. Expired envelope: escalate.
5. **Run start.** Work runs only while `running` and only for a WP of the current phase; review runs only at the `gate`. Not isolated: escalate. Source policy breach: refuse. Subscription quota used: escalate. Then the caps, each on band tops with live runs reserved: run cap, department cap, phase cap, total cap. Over any cap: escalate as `spend-beyond-envelope`.
6. **Confirmations.** See 6.2.
7. **Merge.** See 6.3.

### 6.1 Budget (D-021)

- Every figure compared is a **band top** (`plan.estimate.capUsd`), never the expected cost.
- `committed = Σ settled cost + Σ max(cap, cost so far) of live runs`, per phase, per department, per program; the portfolio adds the same per program (`schedule`).
- A yes to a budget escalation covers **one run**: the escalation names the WP and a band top, and the yes is consumed when that run starts (`sponsorYes`). The PO cannot reuse it.
- Subscription runs cost $0 in USD and are counted in their own unit: runs and hours per subscription (`SubscriptionQuota`). An unlisted subscription is not usable.

### 6.2 Confirmations the envelope may pre-answer

| Kernel confirmation                       | Pre-answer allowed when                                                  | Never pre-answered                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `budget` (graph total, node cap)          | `budget-within-envelope` is granted and the extra amount fits every cap  | Amount unknown; beyond the envelope                                                                                                                                                                                |
| `patch`, `artifact`, `tool` (read, write) | `write-in-worktree` is granted and the write lands in the run's worktree | Writes in the user's tree                                                                                                                                                                                          |
| `restore`, any `risk: 'destructive'`      | never                                                                    | Destructive (charter §5)                                                                                                                                                                                           |
| any step with physical effects            | never                                                                    | Physical devices (D-019)                                                                                                                                                                                           |
| `dispute`, `memory`                       | never: a human choice by design (R-405, ADR-0027)                        |                                                                                                                                                                                                                    |
| Reserved items                            | never                                                                    | Spending beyond the envelope, publishing, licences, credentials, external accounts, third-party terms, merging into the default branch, destructive and physical actions, human-only checks, widening the envelope |

`PreAnswerSchema` is a closed enum of two values. There is no way to write `preAnswer: ['publish']`: it does not parse. The tests sweep every reserved item and every destructive confirmation across tight and maximal envelopes and every state.

**Contract gap for phase 5:** the kernel's `ConfirmRequest` carries the budget amount only in the question text. Pre-answering needs a structured `amountUsd` (and `inWorktree`, `physical`) on confirmations. This is an additive change in `packages/kernel/src/confirm.ts` and protocol version 1, owned by S1, tracked as an open item of ADR-0031.

### 6.3 Write policy

- **Default `isolated-only`:** every run writes in its own worktree under `$KPAI_HOME/worktrees` (ADR-0021). Merge into the user's branch happens at milestones, on one-click Sponsor approval with the diff, tests and critic verdict shown.
- **Opt-in `auto-merge`**, with limits (`maxFiles`, `maxLines`): allowed only when tests passed, the critic approved, CI is green for **that exact commit**, no forbidden zone was touched, and the size is within limits. Any condition missing: escalate with the list of what is missing.
- The **default branch** is always the Sponsor's (charter §5): escalate whatever the policy.
- Zones and the authorised scope are unchanged: the envelope adds rights to answer questions, never to touch a zone (ADR-0023) or leave a scope (ADR-0025).

## 7. Organisation and scale

### 7.1 Org chart

Departments: product, design, engineering, data, security, QA, documentation, operations/release, review, plus domain departments from packs (a pack may propose a department template: "CAD shop", "GIS lab"). The PO assistant is the delivery lead of every department. The org chart is part of the charter, so editing it is an amendment the Sponsor approves. Schema rules: unique ids, every seat in a known department, reviewers only in `review` and `review` only reviewers, a reviewer never leads a WP, department caps within the total, escalation lines acyclic and ending at the Sponsor.

### 7.2 Portfolio, queue and workers

- **Durable job queue** (`QueueSchema`), persisted by the daemon in `$KPAI_HOME/enterprise/queue.json` with a journal entry per change (SQLite in phase 6 if contention shows).
- **Worker pool:** each worker is a kernel run; the pool size is the total concurrency limit.
- **Scheduling** (`schedule`), on every tick and every settlement: kill switch → total limit → per-program limit → portfolio cap (band tops reserved) → the program's envelope (`checkAction`) → first candidate (provider, source) within policy, not rate-limited, under its provider's concurrency limit.
- **Priorities** `urgent | high | normal | low`, promoted one level per `agingMinutes` waited, so nothing starves; ties by age then id.
- **Rate limits and quotas:** a 429 or an exhausted subscription marks `source:provider` until Retry-After; the job returns to the queue (attempt counted, partial cost billed) and takes its next candidate within policy. A pinned model (ADR-0020) has one candidate and waits.
- **Kill switch:** nothing starts; `killList` gives the runs to cancel; programs stay resumable.

## 8. Model sources

| Source         | Examples                                                      | Budget unit                                                          | Credentials                              |
| -------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| `local`        | Ollama, llama.cpp, LM Studio (descriptor kind `local`)        | $0; compute hours reported                                           | none                                     |
| `api`          | Anthropic, OpenAI, Google, Mistral, xAI, DeepSeek, OpenRouter | USD on band tops (D-021)                                             | env or keychain, named in descriptors    |
| `subscription` | Claude Code, Codex CLI, Gemini CLI, opencode, user endpoints  | runs and hours per subscription; quota shown when the CLI exposes it | the CLI's own login; KP never reads them |

- **Source policy** at portfolio, program, department and seat; levels only narrow (`effectivePolicy`): intersection of allowed sources and providers, union of denied providers. Examples: security and data `{sources: ['local']}`; review `{sources: ['api'], denyProviders: [builder providers]}`; engineering `{sources: ['subscription', 'api']}` with a Claude Code quota in the envelope.
- **Diversity (principle 2) across sources:** the diversity key is the provider, whatever the source. A Claude Code builder is `anthropic`; an Anthropic API reviewer is then refused at the gate.
- **Fallback across sources** follows the job's candidate list and the policy: subscription quota exhausted → same provider's API → another provider → local. A local-only seat has no cloud candidate after filtering, so it waits rather than leaving the machine.
- **Air-gapped programs:** `{sources: ['local']}` at the portfolio; reports go to the Markdown channel only.
- **Third-party terms** stay Sponsor-reserved: KP uses a subscription only when the user lists it in the envelope and the CLI is already logged in; it never accepts terms or logs in for the user.
- **Reports show spend by source:** API dollars, subscription runs/quota and hours, local compute hours (`spendBySource`).

## 9. Prompt-injection posture

- The PO assistant's charters, plans, decisions and actions are **model output**. Each passes a strict schema; actions go through `checkAction`; events through `transition`. The decision log shows its text quoted.
- **No self-widening:** the envelope only changes through an amendment approved by the Sponsor's hash. `checkAction` is pure and returns a verdict, never a new envelope.
- **No privilege requests from runs:** a run reaches the program only through typed fields (`RunResult`). Its text (`untrustedSummary`) is never parsed. Escalations are created by the PO from envelope verdicts, not by run output; their question text is shown quoted.
- **Actor stamping** is done by the host. A message that claims to be "from the Sponsor" inside model output is just text.
- **Memory:** program decisions are not memory facts; model proposals still need human confirmation (ADR-0027).

## 10. Honesty

- A report line is a claim; claims of success carry evidence ids (`run:`, `event:`, `ci:<commit>:<status>`, `test:`).
- **Delivered is "verified" only** with CI success for the exact head commit and test evidence with zero failures (`deliveryGap`); otherwise the headline says "Delivered. Not verified: …". This mirrors the lesson "check CI for the exact commit before reporting".
- Gate pass needs evidence; the PO cannot record run costs or test results (kernel-only events).
- Budget figures come from the run ledger, never from model text.

## 11. Unattended operation

- `kpai serve --headless`: the console server without UI, bound to 127.0.0.1, keeping programs running with no client attached (R-507). It loads the portfolio at start, reconciles live runs and resumes the scheduler.
- **Deployment targets, in order:** (1) the user's always-on machine (desktop, home server, NAS), service files for systemd and launchd; (2) a self-hosted VPS or container (docker-compose reference, data volume for `$KPAI_HOME`); (3) an optional cloud runner, later, only on a Sponsor decision (Q-E1), because it changes the local-first posture.
- **$0 and air-gapped:** local sources only, Markdown reports, no outbound channel.

## 12. Reports and notifications (outbound)

- **Kinds:** digest (cadence: every N hours, e.g. daily 24, weekly 168), gate, milestone, final. FR/EN, from the charter's locale or the report locale.
- **Content:** progress, evidence (CI for the exact commit, tests), budget against the envelope by phase and by source, gates, decisions taken, decisions waiting, risks.
- **Channels:** email (SMTP), push (ntfy, Pushover), chat webhooks (Slack, Teams, Discord, Telegram), RSS/Markdown file. `renderNotification` builds the payload without credentials or endpoint; the phase 5 sender adds them from env or the keychain at send time. Channel secrets are never journaled.
- **Redaction:** a notification never contains code, secrets or local-only memory. Code-shaped lines and key material are dropped; secret-shaped tokens become `[redacted]`; `localOnly` lines are dropped; quoted model text is cut to 200 characters; bodies fit each channel's limit at a line boundary; the only link allowed is loopback (`kpai studio` on the machine) until the phase 6 remote layer.

## 13. Remote approvals (inbound, phase 6)

The biggest security surface, built as a separate hardened layer and reviewed on its own:

- **No exposure beyond loopback by default.** Remote mode is an explicit opt-in.
- **Transport and identity:** TLS; passkeys (WebAuthn) or device pairing (one-time code shown on the machine).
- **Approval links:** short-lived (minutes), signed, bound to one escalation id and its subject hash, single use, revocable.
- **Scope:** a remote answer can only answer an escalation the envelope raised. It can never widen the envelope or approve a Sponsor-reserved item without a strong re-authentication (fresh passkey assertion, user verification).
- **Audit:** every remote answer journaled with device, time and link id; a digest lists them.
- Until phase 6, reports point to `kpai studio` on the machine.

## 14. Protocol and Enterprise view

### 14.1 Methods (JSON-RPC, additive to protocol version 1)

| Method                                  | Params → result                                                                    | Who          |
| --------------------------------------- | ---------------------------------------------------------------------------------- | ------------ |
| `program.create`                        | `{goal, locale?, budgetUsd?, cadence?}` → `{programId, charter}` (draft by the PO) | client       |
| `program.get`                           | `{programId}` → `ProgramState`                                                     | client       |
| `program.approve` / `program.reject`    | `{programId, charterHash}` / `{programId, reason}` → `Ok`                          | Sponsor only |
| `program.amend.approve` / `.reject`     | `{programId, charterHash}` → `Ok`                                                  | Sponsor only |
| `program.pause` / `.resume` / `.stop`   | `{programId}` → `Ok`                                                               | Sponsor      |
| `program.answer`                        | `{programId, escalationId, answer: 'yes' \| 'no'}` → `Ok`                          | Sponsor only |
| `program.merge`                         | `{programId, runId}` → `MergeResult` (confirmed write)                             | Sponsor      |
| `program.reports`                       | `{programId, since?}` → `Report[]`                                                 | client       |
| `enterprise.snapshot`                   | `{}` → `EnterpriseSnapshot`                                                        | client       |
| `enterprise.kill` / `enterprise.unkill` | `{}` → `{cancelled: string[]}`                                                     | Sponsor      |
| `enterprise.sources`                    | `{}` → detected sources and proposed staffing                                      | client       |

The PO assistant has no protocol method: it acts through `transition` and `checkAction` inside the daemon.

### 14.2 Notifications and snapshot (typed)

```ts
const SeatState = z.enum([
  'idle',
  'thinking',
  'writing',
  'reviewing',
  'waiting_for_you',
  'blocked',
]);
const Health = z.enum(['on_track', 'at_risk', 'blocked']);
const Source = z.enum(['local', 'api', 'subscription']);
const Ref = z.object({
  kind: z.enum(['run', 'node', 'event', 'diff', 'report', 'escalation']),
  id: z.string(),
});

const SeatView = z.object({
  programId: z.string(),
  seatId: z.string(),
  department: z.string(),
  kind: z.string(),
  title: z.string(),
  model: z.object({ provider: z.string(), model: z.string() }).optional(),
  source: Source.optional(),
  state: SeatState,
  wpId: z.string().optional(),
  runId: z.string().optional(),
});
const Gauge = z.object({
  scope: z.enum(['portfolio', 'program', 'department', 'source']),
  id: z.string(),
  usd: z.object({ committed: z.number(), spent: z.number(), cap: z.number() }).optional(),
  quota: z
    .object({
      runs: z.number(),
      runsCap: z.number().optional(),
      hours: z.number(),
      hoursCap: z.number().optional(),
    })
    .optional(),
  localHours: z.number().optional(),
  concurrency: z.object({ inUse: z.number(), limit: z.number() }).optional(),
});
const ProgramCard = z.object({
  programId: z.string(),
  goal: z.string(),
  status: z.string(),
  health: Health,
  phases: z.array(
    z.object({ id: z.string(), title: z.string(), state: z.enum(['done', 'current', 'next']) }),
  ),
  gate: z.object({ phaseId: z.string(), verdict: z.string().optional() }).optional(),
  nextDecision: z.object({ escalationId: z.string(), question: z.string() }).optional(),
});
export const EnterpriseSnapshot = z.object({
  version: z.literal(1),
  at: z.string(),
  killSwitch: z.boolean(),
  programs: z.array(ProgramCard),
  seats: z.array(SeatView),
  gauges: z.array(Gauge),
  inbox: z.array(
    z.object({
      programId: z.string(),
      escalationId: z.string(),
      rule: z.string(),
      question: z.string(),
      evidence: z.array(Ref),
    }),
  ),
  cursor: z.number().int(), // last activity sequence included
});

// Server → client notifications, each with a monotonic `seq` so a client resumes with `since`.
export const EnterpriseNotifications = {
  'enterprise.seat': SeatView.extend({ seq: z.number() }),
  'enterprise.wp': z.object({
    seq: z.number(),
    programId: z.string(),
    wpId: z.string(),
    from: z.string().optional(),
    to: z.string(),
    state: z.enum(['queued', 'running', 'review', 'done', 'held']),
  }),
  'enterprise.program': ProgramCard.extend({ seq: z.number() }),
  'enterprise.gauge': Gauge.extend({ seq: z.number() }),
  'enterprise.activity': z.object({
    seq: z.number(),
    at: z.string(),
    programId: z.string(),
    text: z.string(),
    refs: z.array(Ref),
  }),
  'enterprise.inbox': z.object({
    seq: z.number(),
    programId: z.string(),
    escalationId: z.string(),
    state: z.enum(['open', 'answered', 'expired']),
  }),
  'enterprise.report': z.object({
    seq: z.number(),
    programId: z.string(),
    reportId: z.string(),
    kind: z.string(),
    title: z.string(),
    channels: z.array(z.string()),
  }),
};
```

Activity text is built by the kernel from typed events ("Security reviewed the login patch (approved, 2 notes)"), never copied from model output; model text appears only behind a `Ref`, rendered as text.

### 14.3 Enterprise view (S6, phase 5)

- **Live organisation map.** Departments as areas; each seat an avatar with role, model and source badge (local / API / subscription) and state (idle, thinking, writing, reviewing, waiting for you, blocked). WP cards move between seats (`enterprise.wp`); reviews and gates appear as checkpoints on the paths.
- **Portfolio board.** One row per program: phases on a timeline, current gate, health, next decision expected from the user.
- **Live activity feed.** One plain-language line per event; each opens the graph node, journal entry or diff (`refs`).
- **Gauges** per portfolio, program, department and source: dollars (committed, spent, cap), subscription quota, local compute, concurrency against limits. Kill switch on the portfolio gauge (confirmed).
- **Inbox.** Escalations and approvals with their evidence; one-click answers; remote approvals land here in phase 6.
- **Reports archive.** Every report sent, its channels and evidence links.
- **Editable org chart.** Edits produce an amendment for Sponsor approval.
- **Accessibility and performance.** WCAG 2.2 AA, reduced-motion option (cards jump instead of moving), full keyboard navigation, local actions under 100 ms, virtualised rendering for hundreds of seats and thousands of feed lines, updates coalesced per animation frame. Model output is always rendered as text. Web console and desktop share the view; the TUI shows a compact text version (programs, inbox, gauges, feed).

## 15. Failure modes and limits

| Failure                                   | Behaviour                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| PO proposes an action that does not parse | `refuse(action.invalid)`, journaled; repeated refusals pause the program and escalate (phase 5 threshold) |
| PO loops on rework (gate holds)           | Phase cap stops it: further runs escalate as `spend-beyond-envelope`                                      |
| Daemon crash mid-run                      | State and queue reloaded; live runs reconciled with the kernel journal; nothing restarts twice (run ids)  |
| Provider rate-limited or quota exhausted  | Next candidate within policy; local-only waits; all exhausted → job held, report says so                  |
| Reviewer shares a provider with a builder | Gate pass refused; PO must plan a review on another provider                                              |
| CI not available in this environment      | Delivery reported "not verified"; never ticked silently                                                   |
| Sponsor unreachable                       | Escalations wait; envelope expiry (optional) escalates everything; nothing reserved happens               |
| Notification channel down                 | Report kept in the archive and Markdown file; retried; never blocks the program                           |
| Model output tries to instruct the PO     | Typed results only; text never parsed (test: `driver.test.ts`)                                            |

Limits: up to 20 phases, 30 WPs per phase, 20 seats and 30 departments per charter; 256 concurrent workers per portfolio. The PO assistant's quality bounds the program's quality: the gates and the Sponsor remain the backstop.

## 16. Phase mapping (proposal; the PO decides)

- **Phase 5:** daemon (`kpai serve --headless`), durable queue and worker pool, portfolio and program engine on background runs (R-507) and external agents (R-503), model sources and onboarding detection, outbound reports and notifications, Enterprise view, protocol `program.*` / `enterprise.*`.
- **Phase 6:** remote approval layer and its independent security review; keychain-backed channel secrets.
- **Phase 8:** multi-user enterprise (several Sponsors, roles, shared budgets, SSO).

## 17. Requirements

### Program mode (PO assistant), phase 5

| ID    | Prio   | Requirement                                                                                                                                                                              | Acceptance test                                                                                        |
| ----- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| R-5P1 | Must   | A goal produces a charter draft (departments, seats, phases, WPs, envelope, cadence) validated by a strict schema; nothing is spent before Sponsor approval.                             | Fake planner charter: parse errors refused; `run.start` before approval refused (`program.unapproved`) |
| R-5P2 | Must   | Approval is bound to the charter hash; any change needs a new Sponsor approval; the approved charter stays in force meanwhile.                                                           | Machine tests: wrong hash refused; amendment pending keeps old caps                                    |
| R-5P3 | Must   | Every run is checked before start on its band top against run, department, phase and total caps, live runs reserved (D-021).                                                             | Envelope tests per cap; kernel e2e with fake provider: over-cap plan escalates, no call made           |
| R-5P4 | Must   | The envelope never pre-answers a Sponsor-reserved item, a destructive or physical action, a dispute or a memory fact, and never widens itself.                                           | Sweep test over all reserved items × envelopes × states; widening escalates; state unchanged           |
| R-5P5 | Must   | Writes are isolated by default; merge into the user's branch is one click; opt-in auto-merge only with tests, critic, CI for the exact commit, no zone, within limits.                   | Merge tests: each missing condition listed; default branch always escalates                            |
| R-5P6 | Must   | Independent gate review: separate run, exit criteria only, provider different from every builder (subscription counts as its provider), pass needs evidence and zero open Critical/High. | Gate tests: same provider, no evidence, open High each refused                                         |
| R-5P7 | Must   | Pause, resume and stop the whole program at any time; a Sponsor pause is lifted only by the Sponsor; state survives a daemon restart.                                                    | Machine tests; daemon restart test with fake kernel: program resumes, no run started twice             |
| R-5P8 | Must   | Decision log and escalations journaled and visible; PO text shown quoted; run output reaches the PO as typed fields only.                                                                | Injection test: run text asking for budget changes nothing                                             |
| R-5P9 | Must   | Reports cite journal evidence; "delivered" is "verified" only with CI green for the exact head commit and passing tests.                                                                 | Report tests: six missing-evidence cases all "Not verified"                                            |
| R-5PA | Should | Program pre-answers `budget` and worktree-write confirmations within the envelope; the kernel exposes structured `amountUsd`, `inWorktree`, `physical`.                                  | Kernel test: pre-answered confirmation journaled with the envelope rule                                |

### Enterprise, phase 5

| ID     | Prio   | Requirement                                                                                                                                                                               | Acceptance test                                                                                   |
| ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| R-5E1  | Must   | Org chart in the charter: departments (incl. pack domains), seats, escalation lines to the Sponsor, a review department holding only reviewers; viewable and editable (edit = amendment). | Schema tests; e2e edit produces an amendment awaiting approval                                    |
| R-5E2  | Must   | Portfolio of programs with a durable queue, worker pool, priorities with aging, concurrency limits (total, per program, per provider), portfolio cap and kill switch.                     | Scheduler tests; daemon test: kill switch cancels live runs and starts nothing                    |
| R-5E3  | Must   | Rate limits and quota exhaustion fall back to the next candidate within policy, per `source:provider`.                                                                                    | Scheduler test with fake 429: next candidate; local-only never goes to cloud                      |
| R-5E4  | Must   | `kpai serve --headless` keeps programs running with no client, survives restarts and resumes (R-507), loopback only.                                                                      | Kill the daemon mid-run with fake kernel; restart; state, queue and confirmations intact          |
| R-5E5  | Must   | Model sources local, API and subscription in any mix; subscription agents via R-503 under the user's own auth, never handling their credentials.                                          | Fake agent CLI binary; no credential read; run counted as its provider                            |
| R-5E6  | Must   | Source policy per portfolio, program, department and seat, narrowing only; enforced by envelope and scheduler.                                                                            | Policy tests: security local-only refused on API, held when local is busy                         |
| R-5E7  | Must   | Subscription quotas as their own budget unit (runs, hours), quota shown when the CLI exposes it; reports show spend by source.                                                            | Envelope quota tests; report shows API $, subscription runs/hours, local hours                    |
| R-5E8  | Must   | Executive reports: digest at the user's cadence plus gate, milestone and final reports, FR/EN, citing evidence, decisions taken and waiting.                                              | Report tests in both locales                                                                      |
| R-5E9  | Must   | Outbound channels: SMTP, ntfy, Pushover, Slack, Teams, Discord, Telegram, Markdown/RSS; secrets from env or keychain; never code, secrets or local-only memory.                           | Redaction tests on every channel; fake SMTP/HTTP servers receive payloads with no secret patterns |
| R-5E10 | Must   | Enterprise view: org map, portfolio board, activity feed, gauges, inbox, reports archive; `enterprise.*` snapshot and notifications with resumable `seq`.                                 | e2e with fake kernel: seat state changes and inbox answer; protocol schema tests                  |
| R-5E11 | Must   | Enterprise view meets WCAG 2.2 AA, reduced motion, keyboard navigation, < 100 ms local actions, smooth with 500 seats (virtualised).                                                      | axe 0 violations; perf test with 500 fake seats; keyboard-only e2e                                |
| R-5E12 | Should | Onboarding detects local servers, API keys (by name), agent CLIs, and proposes a staffing plan with sources per department.                                                               | Fixture PATH and fake servers: plan lists each detected source                                    |
| R-5E13 | Should | Deployment guides and service files for an always-on machine and a self-hosted VPS/container; air-gapped local-only mode.                                                                 | Container smoke test offline with a fake local model server                                       |
| R-5E14 | Should | Compact TUI version of the Enterprise view.                                                                                                                                               | TUI snapshot test                                                                                 |

### Enterprise, phase 6

| ID    | Prio   | Requirement                                                                                                                                           | Acceptance test                                                                  |
| ----- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| R-6E1 | Must   | Remote approval layer, opt-in, no exposure beyond loopback by default; TLS; passkeys or device pairing.                                               | Default config test: only 127.0.0.1 bound; pairing flow test                     |
| R-6E2 | Must   | Approval links short-lived, signed, single use, bound to one escalation and its subject hash; revocable.                                              | Replay, expiry, wrong-subject and reuse attempts refused                         |
| R-6E3 | Must   | A remote answer can only answer an escalation the envelope raised; widening the envelope or a Sponsor-reserved item needs a strong re-authentication. | Tests: forged escalation id refused; reserved item without fresh passkey refused |
| R-6E4 | Must   | Full audit trail of remote answers (device, time, link) in the journal and the next digest.                                                           | Audit test                                                                       |
| R-6E5 | Must   | Independent security review of the remote layer before it ships.                                                                                      | Review register with no open Critical/High                                       |
| R-6E6 | Should | Channel secrets in the OS keychain.                                                                                                                   | Keychain fake test                                                               |

## 18. Open questions for the Sponsor

| #    | Question                                                                                                                       | Default meanwhile                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Q-E1 | An optional cloud runner (programs running off the user's machines) changes the local-first posture. Allowed, and when?        | Not built; always-on machine and self-hosted VPS only |
| Q-E2 | Default report cadence and language for new programs?                                                                          | Daily digest (24 h) plus gate reports, charter locale |
| Q-E3 | Should auto-merge ever be offered by default, or stay opt-in per program?                                                      | Opt-in per program, isolated-only by default          |
| Q-E4 | Using subscriptions through their CLIs unattended may hit providers' terms of use. Which subscriptions may be used unattended? | Only those the Sponsor lists in an envelope           |
| Q-E5 | Which notification channels are acceptable for summaries leaving the machine (e.g. third-party chat services)?                 | Markdown file and local email (SMTP) only until set   |
| Q-E6 | Remote approvals from a phone (phase 6): may a passkey re-authentication approve Sponsor-reserved items remotely, or never?    | Never remotely; reserved items only on the machine    |
