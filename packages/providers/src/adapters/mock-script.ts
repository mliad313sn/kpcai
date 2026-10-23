import type { ChatRequest, ToolCall, Verdict } from '@kernelpai/core';
import { parseToolInput } from '../tool-calls.js';
import { creationDiff, defaultPlan, jsonMarker, plannerRequest } from './mock-plan.js';

/** What the mock answers: streamed text, or one tool call. */
export type MockReply = { kind: 'text'; text: string } | { kind: 'tool'; call: ToolCall };

type Role = 'planner' | 'critic' | 'author' | 'judge' | 'voter';

/** Where markers are read from (see MockAdapter for the syntax). */
interface Scope {
  provider: string;
  model: string;
  /** System messages + the last user message: role and scripting markers. */
  markers: string;
  lastUser: string;
  /** Every message: used for `[[revised]]` and prior critiques. */
  all: string;
  /** Content of the last `tool` message after the last user message, if any. */
  toolResult: string | undefined;
}

function scopeOf(req: ChatRequest, provider: string): Scope {
  const lastUserAt = req.messages.findLastIndex((m) => m.role === 'user');
  const lastUser = req.messages[lastUserAt]?.content ?? '';
  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
  const after = req.messages.slice(lastUserAt + 1).filter((m) => m.role === 'tool');
  return {
    provider,
    model: req.model,
    markers: [...system, lastUser].join('\n'),
    lastUser,
    all: req.messages.map((m) => m.content).join('\n'),
    toolResult: after.at(-1)?.content,
  };
}

/** The role marker: first `Role: <role>` in the system messages, else in the last user message. */
function roleOf(req: ChatRequest, scope: Scope): Role | undefined {
  const re = /Role: (planner|critic|author|judge|voter)\b/;
  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
  const m = re.exec(system.join('\n')) ?? re.exec(scope.lastUser);
  return m?.[1] as Role | undefined;
}

/** `[[<tag>:<value>]]` / `[[<tag>:<value>@<provider>]]`: the first value aimed at this provider. */
function targeted(text: string, tag: string, provider: string): string | undefined {
  const re = new RegExp(`\\[\\[${tag}(?::([^@\\]]*))?(?:@([a-z0-9-]+))?\\]\\]`, 'g');
  for (const m of text.matchAll(re)) if (!m[2] || m[2] === provider) return m[1] ?? '';
  return undefined;
}

function planner(scope: Scope): string {
  const marker = jsonMarker(scope.markers, 'plan:');
  if (marker?.json) return marker.json;
  const plan = defaultPlan(plannerRequest(scope.lastUser));
  return JSON.stringify(plan);
}

function critic(scope: Scope): string {
  const reject =
    targeted(scope.markers, 'reject', scope.provider) !== undefined &&
    !scope.all.includes('[[revised]]');
  const verdict: Verdict = reject
    ? {
        approve: false,
        issues: [{ severity: 'major', text: `mock critic ${scope.provider}: please revise` }],
        summary: 'Changes required (mock rejection).',
      }
    : { approve: true, issues: [], summary: `Approved by mock critic ${scope.provider}.` };
  return JSON.stringify(verdict);
}

/** Judge reply in the orchestrator's format: winner 1 or 2 (`[[judge:2]]` picks the second). */
function judge(scope: Scope): string {
  const pick = /\[\[judge:([12])\]\]/.exec(scope.markers);
  const winner = pick ? Number(pick[1]) : 1;
  return JSON.stringify({ winner, reason: `mock judge picked answer ${winner}` });
}

/** Voter reply in the orchestrator's format: `{"choice": …}`. */
function voter(scope: Scope): string | undefined {
  const forced = targeted(scope.markers, 'vote', scope.provider)?.trim();
  const line = /^Options:\s*(.+)$/m.exec(scope.markers);
  const first = line?.[1]
    ?.split('|')
    .map((o) => o.trim())
    .find((o) => o.length > 0);
  const choice = forced || first;
  return choice ? JSON.stringify({ choice, reason: `mock voter ${scope.provider}` }) : undefined;
}

function toolCall(scope: Scope): MockReply | undefined {
  const marker = jsonMarker(scope.markers, 'tool:', /^[a-zA-Z0-9_.-]{1,64}/);
  if (!marker?.head) return undefined;
  const input = parseToolInput(scope.provider, marker.head, marker.json ?? '');
  return { kind: 'tool', call: { id: 'mock_call_1', name: marker.head, input } };
}

/** A critique is in the conversation: a verdict JSON key or the word "critique". */
function hasCritique(req: ChatRequest): boolean {
  return req.messages.some(
    (m) => m.role !== 'system' && /"approve"\s*:|\bcritique\b/i.test(m.content),
  );
}

function roleReply(role: Role | undefined, scope: Scope): string | undefined {
  if (role === 'planner') return planner(scope);
  if (role === 'critic') return critic(scope);
  if (role === 'judge') return judge(scope);
  if (role === 'voter') return voter(scope);
  return undefined;
}

/**
 * The scripted answer for this request, or undefined for the default echo.
 * Precedence: planner/critic/judge/voter role → tool result answer → `[[tool:…]]`
 * call → `[[diff:…]]` → revised author → echo.
 */
export function scriptedReply(
  req: ChatRequest,
  provider: string,
  echo: string,
): MockReply | undefined {
  const scope = scopeOf(req, provider);
  const role = roleOf(req, scope);
  const text = (t: string): MockReply => ({ kind: 'text', text: t });
  const scripted = roleReply(role, scope);
  if (scripted !== undefined) return text(scripted);
  if (scope.toolResult !== undefined) {
    return text(`[mock/${scope.model}] tool said: ${scope.toolResult.slice(0, 80)}`);
  }
  const call = toolCall(scope);
  if (call) return call;
  const revised = role === 'author' && hasCritique(req);
  const diff = /\[\[diff:([^\]\s]+)\]\]/.exec(scope.markers);
  if (diff?.[1]) return text(creationDiff(diff[1], scope.model, revised));
  if (revised) return text(echo.replace('] ', '] [[revised]] '));
  return undefined;
}
