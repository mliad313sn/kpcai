import {
  BaseAdapter,
  ProviderDescriptorSchema,
  ProviderError,
  type ChatRequest,
  type DetectResult,
  type ModelRef,
  type ProviderDescriptor,
  type RoutingDecision,
  type ScoredCandidate,
  type StopReason,
  type StreamEvent,
  type TaskNode,
} from '@kernelpai/core';

/** Same shape as packages/providers/descriptors/mock.yaml, with a configurable id. */
export function mockDescriptor(id: string, modelId = 'echo'): ProviderDescriptor {
  return ProviderDescriptorSchema.parse({
    id,
    name: `Mock ${id}`,
    kind: 'test',
    adapter: 'mock',
    jurisdiction: 'local',
    retention: 'stays on this machine',
    models: [
      {
        id: modelId,
        displayName: 'Echo',
        contextWindow: 32000,
        maxOutput: 4096,
        modalities: ['text', 'code'],
        price: { inputPerMTok: 1, outputPerMTok: 2 },
        strengths: ['writing'],
      },
    ],
  });
}

export type Step =
  | { text: string }
  | { usage: { inputTokens: number; outputTokens: number } }
  | { end: StopReason }
  | { fail: ProviderError['kind']; status?: number }
  | { throwPlain: string }
  /** Waits until the request is aborted. */
  | { hang: true };

/**
 * Adapter that plays one script per call: call n uses scripts[n] (the last one repeats).
 * Lets tests describe precise failure sequences ("429, then success").
 */
export class ScriptedAdapter extends BaseAdapter {
  calls = 0;
  readonly requests: ChatRequest[] = [];
  private readonly scripts: Step[][];

  constructor(id: string, scripts: Step[][]) {
    super(mockDescriptor(id));
    this.scripts = scripts;
  }

  detect(): Promise<DetectResult> {
    return Promise.resolve({ available: true, reason: 'scripted' });
  }

  protected async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const script = this.scripts[Math.min(this.calls, this.scripts.length - 1)] ?? [];
    this.calls++;
    this.requests.push(req);
    for (const step of script) {
      if ('text' in step) yield { type: 'text', delta: step.text };
      else if ('usage' in step) yield { type: 'usage', usage: step.usage };
      else if ('end' in step) yield { type: 'end', stopReason: step.end };
      else if ('fail' in step) {
        const opts = step.status === undefined ? {} : { status: step.status };
        throw new ProviderError(step.fail, this.descriptor.id, `scripted ${step.fail}`, opts);
      } else if ('throwPlain' in step) throw new TypeError(step.throwPlain);
      else await new Promise((resolve) => signal.addEventListener('abort', resolve));
    }
  }
}

export const OK: Step[] = [
  { text: 'hello ' },
  { text: 'world' },
  { usage: { inputTokens: 10, outputTokens: 4 } },
  { end: 'end' },
];

export function node(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 'n1',
    type: 'analysis',
    messages: [{ role: 'user', content: 'Explain the fallback policy please' }],
    criticality: 'normal',
    ...overrides,
  };
}

function scored(ref: ModelRef): ScoredCandidate {
  return {
    ref,
    score: 1,
    parts: { staticCompetence: 1, measuredCompetence: null, costPenalty: 0, latencyPenalty: 0 },
    estimate: {
      inputTokens: 1,
      maxOutputTokens: 1,
      maxCostUsd: 0,
      expectedCostUsd: 0,
      basis: 'heuristic',
    },
  };
}

/** Decision for "provider/model" refs: the first is chosen, the rest are fallbacks. */
export function decision(...refs: string[]): RoutingDecision {
  const [chosen, ...rest] = refs.map((s) => {
    const [provider = '', model = ''] = s.split('/');
    return scored({ provider, model });
  });
  return {
    nodeId: 'n1',
    chosen: chosen as ScoredCandidate,
    fallbacks: rest,
    rejected: [],
    reason: 'test',
    elapsedMs: 1,
  };
}
