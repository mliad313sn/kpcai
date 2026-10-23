# ADR-0027 — Unified memory: layers, provenance, propose → confirm, budgeted injection

**Status:** Accepted by the PO (proposed by S1; phase 4 WP1, spec §3.1) · **Date:** 2026-10-23 · amended by S7 after review P4 (§6, §9)

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
6. **Local-only** (amended after review P4-F3). The nodes carry the cloud version of the
   message, which omits `local-only` facts and says how many were withheld. The run's
   adapter resolver swaps in the full version only for adapters whose descriptor is
   `kind: local`; `cloud`, `aggregator` and `test` never get it. Exports to the repository
   leave them out. A local model may quote a fact it was given, so when local-only facts
   exist:
   - **Taint.** A node is tainted from its first model call to a `kind: local` provider (a
     journaled `call`), and so is every node that depends on it, directly or not. Every
     later step of a tainted node (critics, judges, voters, revisions, retries) is routed
     with `localOnly`, through the orchestrator's `nodeConstraints` hook; a fixed decision
     (a retry on the same model) is kept to the candidates that meet it. When no local
     provider can serve the step, also because principle 2 needs another provider, the step
     fails closed with the reason. Nobody is asked to waive it.
   - **Redaction (defence in depth).** Every message sent to a provider that is not
     `kind: local`, and every journal payload of the run (calls, responses, errors, tool
     calls and results, node records), has each quote of a local-only fact replaced by
     `[local-only fact withheld]`. A quote is the whole fact, or any run of at least 24
     characters of it, with whitespace normalised and case ignored. Facts shorter than 6
     characters are not redacted.
   - **Proposals.** A proposal from a tainted node is queued as local-only, whatever the
     model tagged.
   - **Plan.** The memory summary carries `localOnlyRule` (journaled with the plan), and
     the plan prints the rule.

   **Guaranteed:** whenever a plan carries local-only facts, no request its run makes to a
   non-local provider contains one verbatim, or any 24-character run of one, and the run's
   journal holds none of them either. A tainted node and its dependents never reach a
   non-local provider through routing. The same wiring (`runDeps`) serves runs, forks and
   replays. A replay or fork reruns the recorded messages (cloud version only) and is given
   today's memory for the local swap, the redactor and the journal wrapper; it starts from
   the taint of the recorded nodes it reads (addendum P4-R1).
   **Not guaranteed:** a paraphrase, a translation, an encoding, or a quote shorter than
   24 characters (for example a host name alone) in a local model's output. Only the taint
   stops those, and it covers what the run routes. Patches, artifacts, run results and the console stay on this machine and are
   not redacted.

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
9. **Provenance is data, never prompt text** (review P4-F1, F7, F8).
   - The parser validates what it decodes: `source` is `human` or `provider/model`;
     `date`, `confirmed` and `edited` are real days; evidence is `run:`, `node:` or `event:`
     and printable. An invalid value is dropped and reported as a problem, quoted encoded.
   - Every tag put in a prompt is reduced to `[A-Za-z0-9._:/@+-]`.
   - A repository file's provenance is ignored: `source=repository`, no date, no evidence,
     never local-only.
   - Every fact is screened again as it is injected: zones, the environment's secret
     values, cleaning and the size cap. Refused facts are counted in the plan's problems.
   - Repository facts are redacted with the environment's secret values.
   - Zone mentions are also matched on words cut at `=:@`, percent-decoded and lower-cased.

   **Addendum P4-R1 (replay and fork).** A tainted node's `node recorded` event carries
   `localTaint: true`. A replay or fork reads it, and, once there is something to protect
   (a marked record, or local-only facts today), also counts as tainted every recorded node
   a local or no-longer-known provider contributed to (journals from before the mark). A
   fork seeds the taint with the tainted nodes it reuses, so the nodes it reruns after them
   stay local or fail closed. A replay whose recorded input is tainted is planned and run
   with `localOnly` (said in the plan), or is refused as unroutable when no local provider
   is left. The fork's estimate still prices tainted reruns on routed (possibly cloud)
   models; the run itself is held local.

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
