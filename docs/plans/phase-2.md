# Phase 2 plan — Protocols and tool bus

Owner: Product Owner · Started 2026-10-23 · Exit criteria: `docs/BUILD_PROMPT.md` (Phase 2), spec §3.1, §3.3, §9.

Contracts landed first by the PO (ADR-0017): `packages/core/src/graph.ts` (TaskGraph, GraphNode, Planner, protocols, contributions, Verdict, GraphEvent, GraphResult), `packages/core/src/tools.ts` (ToolDefinition, ToolRisk, ToolBus, PermissionPolicy, ToolContext), and tool calling in `schemas.ts` (`ChatRequest.tools`, `tool` messages, assistant `toolCalls`, `tool_call` stream event, `tool_use` stop reason). Seats must not change them; requests go to the PO.

## Work packages

### WP1 — Tool calling in adapters (S2, kpai-provider-engineer)

Owns `packages/providers/**`.

1. Anthropic and AI SDK adapters: send `req.tools` and the tool-call/tool-result history; emit `tool_call` events with parsed input; map the provider's tool-use stop to `tool_use`. Validate tool input is an object; malformed tool JSON → `malformed`.
2. Ollama: tools via `/api/chat` `tools` field where supported; otherwise ignore tools and say so in `detect()` reason (document).
3. MockAdapter role scripting for offline demos and tests, driven only by markers in the prompt (no new descriptor fields): `Role: planner` → valid plan JSON from a `[[plan:…]]` marker or a default template; `Role: critic` → verdict JSON (approve unless `[[reject]]` / `[[reject@provider]]`); `Role: judge` / `Role: voter` → deterministic picks; `[[tool:name {json}]]` → emits a `tool_call` once, then answers after the tool result. Keep existing triggers working.
   Acceptance: contract tests per wire protocol for tool calls round-trip (fake servers), mock scripting tests, coverage ≥ 80 %.

### WP2 — Tool bus (S5, kpai-tools-engineer)

Owns `packages/tools/**`.

1. `LocalToolBus implements ToolBus`: registry of built-in tools + MCP tools, input validation against JSON Schema (zod from schema or a small validator), permission policy, journaling (`tool` events: name, risk, decision, duration, truncated result — never secrets), output truncation (e.g. 32 kB).
2. Built-ins, all jailed to `ctx.root` (resolve symlinks, refuse `..` escapes and absolute paths outside root): `fs.list`, `fs.read` (read), `fs.write` (write), `fs.delete` (destructive), `git.status`, `git.diff`, `git.log` (read), `git.apply` (write: applies a unified diff, `--check` first), `shell.run` (destructive by default; an allow-list of read-only commands such as `ls`, `cat`, `git status`, test runners can be configured as write).
3. `GradedPermissionPolicy implements PermissionPolicy` (spec §3.3): read → allow; write → confirm once per batch (per node), unless trusted for this session+root; destructive → confirm every call; per-model deny list; forbidden path globs (phase 6 deepens this) refuse any path match.
4. Shell sandbox: use `@anthropic-ai/sandbox-runtime` when available on macOS/Linux (check it works here; this container has no bwrap); otherwise run with cwd=root, scrubbed env (no `*_API_KEY`/`*_TOKEN`), timeout, output cap — and always confirm. Windows: always confirm. Record the actual mode in each `tool` journal event.
5. MCP client (`@modelcontextprotocol/client` v2): connect stdio servers listed in `$KPAI_HOME/mcp.json` (`{ servers: { name: { command, args, env } } }`), expose their tools as `mcp.<server>.<tool>` with risk from annotations (`readOnlyHint` → read, `destructiveHint` → destructive, else write). Test against an in-repo tiny MCP server built with `@modelcontextprotocol/server` (dev dependency) over stdio.
   Acceptance: jail escape tests (../, symlink, absolute), permission matrix tests, shell scrubbing/timeout tests, MCP round-trip test, coverage ≥ 80 %.

### WP3 — Orchestrator (S4, kpai-orchestration-engineer)

Owns `packages/orchestrator/**`.

1. Planners: `TemplatePlanner` (deterministic: classify the request; code requests → architecture(analysis, debate when criticality critical) → implementation(code_generation, author_critic) → tests(test, author_critic) → review(critique, solo by a 4th provider when possible); writing → draft(author_critic); decision → debate; closed choice → vote; else solo) and `ModelPlanner` (routes a `decision` node, asks for JSON `TaskGraph` with `Role: planner`, validates with zod, rejects cycles/unknown deps/>12 nodes, falls back to the template with the reason).
2. Protocols on top of `CompetenceRouter` + `FallbackExecutor` + `BudgetGate`-like hook: Solo; Author+critic (critic routed with `excludeProviders: [author.provider]` — principle 2 — verdict JSON parsed and validated, author revises on major issues, max 2 rounds, final approval recorded); Debate (two debaters from different providers, one rebuttal each, judge from a third provider when available); Vote (N=3 voters from distinct providers when available, majority weighted by competence; ties → highest competence). Every model step is journaled with role in the payload.
3. `GraphRunner`: topological execution, parallel ready nodes (concurrency option, default 3), dependency outputs passed as context, per-node budget check before running, cancellation (signal) stops all and keeps partial results, node states and text emitted as `GraphEvent`s, failure of a node marks dependants `skipped`.
4. Tool loop: when a node lists tools and a model emits `tool_call`, run it through the `ToolBus` (permission + journal), append the result as a `tool` message, continue (max 8 tool rounds per step).
5. Graph cost estimate before running (sum of routed expected costs, × rounds for protocols) for the CLI to show.
   Acceptance: tests with scripted adapters/mocks for each protocol incl. diversity (critic never same provider as author; fails clearly when only one provider exists unless `allowSameProvider` is set and recorded), revision loop, vote tie, debate judge, DAG ordering/parallelism, failure → skipped, cancel, tool loop with permission denial; coverage ≥ 80 %.

### WP4 — Integration (PO)

`kpai plan "request"` (show the graph and routing per node, estimate), `kpai do "request"` (plan → estimate → confirm → run graph with live per-node lines → final output; code outputs as unified diffs applied with `git.apply` after critic approval and human confirmation), `kpai tools` (list tools and risks), demo `scripts/demo-phase2.mjs` on a throwaway git repo: "add an OAuth state validator with tests" — plan, three roles from three providers, critic from a fourth, cost before run, diff applied. ADRs, independent review, `docs/PHASE-2-REPORT.md`.
