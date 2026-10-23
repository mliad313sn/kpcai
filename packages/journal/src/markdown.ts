import type { JournalEvent, SessionRow } from './types.js';

function summarize(e: JournalEvent): string {
  const p = e.payload;
  switch (e.type) {
    case 'routing':
      return `routed to \`${e.provider}/${e.model}\` — ${String(p['reason'] ?? '')}`;
    case 'call':
      return `call sent (~${String(p['estimatedInputTokens'] ?? '?')} input tokens)`;
    case 'response':
      return `response: ${String(p['outputTokens'] ?? '?')} output tokens, stop=${String(p['stopReason'] ?? '?')}`;
    case 'intervention':
      return `human: ${String(p['action'] ?? '')}`;
    case 'error':
      return `error (${String(p['kind'] ?? '?')}): ${String(p['message'] ?? '')}`;
    default:
      return e.type;
  }
}

function cost(c: number | null): string {
  return c === null ? '' : ` · $${c.toFixed(6)}`;
}

/** Renders a session journal as readable Markdown for review or archiving (spec §3.5). */
export function sessionToMarkdown(session: SessionRow, events: readonly JournalEvent[]): string {
  const lines = [
    `# KernelPAI session ${session.id}`,
    '',
    `- Title: ${session.title}`,
    `- Started: ${session.createdAt}`,
    `- Directory: \`${session.cwd}\``,
    `- Events: ${events.length}`,
    `- Total cost: $${session.costUsd.toFixed(6)}`,
    '',
    '## Timeline',
    '',
  ];
  for (const e of events)
    lines.push(`- \`${e.ts}\` **${e.type}** ${summarize(e)}${cost(e.costUsd)}`);
  const answer = events.find((e) => e.type === 'response')?.payload['text'];
  if (typeof answer === 'string' && answer.length > 0) {
    lines.push('', '## Answer', '', answer);
  }
  return lines.join('\n') + '\n';
}
