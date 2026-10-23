# ADR-0017 — Task graph, protocols and tool contracts

**Status:** Accepted (phase 2) · **Date:** 2026-10-23

## Decision

- **Graph:** a `TaskGraph` is a list of `GraphNode`s (a `TaskNode` plus title, `dependsOn`, `protocol`, allowed `tools`). Planners are pluggable (`Planner.plan`); the plan is always shown before anything runs and records whether a template or a model made it.
- **Protocols:** `solo`, `author_critic`, `debate`, `vote` (Relay and Swarm later). Each produces a `ProtocolResult` with the list of `Contribution`s (role, model, text, cost, verdict), so the console can show who did what.
- **Critique** is structured (`Verdict`: approve, issues with severity, summary), parsed and validated; never free text that the kernel must interpret loosely.
- **Diversity (principle 2):** critics, judges and voters are routed with `excludeProviders` set to the providers already involved; when diversity is impossible the run says so and needs an explicit, journaled override.
- **Tools:** one `ToolBus` for built-ins and MCP servers; every tool has a `risk` (read / write / destructive) and goes through a `PermissionPolicy` (spec §3.3); tools act only inside the workspace root; MCP tools are namespaced `mcp.<server>.<tool>`.
- **Tool calling** is part of the provider contract: `ChatRequest.tools` (JSON Schema, MCP-compatible), assistant `toolCalls`, `tool` messages, a `tool_call` stream event and a `tool_use` stop reason. Tool input from a model is untrusted data, validated before any execution.
- **Live progress:** `GraphEvent`s (node state, text, contribution, done) are the single feed for the CLI now and the desktop console in phase 3.

## Consequences

Protocols compose routing, fallback and budget gating from phase 1 rather than reimplementing them. A graph's cost is estimated before it runs as the sum of routed node estimates times protocol rounds.
