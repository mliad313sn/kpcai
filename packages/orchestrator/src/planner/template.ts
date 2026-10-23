import { randomUUID } from 'node:crypto';
import type {
  Criticality,
  GraphNode,
  PlanContext,
  Planner,
  ProtocolName,
  TaskGraph,
  TaskType,
} from '@kernelpai/core';
import { classify } from '@kernelpai/executor';

/** Read-only tools given to code nodes by default (writes go through a human-confirmed diff). */
export const DEFAULT_CODE_TOOLS: readonly string[] = [
  'fs.list',
  'fs.read',
  'git.status',
  'git.diff',
];

export type RequestKind = 'code' | 'writing' | 'decision' | 'choice' | 'other';

export interface TemplatePlannerOptions {
  /** Tools for code nodes; default `DEFAULT_CODE_TOOLS`. */
  codeTools?: readonly string[];
  /** Overrides the criticality inferred from the request. */
  criticality?: Criticality;
  /** Graph id factory; default a random UUID. */
  newId?: () => string;
}

const CRITICAL =
  /\b(security|secure|auth\w*|oauth|password|secret|token|crypto\w*|payment|billing|migration|production|prod|delete|s[ée]curit[ée])\b/i;
const CHOICE_CUE = /\b(which|choose|pick|select|between|should (i|we) (use|pick|go with))\b/i;
const ALTERNATIVE = /\b[\w.+#-]+\s+(or|vs\.?|versus|ou)\s+[\w.+#-]+/i;

/** Rule-based reading of a request, with the reason shown to the user. */
export function classifyRequest(request: string): {
  kind: RequestKind;
  type: TaskType;
  reason: string;
} {
  if (CHOICE_CUE.test(request) && ALTERNATIVE.test(request)) {
    return { kind: 'choice', type: 'decision', reason: 'closed choice between named options' };
  }
  const c = classify(request);
  const kind: RequestKind =
    c.type === 'code_generation' || c.type === 'test'
      ? 'code'
      : c.type === 'writing'
        ? 'writing'
        : c.type === 'decision'
          ? 'decision'
          : 'other';
  return { kind, type: c.type, reason: c.reason };
}

export function inferCriticality(request: string): Criticality {
  return CRITICAL.test(request) ? 'critical' : 'normal';
}

function make(
  id: string,
  title: string,
  type: TaskType,
  protocol: ProtocolName,
  content: string,
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    title,
    type,
    protocol,
    dependsOn: [],
    criticality: 'normal',
    messages: [{ role: 'user', content }],
    ...extra,
  };
}

function codeNodes(request: string, criticality: Criticality, tools: string[]): GraphNode[] {
  const critical = criticality === 'critical';
  return [
    make(
      'architecture',
      'Architecture',
      'analysis',
      critical ? 'debate' : 'solo',
      `Design the approach (files, interfaces, risks) for this request:\n${request}`,
      { criticality, tools },
    ),
    make(
      'implementation',
      'Implementation',
      'code_generation',
      'author_critic',
      `Implement this request following the architecture:\n${request}`,
      { criticality, tools, dependsOn: ['architecture'] },
    ),
    make(
      'tests',
      'Tests',
      'test',
      'author_critic',
      `Write tests for the implementation of this request:\n${request}`,
      { criticality, tools, dependsOn: ['implementation'] },
    ),
    make(
      'review',
      'Review',
      'critique',
      'solo',
      `Review the implementation and tests for this request; list remaining risks:\n${request}`,
      { tools, dependsOn: ['implementation', 'tests'] },
    ),
  ];
}

/**
 * Deterministic planner (ADR-0017): classifies the request and applies a fixed template.
 * Code → architecture (debate when critical, else solo) → implementation (author+critic)
 * → tests (author+critic) → review (solo, routed away from the providers that did the
 * work when possible). Writing → draft (author+critic). Decision → debate. Closed choice
 * → vote. Anything else → one solo node.
 */
export class TemplatePlanner implements Planner {
  constructor(private readonly options: TemplatePlannerOptions = {}) {}

  plan(request: string, _ctx: PlanContext): Promise<TaskGraph> {
    const c = classifyRequest(request);
    const criticality = this.options.criticality ?? inferCriticality(request);
    const tools = [...(this.options.codeTools ?? DEFAULT_CODE_TOOLS)];
    const nodes: GraphNode[] =
      c.kind === 'code'
        ? codeNodes(request, criticality, tools)
        : [this.single(c.kind, c.type, request, criticality)];
    return Promise.resolve({
      id: this.options.newId?.() ?? randomUUID(),
      request,
      nodes,
      createdBy: 'template',
      reason: `template "${c.kind}" (${c.reason}); criticality ${criticality}`,
    });
  }

  private single(
    kind: RequestKind,
    type: TaskType,
    request: string,
    criticality: Criticality,
  ): GraphNode {
    const extra = { criticality };
    if (kind === 'writing')
      return make('draft', 'Draft', 'writing', 'author_critic', request, extra);
    if (kind === 'decision')
      return make('decision', 'Decision', 'decision', 'debate', request, extra);
    if (kind === 'choice') return make('choice', 'Choice', 'decision', 'vote', request, extra);
    return make('answer', 'Answer', type, 'solo', request, extra);
  }
}
