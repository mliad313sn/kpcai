/**
 * English messages of the `kpai` CLI (WI-S6-02). Whole sentences with named `{params}`;
 * command names, flags and values stay as typed. Kernel and model text is never here.
 */
export const en = {
  usage: `KernelPAI (phase 3)

Usage:
  kpai do <request>                    Plan a task graph, show who does what and the cost,
                                       run it with cross-provider review, show patches
  kpai plan <request>                  The same plan and estimate, dry run
      [--planner template|model] [--apply] [--yes-apply] [--allow-same-provider]
      [--isolated]  run in its own git worktree, merged back on confirmation
      [--scope <file>]  authorised scope (YAML/JSON) for packs that require one
      --yes accepts cost prompts only; writes need --yes-apply or a y at the prompt
  kpai checkpoints [--session <id>]   Checkpoints taken before writes, by run
  kpai restore <ref>                   Restore a checkpoint (always asks; undo printed)
  kpai merge <run-id>                  Merge an isolated run's worktree (asks with the diff)
  kpai discard <run-id>                Remove an isolated run's worktree
  kpai pack list|show|detect|check|init  Domain packs (see kpai pack help)
  kpai grade <run> <node> good|bad [note] [--author name]  Grade a node's work by hand
  kpai bench [--per-kind N]            Short calibration on this repository (asks before spending)
  kpai memory [list|add|edit|rm|pending|confirm|reject|export] [--layer user|project]
                                       Memory with provenance; models only propose, you confirm
  kpai tools                           Tools models can use, their risk and source
  kpai studio [--port N] [--allow-test] Start KP Studio's local kernel server, print its URL
                                       (--allow-test: offline mock providers by default)
  kpai run <request>                   Classify, route by competence, budget-check,
                                       run with automatic fallback, journal everything
  kpai route <request>                 Same plan and routing, dry run (nothing sent)
      [--type T] [--criticality low|normal|critical] [--profile economy|balanced|performance]
      [--local-only] [--exclude p1,p2] [--max-tokens N] [--yes] [--over-budget]
      [--new-session] [--allow-test] [--verbose]          --allow-test lets routing use offline mock providers
  kpai stats [--session <id>]          Fallback rate, cost per task, estimate error, router latency
      [--productivity [--since <ISO date>]]  Cost and time per accepted change, rollback and
                                       rework rates, review yield (from the journal only)
  kpai replay <run> <node> [-m provider/model] [--protocol P]
                                       Rerun one finished node beside the original (writes nothing)
  kpai fork <run> <node> [-m provider/model] [--instruction <text>]
                                       Rerun from a node, reusing what came before (like kpai do)
  kpai providers                       Detect providers and list models
  kpai ask -m <provider/model> <text>  Send one request, stream, journal it
      [--system <text>] [--max-tokens N] [--yes]
  kpai log [--session <id>] [--limit N] List sessions, or one session's events
  kpai export <session> [--out file]   Export a session as Markdown
  kpai verify                          Check the journal hash chain

Global: --db <path> (default $KPAI_HOME/journal.db, KPAI_HOME=~/.kernelpai)
        --lang en|fr (default $KPAI_LANG, then LC_ALL, LC_MESSAGES, LANG)
`,
  'error.usage': '{message}\n\n{usage}',
  'error.nodeNeedsArgs': 'replay and fork need a run id and a node id',
  'error.gradeNeedsArgs': 'kpai grade needs a run id, a node id and good or bad',
  'error.provider': 'error ({kind}): {message}\n',
  'error.generic': 'error: {message}\n',
  'error.unknownCommand': 'Unknown command "{command}"',
  'error.unknownOption': 'Unknown option {option}',
  'error.badArguments': 'Invalid arguments: {detail}',
  'error.lang': '--lang must be en or fr, not "{value}"',
  'error.positiveInt': '--{name} must be a positive integer',
  'error.port': '--port must be a port number (0 picks a free one)',
  'error.oneOf': '--{name} must be one of {allowed}',
  'error.graphNeedsRequest': 'plan/do need a request',
  'error.runNeedsRequest': 'run/route need a request',
  'error.askNeedsPrompt': 'ask needs a prompt',
  'error.exportNeedsSession': 'export needs a session id',
  'error.restoreNeedsRef': 'restore needs a ref',
  'error.mergeNeedsRunId': 'merge needs a run id',
  'error.discardNeedsRunId': 'discard needs a run id',
  'plan.header': 'plan   {count} node(s) · {createdBy}: {reason}',
  'plan.unroutable': 'unroutable ({error})',
  'plan.noCandidate': 'no candidate',
  'plan.total': 'total  likely {likely} · at most {cap} (cap) before running',
  'plan.totalBlocked':
    'total  likely {likely} · at most {cap} (cap) before running (cannot run as planned: {problems})',
  'confirm.prompt': '{question} [y/N] ',
  /** Answers that mean yes, comma-separated (anything else is no). */
  'confirm.yesWords': 'y, yes',
  'prod.header': 'productivity here (from the journal only; see docs/metrics/PRODUCTIVITY.md)',
  'prod.since': '  runs started since {since}',
  'prod.runs': '  {runs} run(s) · spent {spent} · run time {time}',
  'prod.changes':
    '  changes: {accepted} accepted · {declined} declined · {failed} failed · {pending} pending · {discarded} discarded',
  'prod.perChange': '  per accepted change: {cost} · {time}',
  'prod.perChangeNone': '  per accepted change: – (no accepted change yet)',
  'prod.rework':
    '  rolled back {rolledBack} ({rollbackRate}) · reworked {reworked} ({reworkRate}) within {days} day(s) · restores not attributed: {unattributed}',
  'prod.review':
    '  review {usd} for {findings} accepted finding(s), {each} each · {issues} issue(s) raised on {nodes} node(s)',
  'prod.band': '  billed cost inside the approved band: {inBand}/{runs} finished run(s) ({rate})',
  'error.productivityInvalid': 'kpai stats --productivity: {message}',
  'confirm.budget': 'Expected cost {expected} is above your threshold {threshold}. Continue?',
} as const;
