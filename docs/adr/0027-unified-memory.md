# ADR-0027 — Unified memory: layers, provenance, propose → confirm, budgeted injection

**Status:** Accepted by the PO (proposed by S1; phase 4 WP1, spec §3.1) · **Date:** 2026-10-23

## Context

Spec §3.1 asks for three memory layers (session, project, user), each fact with its
provenance, readable and editable as Markdown, injected into any model so that changing
provider costs nothing. Memory is also a persistence channel for prompt injection: what a
model writes there is sent again on every later call. The phase 4 safety rules require
human confirmation of model facts, redaction, forbidden zones, `local-only` facts and the
R-306 treatment of repository content.

## Decision

1. **Package `@kernelpai/memory`** (store, parser, guard, injection, proposal extraction).
   Files live under `$KPAI_HOME`, outside every tool jail:
   - user: `memory/user.md`;
   - project: `projects/<sha256(realpath)[0:16]>/memory.md`;
   - session: `memory/sessions/<sessionId>.md`;
   - pending proposals: `memory/pending.json`, which is machine state and not edited by hand.
2. **Format.** Optional front matter, free prose, and one list item per fact. Provenance is
   a trailing comment, invisible when the Markdown is rendered:
   `- Use pnpm <!-- kpai id=m-1a2b3c4d source=human date=2026-10-23 evidence=run:…,node:… confirmed=… edited=… local-only -->`.
   Values are percent-encoded outside `[A-Za-z0-9._:/@+=-]`. The parser keeps every line
   it does not understand and reports it with its line number. An item without the comment
   is a fact the human wrote, with an id derived from its text so it stays stable. A comment
   without a source reads as `unknown`, which is untrusted. Unknown attributes are kept.
3. **Who writes what.** A human uses `add`, `edit` and `remove`, with source `human`. A
   model can only `propose`: the proposal goes to the pending queue, and only `confirm`
   by a human stores it. The stored fact keeps the model as its source and adds
   `confirmed=<date>`. A `no`, a timeout or the absence of a human leaves the proposal
   pending. Nothing is ever accepted automatically.
4. **Guard before storing.** The text is reduced to one printable line, without comment
   markers. A fact is refused when one of its words hits the zone set in force: credential
   and added tiers on any word, the name heuristics only on path-shaped words. The text is
   then redacted with `@kernelpai/tools`' `redact`, including the environment's secret
   values. The guard runs again at `confirm`, because the zones may have changed since the
   proposal.
5. **Injection.** Each plan builds one `user` message of data, never a `system` message.
   It goes after the R-306 rules on every node and also to the model planner.
   - The header names its sources. Human facts are under `trust="user"`. Model facts,
     even confirmed ones, and repository facts are under `trust="untrusted"`.
   - The order is deterministic: user-trusted facts first, then by layer (user, project,
     session, repository), then by date and id.
   - The budget is `KPAI_MEMORY_TOKENS` (default 2000, 4 characters per token, `0` turns
     memory off). The first fact that does not fit stops the selection. The message and
     the plan both say how many facts were left out.
   - The plan, `plan` result, `kpai plan` and the run's `routing` journal entry show
     counts, ids and sources, never the text.
   - When `$KPAI_HOME` is inside the workspace, model tools could have written the files,
     so every fact is labelled untrusted and the plan says so.
6. **Local-only.** The nodes carry the cloud version of the message, which omits
   `local-only` facts and says how many were withheld. The run's adapter resolver swaps in
   the full version only for adapters whose descriptor is `kind: local`; `cloud`,
   `aggregator` and `test` never get it. Exports to the repository leave them out.
7. **Proposals.** A node may end with a ` ```memory ` block of `- [project|user|session,
local-only] fact` items. The kernel reads only successful nodes of runs that were not
   cancelled. It keeps at most 5 items per node and 10 per run, each at most 300
   characters, and records the author model, `run:` and `node:` as provenance. It journals
   the ids and refusals, then asks one `confirm.request` of kind `memory` per proposal
   after the run is done.
8. **Front ends.** Protocol `memory.list|add|edit|remove|pending|confirm|reject` with
   zod-validated results. `confirm.request` gains kind `memory` and a `memory` field. CLI:
   `kpai memory [list|add|edit|rm|pending|confirm|reject|export] [--layer user|project]`.
   `export` writes `.kpstudio/memory.md` after a checkpoint and refuses symlinks. The file
   is read back like the R-306 rule files: no symlink, at most 64 KiB, every fact screened
   and untrusted, and facts identical to the local project layer are not repeated.

## Consequences

- Any provider gets the same memory, and switching provider loses nothing (§3.1).
- The proposal hint and the facts add input tokens to every call. The hint is kept under
  80 tokens as the memory budget counts them (characters ÷ 4; 315 characters, 79 tokens;
  `PROPOSAL_HINT_MAX_TOKENS`, tested): S8 measured the first wording at 107 tokens (427
  characters), and it was shortened without dropping a rule. The estimate includes both,
  because it is made on the graph as it will run.
- A human's "no" in the console leaves a proposal pending rather than rejecting it.
  Rejecting it is an explicit action (`memory.reject`).
- A model that writes `.kpstudio/memory.md` through the tools reaches later runs only as
  untrusted data.

## Revisit when

Relevance selection per node (embeddings or tags) replaces "all facts within the budget";
a real tokenizer per model; facts shared by a team (phase 8). (`$KPAI_HOME/memory/**` as an
added zone for workspaces that contain `$KPAI_HOME`: done in the kernel, ADR-0030.)
