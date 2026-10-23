# ADR-0031 — Program and Enterprise mode: charter, delegation envelope, portfolio

**Status:** Accepted by the PO (D-028; designed by S1 for D-025, D-026; built in phase 5) · **Date:** 2026-10-23

## Context

D-025 gives KP Studio an AI Product Owner assistant that runs a goal end to end as a program; D-026 widens it to a virtual enterprise: departments, many programs, unattended operation, reports, remote approvals later, and any mix of local, API and subscription models. The assistant is a model: everything it writes is untrusted, yet it must act for hours without the user. Every existing rule must hold (D-021 caps, critic diversity, zones, isolated worktrees, Sponsor-reserved list). Design: [`docs/design/ENTERPRISE-MODE.md`](../design/ENTERPRISE-MODE.md).

## Decision

1. **New isolated package `@kernelpai/program`** (D-013 pipelining), pure: zod schemas, state machine, envelope checker, portfolio scheduler, report builder, notification rendering. The kernel is injected (`RunStarter`); no network sender lives there.
2. **Charter and state machine.** A strict charter (departments with escalation lines to the Sponsor, seats, phases, WPs, envelope, cadence) approved by the Sponsor **by hash**. States: draft → proposed → approved → running(N) → gate → … → delivered, plus paused and stopped. The host stamps actors; only the Sponsor approves and answers, only the kernel reports run facts.
3. **Delegation envelope.** `checkAction` returns allow / escalate / refuse. Reserved items always escalate. The envelope has no field that can name one; `preAnswer` is a closed enum (`budget-within-envelope`, `write-in-worktree`). Widening escalates; the envelope changes only through an amendment the Sponsor approves. Caps compare band tops with live runs reserved (D-021), at run, department, phase, program and portfolio levels. A Sponsor yes covers one exact run, once.
4. **Writes.** Isolated worktrees by default; merge at milestones on one click; opt-in auto-merge only with tests, critic, CI for that commit, no zone, within limits; the default branch is always the Sponsor's.
5. **Independent review** is a department and a separate run per gate: exit criteria only, no shared context, a provider absent from every builder run. A subscription agent counts as its provider.
6. **Model sources** `local | api | subscription`. Policies at portfolio, program, department and seat only narrow. Subscriptions are budgeted in runs and hours. Fallback follows candidates within policy, keyed by `source:provider`.
7. **Honesty.** Reports are built by code from the state and journal metrics. "Delivered" is "verified" only with CI success for the exact head commit and passing tests. Run results reach the program as typed fields only.
8. **Outbound notifications** are summaries plus a loopback link: no code, secrets or local-only memory; channel secrets are added by the sender from env or keychain.
9. **Remote approvals** are a separate phase 6 layer (opt-in, TLS, passkeys or pairing, single-use signed links bound to one escalation, audit); never a way to widen the envelope.

## Consequences

- Program logic is fully testable offline; tests sweep reserved items × envelopes × states.
- Additive kernel contract needed in phase 5: structured `amountUsd`, `inWorktree`, `physical` on `ConfirmRequest`, run `providers` and `source` on outcomes. Protocol `program.*` and `enterprise.*` are additive to version 1.
- The PO assistant's quality bounds the program's; gates, caps and the Sponsor are the backstop.
- A cloud runner is out of scope until the Sponsor decides (Q-E1).

## Revisit when

Multi-user enterprise (phase 8), the remote layer's security review (phase 6), or the queue outgrowing a JSON file.
