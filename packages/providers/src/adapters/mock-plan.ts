import type { GraphNode, TaskGraph, TaskType } from '@kernelpai/core';

/**
 * Finds `[[<tag><head> {json}]]` and returns the head and the raw JSON object text,
 * matched with balanced braces (strings and escapes respected), so the JSON may
 * itself contain `]]`. The JSON part is optional (`json` is then undefined).
 */
export function jsonMarker(
  text: string,
  tag: string,
  head: RegExp = /^/,
): { head: string; json: string | undefined } | undefined {
  const open = `[[${tag}`;
  for (let at = text.indexOf(open); at >= 0; at = text.indexOf(open, at + 1)) {
    const rest = text.slice(at + open.length);
    const h = head.exec(rest)?.[0] ?? '';
    const afterHead = rest.slice(h.length).replace(/^\s*/, '');
    if (afterHead.startsWith(']]')) return { head: h, json: undefined };
    const end = afterHead.startsWith('{') ? balancedEnd(afterHead) : -1;
    if (end > 0 && afterHead.slice(end).startsWith(']]')) {
      return { head: h, json: afterHead.slice(0, end) };
    }
  }
  return undefined;
}

/** Index just past the `}` closing the object that starts at 0, or -1. */
function balancedEnd(s: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Words that make the mock planner treat a request as a code change. */
const CODE_REQUEST =
  /\b(code|implement|function|class|method|bug|fix|refactor|tests?|module|script|validator|endpoint|api|compile|typescript|python)\b/i;

/** The user's request inside a planner prompt: a `Request:` line, else the whole text. */
export function plannerRequest(prompt: string): string {
  const line = /^Request:\s*(.+)$/m.exec(prompt);
  return (line?.[1] ?? prompt).trim();
}

const CODE_STEPS: ReadonlyArray<[TaskType, string, GraphNode['protocol']]> = [
  ['analysis', 'Analyse the request', 'solo'],
  ['code_generation', 'Implement the change', 'author_critic'],
  ['test', 'Write the tests', 'author_critic'],
  ['critique', 'Review the result', 'solo'],
];

/**
 * Default mock plan: analysis → code_generation → test → critique for code
 * requests (a chain, ids n1..n4), otherwise one solo analysis node `n1`.
 */
export function defaultPlan(request: string): TaskGraph {
  const steps = CODE_REQUEST.test(request)
    ? CODE_STEPS
    : ([['analysis', 'Answer the request', 'solo']] as const);
  const nodes: GraphNode[] = steps.map(([type, title, protocol], i) => ({
    id: `n${i + 1}`,
    title,
    type,
    protocol,
    dependsOn: i === 0 ? [] : [`n${i}`],
    criticality: 'normal',
    messages: [{ role: 'user', content: `${title}: ${request}` }],
  }));
  return {
    id: 'mock-plan',
    request,
    nodes,
    createdBy: 'model',
    reason: nodes.length > 1 ? 'mock planner: code template' : 'mock planner: single step',
  };
}

/** A unified diff creating `path` (git apply compatible), for offline demos. */
export function creationDiff(path: string, model: string, revised: boolean): string {
  const lines = [
    `// Created by mock/${model}`,
    `export const generatedBy = 'mock';`,
    'export default generatedBy;',
    ...(revised ? ['// [[revised]]'] : []),
  ];
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}
