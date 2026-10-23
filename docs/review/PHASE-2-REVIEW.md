# Phase 2 gate review register

Reviewer: independent sub-agent (built none of phase 2), appointed by the PO under charter §4.
Reviewed: 8d9cf04. Re-verifications at 8aa8908, 94ab19e and 6bfb8ee (final: **PASS**).
Process: review → PO disposition (D-014) → fix with regression test → re-verify.

## Initial review (at 8d9cf04): 5 High, 7 Medium, 6 Low

| ID  | Sev.   | Finding                                                                          | Outcome                                                                                                                 |
| --- | ------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| F1  | High   | The patch the user reviews is not the patch that gets applied                    | Fixed: patches with control characters are refused; what is shown is byte-for-byte what is applied                      |
| F2  | High   | Binary and header-only patch sections skip the target check and are misreported  | Fixed: every section checked; binary, executable and symlink modes refused unless allowed                               |
| F3  | High   | The critic's rejection can be read as approval                                   | Fixed (N3 residual fixed at 652a8d8): conflicting verdicts are compared on acceptance                                   |
| F4  | High   | Patches from nodes no critic reviewed are applied                                | Fixed: only `approved === true` code/test nodes; code and test nodes are always author_critic                           |
| F5  | High   | CI red on macOS and Windows; jail refused in-root paths through a symlinked root | Fixed: jail at c2b299d; Windows CI at 94ab19e (shell argument check)                                                    |
| F6  | Medium | Ctrl+C on a graph still writes patches                                           | Fixed: no apply after a cancel                                                                                          |
| F7  | Medium | One keystroke answers several concurrent confirmations                           | Fixed: confirmations are serialised                                                                                     |
| F8  | Medium | The planner call bypasses the budget; `kpai plan` spends money                   | Fixed: planner behind a budget gate; dry run says what it spends                                                        |
| F9  | Medium | The graph estimate under-counts, so the graph can pass the threshold silently    | Fixed: per-role estimate, dependency allowance (N1 regression fixed at 652a8d8), whole-graph cap `maxGraphUsd`          |
| F10 | Medium | Secret files go to cloud models; no user zones                                   | Fixed: default forbidden zones, `policy.json`, redaction; git output filtered (N2, NF-1 fixed at 94ab19e, 6bfb8ee)      |
| F11 | Medium | Code requests fail on local models without tool support                          | Fixed: tool-less models are routable with tools dropped and said                                                        |
| F12 | Medium | Escape sequences in patch file names reach the terminal                          | Fixed: names sanitised; bidi overrides refused (N5 at d71e4bf)                                                          |
| F13 | Low    | Read-risk git tools run programs from repository config                          | Fixed: filters blanked, external diff cleared, `GIT_*` dropped; submodules (N4) and hooks (NF-2) at 94ab19e and 6bfb8ee |
| F14 | Low    | One write confirmation covers other models and paths                             | Fixed: batch key includes the model; prompt previews content                                                            |
| F15 | Low    | `--yes` covers budget and writes                                                 | Fixed: writes need `--yes-apply`                                                                                        |
| F16 | Low    | Transparency gaps                                                                | Fixed: reason line shown; plan names the real reviewer; incomplete plans are not run                                    |
| F17 | Low    | Tests that pass with the feature broken                                          | Fixed: approval and apply tests fail when the guard is removed                                                          |
| F18 | Low    | Governance and specification drift                                               | Fixed: D-012, D-013, D-014 logged                                                                                       |

## Re-verification 1 (at 8aa8908)

All High findings confirmed fixed except F5's CI part (Windows red). New: N1 (Medium,
regression: the dependency allowance made small-context local models unroutable), N2
(Medium, F10 residual: `git.diff` showed forbidden-zone files), N3 (Low, F3 residual), N4
(Low, F13 residual: submodule filters ran on `git.status`), N5 (Low: bidi patches shown before
refusal), N6 (Low: workspace guard ran after a paid planner call). All fixed: N1/N3 652a8d8,
N5/N6 d71e4bf, N2/N4 and Windows CI 94ab19e.

## Re-verification 2 (at 94ab19e): HOLD

N1, N3, N4, N5, N6 and Windows CI confirmed. New: **NF-1 (High)** — files under a forbidden
_directory_ (`config/secrets/…`) leaked through `git.diff` when the user or repository sets
`diff.noprefix` or `diff.mnemonicPrefix`, because the pathspec layer did not cover directory
contents and the output filter kept headers it could not parse. **NF-2 (Medium)** —
`git.status` rewrote a stale index and so ran the repository's `post-index-change` hook.
Fixed at 6bfb8ee: directory pathspecs, forced `a/ b/` prefixes, fail-closed filter, hooks
path to a missing directory, `--no-optional-locks`; regression tests fail on 94ab19e.

## Re-verification 3 (at 6bfb8ee): PASS

NF-1 and NF-2 fixed; bypass attempts (relative diffs, colour, quoted and non-ASCII paths,
staged diffs, pathspec magic in model paths, hostile `~/.gitconfig`) failed. `pnpm check`
green (745 tests), three demos pass, CI green on Windows, Linux and macOS.

## Residuals (backlog)

- B-18 — LRM/RLM/ALM marks (U+200E, U+200F, U+061C) are accepted in patches; they are marks, not overrides (nit).
- B-19 — Once an isolating shell sandbox ships, allow-listed `git diff` / `git log` through `shell.run` bypass zone filtering: route them to the filtered git tools or hide zones in the sandbox.
- B-20 — The policy glob matcher treats `[...]` literally, git as a character class; the output filter still catches such files.
