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
  'confirm.budget': 'Expected cost {expected} is above your threshold {threshold}. Continue?',
} as const;
