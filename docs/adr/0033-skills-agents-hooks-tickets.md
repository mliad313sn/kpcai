# ADR-0033 — Skills, named agents, hooks, local tickets and the D-028 delegate facts

**Status:** Accepted by the PO (D-031; proposed by S1, phase 5, WP2; R-502, D-028) · **Date:** 2026-10-23

## Context

R-502 asks for Claude Code–compatible skills, named agents and lifecycle hooks that run through the tool bus. Phase 5 also takes local Markdown tickets as run input. Every one of these is text or code from the repository: untrusted (spec §6, ADR-0015). D-028 approved an additive kernel contract so that a program's envelope (ADR-0031 §3) can decide on typed facts instead of the question text.

## Decision

1. **Skills** are `SKILL.md` files (front matter `name`, `description`, `allowed-tools`) in `$KPAI_HOME/skills/`, `.kpstudio/skills/` and `.claude/skills/`; the home wins a name. **Named agents** are `<name>.md` (front matter `name`, `description`, `tools`, `model`) in `$KPAI_HOME/agents/`, `.kpstudio/agents/`, `.claude/agents/`. Repository files are read inside the jail (no link out, no forbidden zone), capped, stripped of controls and secrets.
2. **Assignment.** A node names `skill` and `agent` (plan option `--skill`/`--agent`, a plan edit, or a ticket). The run's graph then has the agent's instructions and the skill's procedure as fenced `user` messages, never `system`, labelled untrusted for repository files. Tools are **intersected** with `allowed-tools`/`tools` (Claude Code names mapped: `Read` → `fs.read`, `Bash(...)` → `shell.run`); a node without tools keeps none; an unknown name leaves the node with no tool. The planner sees names and descriptions only.
3. **Model hint** (`model: sonnet`) is resolved against the routable candidates from the YAML catalog: `provider/model`, a model id, or one word of a display name, used only when exactly one candidate matches; it pins the node's first step, and the router still applies every constraint. No model id lives in code.
4. **Hooks** `before-plan`, `before-tool`, `after-patch` come from `$KPAI_HOME/hooks.json` and `.kpstudio/hooks.json` (strict schema). Each runs as one `shell.run` call through a tool bus: policy, zones, scrubbed environment, timeout (default 10 s, max 60 s) and journal apply, with the event as the program's last argument (JSON, secrets redacted). A hook is a **confirmed process** unless `$KPAI_HOME/hooks.json` `allow` lists its exact command line; an `allow` list in a repository file is ignored. Hook calls use their own write batch and the `kernel/hook` model, so a yes to a hook never covers a model's writes.
5. **Veto, fail closed.** A `before-tool` or `before-plan` hook that exits non-zero, times out, cannot start, is refused or declined vetoes the step; so does a hooks file that does not parse. Hook output is quoted untrusted text: it can veto, never approve or widen. `after-patch` hooks only report. Before-tool hooks wrap the run's bus, so replays and forks get them too.
6. **Tickets** are `.kpstudio/tickets/<id>.md` (`title`, `status`, optional `skill`/`agent`, acceptance criteria as a list). `kpai ticket list|show|run`; the request is the ticket fenced as untrusted goal text plus numbered exit criteria; no other front matter field reaches an option. The outcome is written to the status line only after the human confirms the exact new file (`artifact` confirmation), through `fs.write`.
7. **D-028, additive.** `ConfirmRequest` gains `amountUsd` (budget questions with a known amount; never for going past an accepted cap), `inWorktree`, `physical` (a selected pack has physical effects). Finished `RunOutcome` gains `providers`, `sources` and `source` (`local` only for a local descriptor, agents `subscription`, anything else `api`, several kinds `mixed`); they are journaled with the outcome. `confirmFacts` maps a request onto the program's `confirm` action, missing facts taking the escalating value. Protocol 1 gains these optional fields, `RunOptions.skill/agent`, `plan.extensions`, and `extensions.list`, `tickets.list|show|setStatus`.

## Consequences

- Repository extensions can only narrow; tests sweep each safety property with a mutation check.
- A hook not allow-listed asks once per tool call: users allow-list what they trust. An allow entry names a command line, not file content: a repository script it names may change (revisit).
- The model planner cannot yet assign a skill per node (its schema is in the orchestrator); assignment is by option, edit or ticket.
- The daemon that pre-answers with these facts is wave 2 (WP4).

## Revisit when

Content-pinned allow entries for hooks, a per-node skill choice by the planner, or Claude Code's hook JSON output protocol is needed.
