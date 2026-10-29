# ADR-0035 — Enterprise runtime: program store, headless daemon, S10 safeguards

**Status:** Accepted by the PO (D-033; proposed by S1, phase 5, WP4; implements ADR-0031, D-028, D-029) · **Date:** 2026-10-23

## Context

ADR-0031 made `packages/program` pure: charter, envelope, machine, scheduler, reports. Phase 5 must run it: a `RunStarter` over the kernel, a durable store, `kpai serve --headless` that survives restarts (R-5E2, R-5E4, R-507), the `program.*` / `enterprise.*` protocol (design §14), and the S10 safeguards adopted in D-029 (R2, R3, R5, R7, R8, R10, R6 journal fields). The kernel stays a library; nothing that writes files or loops belongs in `packages/program`.

## Decision

1. **New package `@kernelpai/enterprise`** (depends on kernel, program, learning). Pure safeguards go to `packages/program` (`safeguards`, `approvals`, `watchdog`, `assurance`, `team`); side effects stay here. The server serves `program.*` and `enterprise.*` (`protocol-enterprise.ts`, additive to version 1); `kpai program …` uses the same runtime in-process.
2. **Store under `$KPAI_HOME`.** `programs/<id>/state.json` (the strict `ProgramState`), `events.jsonl` (every transition, refused ones too, SHA-256 chained), `meta.json` (bookkeeping only: baseline, critique, run sessions, answers, views, reports), `reports/`. `enterprise/` holds `queue.json` (`QueueSchema`), `portfolio.json` (strict settings), `activity.jsonl`, `heartbeat.json`, `daemon.pid`. Atomic rename writes; one writer through an O_EXCL lock file (dead owner taken over); the lock is never held across a kernel call.
3. **Kernel wiring.** `KernelRunStarter` plans each WP in its own journal session and starts it isolated, **unattended** (asserted, WP7-L13) with an intent (`run intent`, J1). A review is one read-only solo critique node, re-estimated, excluding every builder provider. Kernel questions for a program run are routed by async context to the envelope: only `budget.within` and `confirm.worktree` verdicts on `confirmFacts` are pre-answered (journaled `pre-answered`); the run's own band top is released when checking an amount inside it. Everything else becomes an inbox question; the run waits up to `confirmWaitMinutes`, then no. Disputes in a program run fail closed. Unknown `physical` now escalates (WP7-L3); spend questions state `physical: false`.
4. **Daemon.** Per tick: (A, locked) each program steps (start, follow-ups on answers, safeguards, gate open), (B) needs are planned unlocked, (C, locked) jobs queued and the portfolio scheduler picks under kill switch, concurrency, portfolio cap and spend rate, (D) `delegate` in the background; the machine re-checks `run.started` and a refused start is cancelled. Subscription plans are never queued (D-029 R1). One daemon per home. On start, a run recorded `running` that this process does not hold is settled `cancelled` with `interrupted:restart` and its journal session's cost (band top if unknown), then planned again through the envelope: nothing starts twice, nothing is re-spent silently.
5. **Safeguards.** R2: heartbeat journaled every `heartbeatSec`, `heartbeat.json` and `GET /enterprise/heartbeat` (stale after three beats, 503), watchdog alerts (stalled program, silent run, old ask, overdue digest, blocked queue) journaled once. R3: `usdPerHour` over live band tops plus costs settled in the hour; a pause and a consequential question at each quarter of a phase cap without a new ≥ V1 result; envelope expiry 14 days (drafted, else after approval), renewal by a Sponsor yes to the exact amended hash. R5: V0–V2 from the run's journal (last verdict by another provider on every critic-reviewed node; passing tests or CI), V3 when a human opened a V2 run. R7: default charter = builder (+ pack specialist) + reviewer; departments opt-in; gate-only reports. R8: only `confirm.write` and `confirm.budget` are trivial (batchable); consequential answers need a `viewed` record first; G2 rate in the snapshot. R10: baseline = the goal planned as one run; a solo critic run excluding the builders' providers, quoted. R6: answers journaled with `askedAt`, `answeredAt`, `viewed`, `viewedAt`.

## Consequences

- Each property has a test that fails when it is reverted (23 mutations, all caught).
- `kpai studio` serves the Enterprise methods but runs no daemon; `kpai serve` is the daemon. Both can share a home.
- Gate verdicts are a consequential Sponsor yes ("no open Critical/High") rather than parsed review text: honest, slower.
- Not yet: `program.merge`, amendments from clients, `enterprise.sources` onboarding (R-5E12), outbound channels (WP5), queue rate-limit marks from kernel 429s, per-seat packs in the run request.

## Revisit when

Several daemons per home, the queue outgrows JSON (SQLite, B-23), remote approvals (phase 6), or gate verdicts get a typed findings channel.

## Addendum (D-034: north-star journal fields, S8)

- **J1** every attended run that is not a fork journals a `run intent` (`human-request`; `ticket:<id>` for tickets); a fork inherits its parent's intent.
- **J2** `confirmation answered`: kind, risk, consequential, answer, asked and answered times, and what was viewed (`diff` or `none`). Never the question text, only for questions of a known run.
- **J3** `git.apply`, `fs.write` and `merge-back` carry SHA-256 images of each file before and after, so reverts are detected.
- **J5** the heartbeat fact carries `intervalSec`, `queued` and `oldestAskAgeSec`.
- J4 (energy) is not journaled yet; energy is reported as "not measured" until descriptors carry coefficients.
