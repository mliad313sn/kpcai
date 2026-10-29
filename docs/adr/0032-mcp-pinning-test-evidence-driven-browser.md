# ADR-0032 — MCP pinning, tests as evidence, the driven browser

**Status:** Accepted by the PO (D-031; proposed by S5, phase 5, WP1) · **Date:** 2026-10-23

## Context

Phase 5 adds tools that reach outside the workspace or judge it: MCP servers (R-501), a test runner whose results must count (R-505) and a driven browser (spec phase 5, the base of R-506). An MCP server can change its tool descriptions after it was trusted (a "rug pull" that injects instructions into every prompt), test output is written by the code under review, and web pages are untrusted text. None of these may widen zones, budgets or confirmations.

## Decision

1. **MCP allow-list and pins.** Servers exist only in `$KPAI_HOME/mcp.json` (user-written). A person's approval is stored apart in `$KPAI_HOME/mcp-pins.json`: the server's `serverInfo.version` and a SHA-256 over the canonical JSON (sorted keys, sorted tools) of each tool's name, title, description, input schema and annotations (annotations decide the risk grade). On connect and on every `tools/list_changed`, the current list is checked against the pin. Unapproved, changed or unreadable → the server stays attached but **every call is refused by the bus** (`LocalTool.blocked`, journaled `decision: deny`) with a message naming what changed and `kpai mcp approve <server>`; its tools are shown to models with a fixed `[blocked]` description, never the changed text. A block is sticky for the connection. A broken pin file approves nothing.
2. **Approval.** `kpai mcp approve` shows the version, the tools and the per-tool differences, always asks (no `--yes`), pins exactly what was shown, and journals `mcp approved` / `mcp approval declined`. `kpai mcp remove` drops the server from the allow-list and its pin (journaled). `kpai mcp list` shows approved / unapproved / changed / unreachable.
3. **Per-server egress allow-list.** `mcp.json` `egress: ["host", "host:port", "*.domain"]`, empty by default. Each server gets its own loopback HTTP/CONNECT proxy, set in `HTTP(S)_PROXY`/`ALL_PROXY` with `NO_PROXY` cleared; other hosts get `403` and a journaled `mcp egress refused`. Without an OS sandbox this binds only clients that honour proxy variables: it is an allow-list and an audit trail, not a jail (the `sandbox-runtime` adapter of `sandbox.ts`, when wired, is what contains a hostile server).
4. **`test.run`.** Command: the caller's configuration, else `.kpstudio/test.json`, else detection (vitest, jest, a package `test` script, pytest markers, `go test -json`, cargo). The model may only add a name filter and workspace files, mapped to the runner's syntax after `--`; it cannot add flags, so it cannot turn the run into a no-op. It runs through the shell sandbox path (scrubbed env, cwd = root, timeout, output cap) with risk `write` and `alwaysConfirm` without OS isolation (tests execute project code). Output is parsed (vitest, jest, pytest, go JSON and text; exit code as the fallback) into `passed | failed | no-tests | error`, counts and failing names. The result starts with a header line written by the tool before any test output, so the output cannot forge it.
5. **Evidence to the critic.** The orchestrator reads that header from `test.run` results into `NodeRun.tests` (empty at the start of each attempt, replaced only by a newer run, so a revision that does not re-run failing tests is not approved). Critics see it quoted as data; a `failed` or `error` run turns every approval into a rejection with a major issue (journaled `approval overridden by failing tests`), so the author revises; tests still failing after the last revision leave the node unapproved. `no-tests` proves nothing and does not gate.
6. **Evidence to grades.** `packages/learning` counts a `test.run` only when its journaled command passes `isTestCommand` (`test-runs.ts`: no dry run, listing or `--passWithNoTests`) and its status is `passed` (1) or `failed`/timed out (0).
7. **Driven browser.** `browser.open|text|screenshot|click|fill` on headless Chromium through `playwright-core`, launched from `KPAI_CHROMIUM` or `$PLAYWRIGHT_BROWSERS_PATH/chromium`; never installed by KP Studio. One isolated context per session + node, downloads and service workers off. Every request and WebSocket goes through a route: loopback http(s) (by name, never resolved), `file:` inside the workspace and outside forbidden zones (symlinks resolved; also checked by the policy), inline `data:`/`blob:`; anything else is aborted and reported. Another origin opens only when it is on `allowOrigins` **and** a person confirms that `browser.open` (every time). Open/text/screenshot are `read`, click/fill `write`. Page text comes back between markers it cannot close, labelled untrusted. Screenshots are PNG artifacts under `$KPAI_HOME/artifacts/browser` with their SHA-256 in the journal.

## Consequences

- An MCP server added to `mcp.json` does nothing until a person approves it; existing setups must run `kpai mcp approve` once.
- Tests stay offline: fake MCP servers over stdio, a loopback egress target, a fake test runner script, a loopback fixture site; a test host is mapped to loopback inside Chromium (`--host-resolver-rules`) to exercise the remote-origin path without network.
- `test.run` is not in the template planner's default code tools: plans and packs opt in (PO decision).
- Browser tests skip where no Chromium is installed.

## Revisit when

The OS sandbox is wired (egress then enforced for every server), MCP over HTTP is added (its URL host joins the egress check), or R-506 hands screenshots to a vision critic.

## Addendum (D-032, S7 review)

- The approval prompt shows each tool's full model-visible description (up to 1,024 characters, then the count left out), its input schema, every tool, and invisible characters as `\u{…}`.
- Block reasons keep only safe tokens from server-chosen names and versions.
- The browser sends every host that is neither loopback nor allow-listed to a refusing loopback proxy, so redirects and sub-resources cannot leave the policy.
- Writes to `.kpstudio/`, `.claude/` and `.mcp.json` are confirmed on every call.

## Addendum (D-035: test evidence the run cannot write itself, S7)

- **P5-F4.** `test.run` reads its command from the run's own worktree, so a run could write `"test": "echo 7 passed"` and earn V2 with no test. Before it asks and before it runs, `test.run` compares the root with HEAD (a run worktree starts from its checkpoint commit, so every change is the run's own; `test-tamper.ts`). The run is `tampered` when it changed a package.json's `scripts`, `jest` field or detected runner, `.kpstudio/test.json`, a vitest / vite / jest / mocha / pytest / tox / Cargo / go.mod / Makefile configuration, a `conftest.py`, or a script file the test command or the root `scripts` name.
- A tampered run says so in the confirmation (`TAMPERED: …`), in a second evidence line the critic reads (`tampered (this run changed its own test configuration; not test evidence): …`) and in the journaled meta (`tampered`, `tamperedFiles`). `shell.run` journals the same facts, so `npm test` by hand is caught too. packages/learning counts neither as test evidence: no tests signal, no V2, no DVO.
- Outside git there is nothing to compare with: `configChecked: false`, and the run is not marked. A program run always has a worktree.
