# Phase 3 plan — Console (KP Studio)

Owner: Product Owner · Drafted 2026-10-23 · **Starts after the phase 2 gate passes.** Exit criteria: `docs/BUILD_PROMPT.md` (Phase 3), spec §4, §9.

## Architecture (ADR-0019, to be accepted at kick-off)

```
apps/studio-desktop (Tauri 2) ─┐                ┌─ apps/cli (existing)
apps/studio (React 19)  ───────┼─ JSON-RPC 2.0 / WS ──→ packages/server ──→ packages/kernel ──→ orchestrator, router, tools…
apps/studio-tui (Ink 8)  ──────┘   127.0.0.1 + token                         (service layer, also used by the CLI)
```

- **packages/kernel** — the service layer extracted from `apps/cli/src/commands/*`: `plan`, `startRun`, `cancel`, `pause`/`resume`, `redirect`, `applyPatches`, `providers`, `tools`, `sessions`, `events`, `stats`, `verify`. Emits `GraphEvent`s and confirmation requests through callbacks. The CLI becomes a thin client of it (no behaviour change; all CLI tests stay green).
- **packages/server** — JSON-RPC 2.0 over WebSocket bound to 127.0.0.1 on a random port; bearer token in `$KPAI_HOME/server.json` (file mode 0600); Origin allow-list; serves the built KP Studio UI. Confirmations (tool permissions, budget) are server→client requests the UI answers; unanswered → declined. Protocol in `packages/kernel/src/protocol.ts` (zod-validated both ways).
- **apps/studio** — KP Studio, React 19 + Vite. Five zones of spec §4.1: command bar (natural language, `/` commands, `@` files, `#` tasks, `!` terminal), execution thread (live DAG, clickable nodes: prompt, answer, routing reason, redirect / replay / fork stubs), agents board (who, provider, node, elapsed, cost, confidence), central tabs (conversation, diff with apply, terminal through the tool bus, files), explorer. Keyboard-first command palette; dark/light; WCAG 2.2 AA (axe in CI); < 100 ms for local actions.
- **apps/studio-tui** — KP Studio in the terminal, Ink 8 client of the same server: plan view, live thread, agents, confirmations.
- **apps/studio-desktop** — KP Studio desktop, Tauri 2 shell loading the web build, starting the kernel server as a sidecar; CI compiles it on Windows, macOS and Linux (no signing — Sponsor-reserved).
- **Onboarding (spec §4.6)** — `kpai init` and a first-run screen: detect keys and local models, choose a profile (économe / équilibré / performance), optional 2-minute calibration, first guided task.

## Work packages

- **WP1 (S1 architect):** packages/kernel extraction + protocol contract + ADR-0019; CLI moved onto it.
- **WP2 (S4):** GraphRunner pause/resume (stop scheduling, keep in-flight), node redirect to a chosen model (principle 4), replay of a node with another model (spec §3.5 groundwork).
- **WP3 (S5 or S1):** packages/server (WS JSON-RPC, token, origin check, static UI, confirmations round-trip), integration tests with a real WS client.
- **WP4 (S6):** apps/studio (KP Studio) UI against the protocol (fake server for unit tests).
- **WP5 (S6):** apps/studio-tui + apps/studio-desktop scaffold and CI build job.
- **WP6 (S8):** Playwright e2e (bundled Chromium) on server + web with mock providers, axe accessibility checks, interaction latency budget.
- **WP7 (PO):** onboarding, demo `scripts/demo-phase3.mjs`, independent review, report.

**Naming (Sponsor, D-015):** the user-facing apps are **KP Studio** (web, desktop, terminal). The engine and command line stay **KernelPAI** / `kpai`.
