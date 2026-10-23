/**
 * English catalogue, part 4: the phase 4 review follow-ups (D-024) — replay estimated
 * before it runs and cancellable (P4-F5), routing inherited by replay and fork (P4-F2),
 * dispute options shown in full or refused (P4-F11), revised verdicts as the review
 * headline (P4-F12) and the local-only rule of the plan's memory (P4-F3).
 */
export const enReview = {
  'replay.note':
    'Pick a model, a protocol or both, then estimate: nothing is spent until you press Run replay. Code nodes keep a critic from another provider.',
  'replay.noteRun':
    'Nothing is spent yet. Run replay runs this estimate once, through the budget gate, and you can cancel it while it runs. Changing the model or protocol asks for a new estimate.',
  'replay.estimate': 'Estimate the replay',
  'replay.estimating': 'Estimating…',
  'replay.run': 'Run replay (cap {cap})',
  'replay.estimateTitle': 'Before anything is spent',
  'replay.routingLocalRun': 'Local models only (from the original run).',
  'replay.routingLocalYours': 'Local models only (your setting).',
  'replay.routingExcludeRun': 'Providers excluded (from the original run): {providers}.',
  'replay.routingExcludeYours': 'Providers excluded (your setting): {providers}.',
  'replay.routingOpen': 'No provider restriction from the original run.',
  'replay.routingProfile': 'Routing profile: {profile}.',
  'replay.scopeProblem': 'Scope problem, the replay cannot run: {problem}',
  'replay.cancel': 'Cancel replay',
  'replay.cancelling': 'Cancelling the replay of #{id}…',
  'replay.announce.planned':
    'Replay of node {id} estimated: likely {expected}, cap {cap}. Nothing spent yet.',
  'replay.announce.cancelling': 'Cancelling the replay of node {id}',
  'replay.announce.cancelled': 'Replay of node {id} cancelled',
  'fail.replayPlan': 'Replay could not be estimated: {error}',
  'verify.revised': {
    one: '1 revised verdict',
    other: '{count} revised verdicts',
  },
  'verify.perRevised': '{cost} per revised verdict',
  'verify.noRevised': 'no revised verdict',
  'verify.rawIssues': 'raw issues raised: {count}',
  'productivity.reviewValue':
    '{review} spent · revised verdicts: {count} ({per} each) · raw issues raised: {issues}',
  'plan.memoryLocalOnlyRule': 'Local-only rule: {rule}',
  'dispute.truncated': 'This answer was cut by the kernel: it cannot be chosen.',
  'tui.disputeKeys': {
    one: '1 = pick the answer, ] and [ = scroll it, then y = choose it · n, Esc or Enter = reject all (default)',
    other:
      '1–{count} = pick an answer, ] and [ = scroll it, then y = choose it · n, Esc or Enter = reject all (default)',
  },
  'tui.disputePicked': {
    one: 'Answer {n} picked: {label} (1 line). Press y to choose it.',
    other: 'Answer {n} picked: {label} ({count} lines). Press y to choose it.',
  },
  'tui.disputePickedLong': {
    one: 'Answer {n} picked: {label}. Read it to the end with ] before choosing it with y (1 line).',
    other:
      'Answer {n} picked: {label}. Read it to the end with ] before choosing it with y ({count} lines).',
  },
  'tui.disputeWindow': 'Answer {n}: lines {from}–{to} of {total} · ] next · [ previous',
  'tui.disputeRead': 'Answer {n} read to the end. Press y to choose it.',
  'tui.disputeReadFirst':
    'Read answer {n} to the end first ({seen} of {total} lines shown): press ] to scroll.',
  'tui.disputeTruncated':
    'Answer {n} was cut by the kernel and cannot be chosen. Pick another, or press n to reject all.',
} as const;
