# ADR-0036 — Executive reports by exception and outbound channels

**Status:** Accepted by the PO (D-034; proposed by S2, phase 5, WP5) · **Date:** 2026-10-23

## Context

ADR-0031 built reports as a seven-section state dump and `notify.ts` as a pure renderer; ADR-0035 archived gate and final reports but sent nothing and wrote no digest. S10 R4 asks for reports by exception, asks first, a forecast with an interval and notifications that carry no project text by default; Q-11 keeps notices on the machine (Markdown file, local SMTP) until the Sponsor says otherwise. R-5E9 lists eight channels, and tests may not touch the network.

## Decision

1. **Report v2, pure (`program/exec-report.ts`).** A fixed order: what needs your answer (each ask with what silence means) → what changed (the program's accepted log lines since the last report) → forecast → top risk; gate, milestone and final reports add every result with its V0–V3 label and basis. Each claim cites evidence: `event:<seq>` (line of `events.jsonl`), `run:`, `escalation:`, `heartbeat:`. "Delivered" reads "verified" only under `deliveryGap` (CI green for the exact head plus passing tests); the daemon has no CI source yet, so finals stay "Not verified". English and French, from the charter.
2. **Forecast from the band history (`forecast.ts`).** Remaining work packages and gate reviews; per run, the 10th–90th percentile of settled costs and durations with five runs or more, otherwise the band seen so far (lowest cost to highest band top), never a guess without history. Live runs count up to their band top; dates use `perProgram` concurrency and past answer delays when known.
3. **Kinds and cadence.** Gate at `gate.open`, milestone when a non-final gate passes, final at delivery, digest at the charter cadence. The default cadence becomes daily (Q-8), replacing ADR-0035's gate-only default (a K2 silent-failure risk). A digest is written only when the period holds a change of note or an alert; otherwise a `digest skipped: no change` fact and an activity line are the heartbeat entry and the cadence restarts. `meta.reportSeq` is the cursor.
4. **Channels (`enterprise/channels/`).** `$KPAI_HOME/enterprise/channels.json`, strict: type, endpoint, and the **names** of env vars holding secrets (webhook URL, token, SMTP password). The Markdown/RSS file (`enterprise/notifications.{jsonl,md,xml}`) is always on; SMTP to a loopback host is local. Every other channel (Slack, Teams, Discord, ntfy, Pushover, Telegram, remote SMTP) is refused until `allowThirdParty: true` (Q-11). Plain HTTP only to loopback, remote SMTP only over TLS.
5. **Content-free notices.** `renderNotice` sends the program id, report kind, counts (asks, budget %, alerts, changes), "delivered, (not) verified" for finals and a loopback link. `summary: true` per channel adds the asks and top risk through the existing `notify.ts` redaction. Every notice goes through `renderNotification`, so it fits the channel's limit.
6. **Delivery.** Reports and alerts are queued under the store lock and sent after it, in the background (`settling`). 429, 5xx, network errors, timeouts and SMTP 4xx are retried with exponential backoff (`retry.attempts`, `retry.baseMs`); other failures are not. Outcomes are journaled as typed facts (channel id, type, attempts, status word) and failures shown in the feed; no response body, error message or endpoint is recorded, so a secret echoed by a service cannot leak. The archive entry lists the channels that took the report.
7. **Liveness.** A new watchdog alert sends rule ids only; a restarted daemon that finds a stale heartbeat reports the silence; `kpai notify check` (cron) alerts once per stale heartbeat. CLI: `kpai report list|show`, `kpai notify list|test|check`; `test` asks before sending.

## Consequences

- Each safety property has a test that fails when it is reverted (see the WP5 report).
- The outbox is in memory: a notice queued at a crash is lost; the report itself stays archived.
- Not yet: a CI evidence source for the daemon, the forecast hit rate (R4 a), keychain secrets (R-6E6), a durable outbox, STARTTLS.

## Revisit when

Remote approvals (phase 6), a CI fact in the journal, or a channel that needs OAuth.
