# ADR-0034 — External agents as node authors, interactive only, fallback per source

**Status:** Accepted by the PO (D-031; proposed by S4, phase 5, WP3) · **Date:** 2026-10-23

## Context

R-503 lets the user's own agent CLIs (Claude Code, Codex, Gemini CLI, opencode) author graph nodes. They run under the user's login on a subscription (ADR-0031 §8: source `subscription`, budgeted in runs and hours, R-5E7), they execute code and write files, and their output is model output. D-029 R1 keeps subscription agents out of unattended runs (provider terms, Q-10). R-5E3 asks that a rate limit or an exhausted quota fall back to the next candidate within policy, tracked per `source:provider`, and that a local-only node never reach the cloud.

## Decision

1. **Descriptors.** One YAML per agent in `packages/providers/agents/` (user directories override by id): binary (a bare name on `PATH` or an absolute path, never a shell), headless arguments with `{prompt}` as a whole argument (or `promptVia: stdin`), output format (`text`, `json`, `jsonl`) and dotted paths to the answer, error flag, notional cost and tokens; rate-limit patterns, exit codes and cooldown; time cap; `provider` (its identity for principle 2) plus `alsoCounts` for multi-provider CLIs (opencode counts as every cloud provider until the user names one); jurisdiction. No model id: the CLI uses the model of the user's own settings.
2. **The node's worktree.** `runAgent` makes a `--shared` clone of the workspace's HEAD in a fresh temp jail (`<jail>/wt`, `TMPDIR=<jail>/tmp`), not a linked git worktree, so the agent never touches the workspace's `.git`. It runs the CLI there without a shell, killing its process group at the time cap or on cancel, keeping at most 1 MiB of each stream. Afterwards it fingerprints the workspace (git status, changed and untracked files, top-level entries including ignored ones, `.git/config` and hooks) and the jail: any change outside `wt` fails the run as `escaped` and nothing is handed on, with no fallback. The diff against the base commit is refused when it holds a symlink, a submodule, binary content, a quoted name, a path with `..` or `.git`, more than 512 KiB, or (orchestrator) a fenced diff block. Git commands on the agent's checkout run with the agent's scrubbed environment and fsmonitor and hooks off. The jail is removed in every case.
3. **Credentials.** KP Studio never reads, stores or forwards the agent's login: its own files and variables pass through untouched (e.g. `CLAUDE_CODE_OAUTH_TOKEN`). The child's environment loses every variable named by a provider descriptor's `auth.env`, every credential-shaped name (`*_API_KEY`, `*_API_TOKEN`, `*_AUTH_TOKEN`, `*_ACCESS_KEY`, `*_SECRET[_KEY]`), `KPAI_*`/`KERNELPAI_*`, and the descriptor's `scrubEnv`. Nothing about the environment is journaled.
4. **In the graph.** A node with `agent: {id, fallback?: 'route' | 'none'}` always runs author + critic (upgrade journaled); its author and revision steps run the agent (a revision starts from the agent's last diff), every other step is routed. The contribution is `<provider>/agent:<id>` at $0, so critics exclude the agent's providers; the node's output is a header, the agent's summary quoted as untrusted with fences and diff headers neutralised, then the bare diff last. The kernel's existing path (approved patch nodes, hidden-byte refusal, confirmed `git.apply`) is unchanged: nothing the agent does reaches the workspace without approval.
5. **Budget (R-5E7).** `agents.budget = {maxRuns, maxMinutes}` per graph run; each agent run claims one run and a time slice (`min(descriptor cap, minutes left)`), which is its kill timer; unused time comes back. The human budget hook is asked before each agent run with a `subscription` label. Notional cost and tokens the CLI reports are journaled (`agent run`), never billed.
6. **Refusals and fallback.** The agent is refused, before any process starts, when the run is unattended (`RunOptions.unattended`, journaled in `run started.routing`; D-029 R1), the node is local-only or its provider or jurisdiction is not allowed, `subscription:<provider>` is limited, or the budget is spent. A refused or rate-limited agent step is routed as usual when the node says `fallback: 'route'` (with every policy and budget gate), else the node fails with the reason; a failed, timed-out or escaped agent never falls back.
7. **Source limits (R-5E3).** `SourceLimits` keys by `source:provider` (`local`, `api`, `subscription`). A routed attempt failing with `rate_limit` marks `api:` or `local:` its provider for `rateLimitCooldownMs` (60 s); an agent's quota marks `subscription:` its provider for its cooldown. Later steps route with limited providers denied on top of the policy (never loosened); when that leaves nothing, they route as before and journal it. Executor fallbacks skip limited candidates. One `sourceLimits` object can be shared by every runner of a kernel.

## Consequences

- The program scheduler (`packages/program`) already keys `rateLimitedUntil` by `source:provider`; this adds the same rule inside a run. Dropping `subscription` candidates for unattended jobs in the scheduler, and kernel/CLI wiring (descriptor loading, `agents` options, the daemon passing `unattended`), are WP4.
- Escape detection is after the fact and covers the workspace and the jail; it is not an OS sandbox. A write elsewhere (home directory) is contained only by the CLI's own sandbox flags (`--sandbox workspace-write`, `acceptEdits`, `auto_edit`). A concurrent tool write in the workspace during an agent run fails that agent node closed.
- Tests use a fake agent CLI (a node script) in temp git repositories; no network, no real CLI.

## Revisit when

The OS sandbox lands (then the agent runs inside it), a CLI reports its remaining quota (show it, R-5E7), or the Sponsor lists subscriptions allowed unattended (Q-E4).

## Addendum (D-032, S7 review)

- The scrub list covers more credential names (tokens, passwords, private keys, cloud credentials, `SSH_AUTH_SOCK`). A descriptor may keep the agent's own login variable with `keepEnv`; KernelPAI's own keys and `KPAI_*` are removed even if listed.
- The agent's diff is read before the second escape snapshot, so git filters planted in the clone are detected.
