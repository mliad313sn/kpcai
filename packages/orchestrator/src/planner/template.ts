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
import type { Pack } from '@kernelpai/packs';
import { domainPackPlan, genericPackPlan, packCriticality, type PackPlan } from './packs.js';

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
  /**
   * Active domain packs (`@kernelpai/packs`). A domain pack whose plan cues match the
   * request gives the plan; the generic pack only when no template fits. None: today's
   * templates.
   */
  packs?: readonly Pack[];
}

/**
 * Security context words (WI-S4-03): bare `token` and `crypto` are not enough ("report the
 * token counts", "crypto prices"); a token needs a security qualifier. Letters around the
 * match are checked with Unicode classes so "sécurité" matches.
 */
const CRITICAL = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(` +
    [
      String.raw`security|secure\w*|s[ée]curit[ée]`,
      String.raw`auth|authn|authz|authenticat\w*|authori[sz]\w*|oauth\w*|sso|mfa|2fa`,
      String.raw`passwords?|passphrases?|secrets?|credentials?|api[ -]?keys?|private[ -]keys?`,
      String.raw`(?:access|refresh|bearer|session|auth|api|jwt|csrf|id)[ _-]?tokens?|jwts?`,
      String.raw`encrypt\w*|decrypt\w*|cryptograph\w*`,
      String.raw`payments?|billing|migration|production|prod|delete`,
    ].join('|') +
    String.raw`)(?![\p{L}\p{N}_])`,
  'iu',
);
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
 * → vote. Anything else → one solo node. With `packs` (WI-S4-01), a domain pack's plan hint
 * whose cues match comes first (except for a closed choice), and the generic pack's hint
 * replaces the single solo node.
 */
export class TemplatePlanner implements Planner {
  constructor(private readonly options: TemplatePlannerOptions = {}) {}

  plan(request: string, _ctx: PlanContext): Promise<TaskGraph> {
    const c = classifyRequest(request);
    const packs = this.options.packs ?? [];
    const criticality =
      this.options.criticality ?? packCriticality(packs, inferCriticality(request));
    const pack = this.packPlan(c.kind, request, criticality);
    const tools = [...(this.options.codeTools ?? DEFAULT_CODE_TOOLS)];
    const nodes: GraphNode[] = pack
      ? pack.nodes
      : c.kind === 'code'
        ? codeNodes(request, criticality, tools)
        : [this.single(c.kind, c.type, request, criticality)];
    const why = pack ? pack.reason : `template "${c.kind}" (${c.reason})`;
    return Promise.resolve({
      id: this.options.newId?.() ?? randomUUID(),
      request,
      nodes,
      createdBy: 'template',
      reason: `${why}; criticality ${criticality}`,
    });
  }

  /**
   * A closed choice stays a vote; else a matching domain pack plans; the generic pack only
   * for requests no template fits (kind `other`).
   */
  private packPlan(kind: RequestKind, request: string, c: Criticality): PackPlan | undefined {
    const packs = this.options.packs ?? [];
    if (packs.length === 0 || kind === 'choice') return undefined;
    const domain = domainPackPlan(packs, request, c);
    if (domain || kind !== 'other') return domain;
    return genericPackPlan(packs, request, c);
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
