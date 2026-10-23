# ADR-0019 — Kernel service layer and the console server protocol

**Status:** Accepted by the PO (phase 3, proposed by S1) · **Date:** 2026-10-23

## Context

KP Studio (web, desktop, terminal) and the CLI must drive the same engine with the same
safety rules. Until phase 2 those rules lived in `apps/cli/src/commands`.

## Decision

- **`packages/kernel` is the service layer.** `Kernel` offers `plan`, `validatePlan`,
  `startRun`, `cancel`, `pause`, `resume`, `redirect`, `instruct`, `applyPatches`,
  `providers`, `tools`, `sessions`, `events`, `stats`, `verify` and `exportMarkdown`. The
  host (CLI, server, tests) supplies `say`, `confirm`, `onRunPlanned`, `onEvent`,
  `onRunState` and `onControl` callbacks. The CLI is a thin client; its output and exit
  codes did not change. Every rule is enforced once, in the kernel: the workspace guard
  before any paid call (including a model planner), the planner budget gate, the
  whole-graph budget check, `maxGraphUsd` = the accepted total, critic-approved and
  hidden-byte-free patches only, nothing applied after a cancel, every write confirmed
  unless `yesApply` (never offered over the protocol), and serialized confirmations.
- **Steering goes through `GraphRunner`'s `RunControl`** (ADR-0020): one runner per run.
  Its control feed maps to `run.state` (`paused`, `running`, `cancelling`) and to a
  `run.control` notification. A refused action is the JSON-RPC error `refused` (-32003).
- **Editable plans (R-301):** `plan.validate {planId, graph}` re-checks and re-estimates an
  edited graph without running it. `run.start` takes the same `graph`, and the kernel
  validates it again, because the client is untrusted. The run then executes exactly
  that graph, with its edits journaled. A plan expires after 32 newer plans.
- **Routing data (R-303, spec §4.4)** is gathered at the kernel boundary without touching
  other packages. The router and the journal handed to the runner are wrapped, so:
  - plan nodes carry `reason`, `score`, `parts` and `runnerUp`, but only when the router
    agrees with the estimate's first model;
  - `node_state` events carry `reason` and `score`;
  - `contribution` events carry `usage` token counts.
    The estimate carries the band from S4's `outputSpread` (R-302).
- **`packages/server`:** JSON-RPC 2.0 over WebSocket (`ws`) at `/rpc`, plus the built UI
  over HTTP. The server binds only to 127.0.0.1, on a random port. It enforces:
  - **Token transport.** The client sends subprotocols
    `['kernelpai.v1', 'kernelpai.bearer.<token>']`. The server echoes back only
    `kernelpai.v1` and closes with **4401** if the token is wrong. `Authorization: Bearer`
    is also accepted for non-browser clients. The token is 32 random bytes per start,
    compared in constant time, and stored in `$KPAI_HOME/server.json` with mode 0600.
    It reaches the browser in the URL fragment, which is never sent to a server.
  - **Host and Origin.** A non-loopback `Host` is refused (421 for HTTP, 403 for an
    upgrade), which defends against DNS rebinding. An `Origin` that is not the server's
    own or in `KPAI_STUDIO_ORIGINS` is refused with 403. A missing Origin is allowed:
    browsers always send one, and other local clients are held to the token.
  - **Message validation.** Every message is checked against `protocol.ts`: params on the
    way in, results and notifications on the way out. Batches are refused.
  - **Confirmations.** They go out as `confirm.request` notifications to every
    authenticated client, and the first `confirm.answer` wins. No client, no answer before
    `timeoutMs` (default 120 s), or a patch too large to show all mean "no". Patch
    confirmations carry the diff in a separate `patch` field.
- **Protocol additions (version 1, additive):**
  - result schemas for every method, with `parseResult` and `parseNotification`;
  - the methods `plan.validate` and `run.instruct`, and the `run.control` notification;
  - optional `band`, `reason`, `score`, `parts`, `runnerUp` and `usage` fields;
  - the error codes `refused`, `unsupported`, `workspace` and `unroutable`;
  - the constants `SUBPROTOCOL`, `BEARER_PREFIX` and `CloseCodes`.
- `kpai studio [--port N]` starts the server and prints `http://127.0.0.1:<port>/#token=…`.

## Consequences

- The token in a subprotocol header is visible to local proxies and to process
  inspection by the same user. This is accepted: the server is loopback-only, and any
  process running as that user can read `server.json` anyway.
- Run notifications are broadcast to every authenticated client so a reconnecting
  console sees them. Clients that reconnect miss what was sent while they were away
  (R-507, phase 5).
- `confirm.answer`'s `trustSession` is accepted but ignored until the tool policy exposes
  session trust over the protocol.

## Revisit when

Remote or multi-user access (R-801), background runs (R-507), or a second protocol version.
