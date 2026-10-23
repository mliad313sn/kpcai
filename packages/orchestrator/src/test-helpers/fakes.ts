import {
  BaseAdapter,
  ProviderDescriptorSchema,
  ProviderError,
  type Candidate,
  type ChatRequest,
  type DetectResult,
  type GraphEvent,
  type GraphNode,
  type ModelRef,
  type StreamEvent,
  type TaskGraph,
  type ToolBus,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
  type TaskType,
} from '@kernelpai/core';
import { Journal } from '@kernelpai/journal';
import { CompetenceRouter } from '@kernelpai/router';
import type { OrchestratorOptions } from '../types.js';

/** What a scripted model answers: plain text, or a list of stream steps. */
export type Reply =
  | string
  | Array<
      | { text: string }
      | { tool: ToolCall }
      | { end: 'end' | 'tool_use' | 'max_tokens' }
      | { fail: ProviderError['kind'] }
      | { hang: true }
      | { delay: number }
    >;

export interface Seen {
  role: string;
  prompt: string;
  req: ChatRequest;
  /** Calls this adapter received so far for this role (0-based). */
  n: number;
}

export type Script = (seen: Seen) => Reply;

/** The `Role: <role>` line of the last user message. */
export function roleOf(req: ChatRequest): string {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  return /^Role: (\w+)/m.exec(lastUser?.content ?? '')?.[1] ?? 'none';
}

/** One provider with one model, answering from a script keyed by the prompt's role line. */
export class RoleAdapter extends BaseAdapter {
  readonly seen: Seen[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    id: string,
    private readonly script: Script,
    competence: Partial<Record<TaskType, number>> = {},
    price = { inputPerMTok: 1, outputPerMTok: 2 },
    card: { contextWindow?: number; maxOutput?: number } = {},
  ) {
    super(
      ProviderDescriptorSchema.parse({
        id,
        name: id,
        kind: 'cloud',
        adapter: 'scripted',
        jurisdiction: 'US',
        retention: 'none',
        models: [
          {
            id: 'm',
            contextWindow: 100_000,
            maxOutput: 1000,
            modalities: ['text', 'code'],
            price,
            latencyMsTypical: 1000,
            competence,
            ...card,
          },
        ],
      }),
    );
  }

  get ref(): ModelRef {
    return { provider: this.descriptor.id, model: 'm' };
  }

  get candidate(): Candidate {
    return { ref: this.ref, providerKind: 'cloud', jurisdiction: 'US', card: this.card('m') };
  }

  detect(): Promise<DetectResult> {
    return Promise.resolve({ available: true, reason: 'scripted' });
  }

  protected async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const role = roleOf(req);
    const n = this.seen.filter((s) => s.role === role).length;
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const seen: Seen = { role, prompt: lastUser?.content ?? '', req, n };
    this.seen.push(seen);
    const reply = this.script(seen);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      yield* play(this.descriptor.id, reply, signal);
    } finally {
      this.active--;
    }
  }
}

async function* play(id: string, reply: Reply, signal: AbortSignal): AsyncIterable<StreamEvent> {
  const steps = typeof reply === 'string' ? [{ text: reply }, { end: 'end' as const }] : reply;
  for (const step of steps) {
    if ('text' in step) yield { type: 'text', delta: step.text };
    else if ('tool' in step) yield { type: 'tool_call', call: step.tool };
    else if ('end' in step) {
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } };
      yield { type: 'end', stopReason: step.end };
    } else if ('fail' in step) throw new ProviderError(step.fail, id, `scripted ${step.fail}`);
    else if ('delay' in step) await new Promise((r) => setTimeout(r, step.delay));
    else await new Promise((resolve) => signal.addEventListener('abort', resolve));
  }
}

export const verdict = (approve: boolean, major = !approve): string =>
  JSON.stringify({
    approve,
    issues: major ? [{ severity: 'major', text: 'missing check' }] : [],
    summary: approve ? 'fine' : 'needs work',
  });

/** Default behaviour per role: answers that satisfy every protocol. */
export const friendly =
  (name: string): Script =>
  ({ role, n }) => {
    if (role === 'critic') return '```json\n' + verdict(true) + '\n```';
    if (role === 'judge') return JSON.stringify({ winner: 1, reason: 'clearer' });
    if (role === 'voter') return JSON.stringify({ choice: 'x' });
    return `${name}:${role}:${n}`;
  };

export class FakeToolBus implements ToolBus {
  readonly calls: Array<{ call: ToolCall; ctx: ToolContext }> = [];

  constructor(
    private readonly defs: ToolDefinition[],
    private readonly deny: string[] = [],
  ) {}

  list(): readonly ToolDefinition[] {
    return this.defs;
  }

  call(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    this.calls.push({ call, ctx });
    if (call.name === 'boom') return Promise.reject(new Error('bus exploded'));
    if (this.deny.includes(call.name)) {
      return Promise.resolve({ content: `permission denied: ${call.name}`, isError: true });
    }
    return Promise.resolve({ content: `result of ${call.name}`, isError: false });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export const toolDef = (name: string, risk: ToolDefinition['risk'] = 'read'): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  risk,
  source: 'builtin',
});

export function gnode(over: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'n1',
    title: 'Node',
    type: 'analysis',
    protocol: 'solo',
    dependsOn: [],
    criticality: 'normal',
    messages: [{ role: 'user', content: 'Do the thing' }],
    ...over,
  };
}

export function graph(nodes: GraphNode[]): TaskGraph {
  return { id: 'g1', request: 'req', nodes, createdBy: 'template', reason: 'test' };
}

export interface Setup {
  options: OrchestratorOptions;
  journal: Journal;
  events: GraphEvent[];
  sessionId: string;
}

/** Real router + in-memory journal over the given adapters. */
export function setup(adapters: RoleAdapter[], over: Partial<OrchestratorOptions> = {}): Setup {
  const journal = Journal.open(':memory:');
  const sessionId = journal.startSession('test', '/tmp');
  const events: GraphEvent[] = [];
  const byId = new Map(adapters.map((a) => [a.descriptor.id, a]));
  const options: OrchestratorOptions = {
    router: new CompetenceRouter(),
    candidates: adapters.map((a) => a.candidate),
    resolve: (ref) => byId.get(ref.provider) as RoleAdapter,
    journal,
    sessionId,
    onEvent: (e) => events.push(e),
    executor: { firstChunkTimeoutMs: 0, idleTimeoutMs: 0 },
    ...over,
  };
  return { options, journal, events, sessionId };
}
