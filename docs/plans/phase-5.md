# Phase 5 plan — Tools, extensions and Enterprise mode

Owner: Product Owner · Started 2026-10-23 · Exit criteria: `docs/BUILD_PROMPT.md` (Phase 5: driven browser, test runner, tickets, skills in the Claude Code format, named agents, hooks), the Must items R-501, R-502 and R-505 of [REQUIREMENTS-KP-STUDIO.md](../REQUIREMENTS-KP-STUDIO.md), the phase 5 rows of [design/ENTERPRISE-MODE.md §17](../design/ENTERPRISE-MODE.md) (R-5P1..R-5P9, R-5E1..R-5E11 Must), and the S10 recommendations adopted in D-029.

## Goals

1. **Extensions without new trust holes.**
   - MCP servers come from an allow-list, pinned by version and content hash; a changed description or schema is blocked until re-approved (R-501).
   - Skills in the SKILL.md format, named agents and lifecycle hooks run through the tool bus and its permissions (R-502).
2. **Evidence tools.**
   - A test runner whose results feed the critic and the competence record (R-505).
   - A driven browser for UI checks, local and confirmed (spec phase 5, R-506).
   - Local tickets as run inputs.
3. **Other agents as authors.** Claude Code, Codex, Gemini CLI and opencode run headless as a node's author, under the user's own account, in the node's worktree, within budget, reviewed by another provider (R-503). Per D-029 R1, subscription agents are interactive only: never unattended.
4. **Enterprise mode, running.**
   - The `packages/program` core is wired to the kernel through a headless daemon that survives restarts (R-5E4, R-507), with a durable queue and portfolio scheduling (R-5E2).
   - Fallback per `source:provider` (R-5E3) and source policies that only narrow (R-5E6).
   - Executive reports and outbound notifications (R-5E8, R-5E9).
   - The Enterprise view (R-5E10, R-5E11).
5. **S10 safeguards (D-029).**
   - Heartbeat, watchdog and dead-man's switch (R2); spend-rate cap, no-progress pause and 14-day envelope expiry (R3).
   - Change-only reports with asks first (R4); assurance labels V0–V3 (R5); DVO journal fields (R6, B-28).
   - Small default team (R7); approval friction in proportion to risk with a rubber-stamp rate (R8); a critic on each charter with a single-run baseline (R10).
   - Accessible view and notifications (R12); offensive-security and physical packs never unattended (R13).

## Safety rules for this phase

- **Every extension is untrusted code or text.** MCP tool descriptions, skill bodies, hook output and external agents' output are untrusted data. They cannot widen zones, budgets or confirmations.
- **No credential handling for subscriptions.** External agents use their own login. KP Studio never reads, stores or forwards their tokens.
- **Unattended means narrower, never wider.** The daemon runs only within an approved envelope; Sponsor-reserved items always wait for the human; silence is alerted, not assumed healthy.
- **Tests never touch the network.** Fake MCP servers, fake agent CLIs, fake SMTP and webhook servers only.

## Work packages

Wave 1 (now, in parallel):

- **WP1 (S5): tools.**
  - MCP registry with allow-list, pinning, rug-pull block and per-server egress allow-list (R-501).
  - Test runner tool and test evidence to critic and grades (R-505).
  - Driven browser tool on the preinstalled Chromium, local URLs only by default (spec phase 5).
  - ADR.
- **WP2 (S1): extensions and kernel contracts.**
  - Skills (SKILL.md), named agents and hooks (before plan, before tool, after patch), with a hook veto through the bus (R-502).
  - Local Markdown tickets as run input.
  - The additive contracts approved in D-028: structured `amountUsd`, `inWorktree`, `physical` on confirmations; providers and source in run outcomes.
  - ADR.
- **WP3 (S4): external agents.**
  - Agent CLIs as node authors through an adapter, with a fake CLI binary in tests (R-503).
  - Budget and cross-provider critic apply; interactive only (D-029 R1).
  - Fallback per `source:provider` (R-5E3).
  - ADR.

Wave 2 (after wave 1 lands):

- **WP4 (S1, S4): Enterprise runtime.**
  - `kpai serve --headless` daemon with a durable queue, restart-safe (R-5E4, R-507).
  - Program wiring to the kernel through `RunStarter`.
  - Scheduler and source policies; the S10 safeguards R2, R3, R5, R7, R8 and R10.
- **WP5 (S2): reports and channels.**
  - Executive reports (R4 order, FR/EN, evidence-bound).
  - Outbound channels behind fake servers (R-5E9); notifications carry no project text by default.
- **WP6 (S6): KP Studio views.**
  - Enterprise view (org map, portfolio board, activity, gauges, inbox, reports), WCAG 2.2 AA and < 100 ms (R-5E10, R-5E11).
  - MCP registry and tools panels; compact TUI view (R-5E14).
- **WP7 (S7): security review of WP1–WP6** as they land: MCP, hooks, external agents, daemon and channels.
- **WP8 (S8):** e2e, `scripts/demo-phase5.mjs`, DVO metric from the journal (B-28).
- **WP9 (PO):** independent review, report and gate.

Should items taken if wave 2 has room, else backlogged with a reason: ACP agent server (R-504), UI-aware verification (R-506), draft PR output (R-508), onboarding staffing (R-5E12), deployment guides (R-5E13).
