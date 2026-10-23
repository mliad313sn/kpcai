# ADR-0023 — Two-tier forbidden zones and pack relaxations

**Status:** Accepted by the PO (phase 3, D-020 WI-S7-01, WI-S5-01; implemented by S7 in 153d649) · **Date:** 2026-10-23

## Context

Phase 2 made forbidden zones hold at every exit: `fs.*`, git pathspecs, the git output
filter and shell path arguments (review N2, NF-1, NF-2). The adoption audit (S9, F2) then
showed the default name heuristics `**/*secret*` and `**/credentials*` block legitimate
work. They hit detection rules, CTF write-ups, policy documents and `.env.example`, and
`*.key` hit Apple Keynote files. Security and infosec users, the very people who handle
such names, could not use the product. Removing the heuristics would reopen what phase 2
closed.

## Decision

1. **Two tiers.**
   - **Credential zones** never move. They cover env files, key material, ssh/aws/gnupg/azure/kube/gcloud folders, kubeconfig, credential dotfiles and named credential files. No policy option, pack or approval relaxes them, and every zone set built anywhere includes them.
   - **Name heuristics** can be relaxed: `**/*secret*`, `**/credentials*`.
2. **Two exemptions inside the credential tier.**
   - Exact `.env.example`, `.env.sample` and `.env.template` are allowed, because by convention they are committed placeholders.
   - A `*.key` item is allowed only when a bounded, jailed content check finds Keynote structure (64 KiB head and tail, no symlink following, any doubt means forbidden). Git and workspace layers cannot read content, so they stay name-based.
3. **Pack relaxations.** A relaxation applies only when all of these hold:
   - the pack is enabled;
   - the user approved that exact relaxation (`relaxKey`);
   - the relaxation is anchored at a literal root folder and names no credential pattern;
   - it was journaled first.

   Without a journal it is refused (fail closed). Pack additions always apply and are never relaxable.

4. **One `ZoneSet`** drives the policy, git pathspecs, the git output filter, shell path checks, rules reading, checkpoints and merge-back. Refusals name the tier and the next step.
5. **Redaction of secret-shaped content stays on for every output**, whatever the zones.

## Consequences

- Security, infosec and reverse-engineering packs can open their own folders without weakening credential protection. Red-team tests cover relaxations aimed at `.env`, `id_rsa`, `.aws`, PEM keys and `.ssh`.
- Some legitimate files stay blocked for good, for example a Helm `templates/secrets.yaml` or a venv named `.env`. That is the price of an immovable tier.
- While a relaxation is active, the heuristic globs leave the git pathspecs and only the fail-closed output filter applies to them. This is accepted because the credential tier keeps both layers.
- Keynote files stay hidden from git output and are skipped by checkpoint restore. Backlog: move the tier constants into core so `@kernelpai/packs` and tools share one definition (S7 open item).
