/**
 * R-306 at the kernel boundary: repository rule files (AGENTS.md, CLAUDE.md, …) read inside
 * the jail with the active forbidden zones, then handed to every model call of a run as
 * UNTRUSTED repository data (ADR-0021): a leading `user` message on each node (never a
 * `system` message, which carries KernelPAI's own authority) and the same message on the
 * model planner's calls. Rule files cannot widen any permission.
 */
import type { ChatMessage, ChatRequest, ProviderAdapter, TaskGraph } from '@kernelpai/core';
import type { AdapterResolver } from '@kernelpai/executor';
import {
  formatRepoRules,
  readRepoRules,
  type RepoRules,
  type RuleKind,
  type ZoneSet,
} from '@kernelpai/tools';

/** What a plan shows about the rule files: names and sizes, never their content. */
export interface RulesSummary {
  trust: 'untrusted';
  files: Array<{
    path: string;
    kind: RuleKind;
    scope: string;
    applies: boolean;
    bytes: number;
    truncated: boolean;
  }>;
  truncated: boolean;
  omitted: string[];
  /** Rule files in forbidden zones: never read, never named. */
  skippedForbidden: number;
}

export interface LoadedRules {
  rules: RepoRules;
  /** Prompt form (`formatRepoRules`); empty when there is no rule file. */
  text: string;
}

export const NO_RULES: LoadedRules = {
  rules: {
    trust: 'untrusted',
    files: [],
    truncated: false,
    omitted: [],
    skippedForbidden: 0,
    totalBytes: 0,
  },
  text: '',
};

/** Reads the rule files of the workspace; a failure leaves the run without rules (and says so). */
export async function loadRules(
  root: string,
  zones: ZoneSet,
  say: (text: string) => void,
): Promise<LoadedRules> {
  try {
    const rules = await readRepoRules(root, { zones });
    if (rules.trust !== 'untrusted') return NO_RULES; // the contract says it always is
    return { rules, text: formatRepoRules(rules) };
  } catch (err) {
    say(`  – repository rules not read: ${err instanceof Error ? err.message : String(err)}\n`);
    return NO_RULES;
  }
}

export function summarizeRules(r: RepoRules): RulesSummary {
  return {
    trust: 'untrusted',
    files: r.files.map((f) => ({
      path: f.path,
      kind: f.kind,
      scope: f.scope,
      applies: f.applies,
      bytes: f.bytes,
      truncated: f.truncated,
    })),
    truncated: r.truncated,
    omitted: [...r.omitted],
    skippedForbidden: r.skippedForbidden,
  };
}

export interface NodeContext {
  /** `formatRepoRules` text, or empty. */
  rules: string;
}

/**
 * The graph a run executes: each node's messages start with the repository rules (a
 * `user` message, untrusted). The node's own request stays its last user message, so every
 * protocol step (author, critic, voter…) keeps the rules in front of it. Nodes with
 * malformed messages are left as they are (validation reports them).
 */
export function withNodeContext(graph: TaskGraph, ctx: NodeContext): TaskGraph {
  if (!ctx.rules) return graph;
  const lead: ChatMessage[] = [{ role: 'user', content: ctx.rules }];
  const nodes = graph.nodes.map((n) => {
    if (!Array.isArray(n.messages)) return n;
    // Without a user message of its own, the rules would become the step prompt's slot.
    const own = n.messages.some((m) => m.role === 'user')
      ? n.messages
      : [...n.messages, { role: 'user' as const, content: n.title }];
    return { ...n, messages: [...lead, ...own] };
  });
  return { ...graph, nodes };
}

/** An adapter whose every request starts with the rules message (the model planner's calls). */
function rulesAdapter(inner: ProviderAdapter, text: string): ProviderAdapter {
  const add = (req: ChatRequest): ChatRequest => ({
    ...req,
    messages: [{ role: 'user', content: text }, ...req.messages],
  });
  return {
    descriptor: inner.descriptor,
    capabilities: () => inner.capabilities(),
    estimate: (req) => inner.estimate(add(req)),
    send: (req, options) => inner.send(add(req), options),
    cancel: (id) => inner.cancel(id),
    detect: () => inner.detect(),
  };
}

/** The resolver as is without rules, else one that prepends them to every request. */
export function rulesResolver(resolve: AdapterResolver, text: string): AdapterResolver {
  return text ? (ref) => rulesAdapter(resolve(ref), text) : resolve;
}
