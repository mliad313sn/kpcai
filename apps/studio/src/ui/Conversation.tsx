import type { Contribution, GraphNode } from '../rpc/schemas';
import { formatUsd } from '../store/format';
import { refKey } from '../store/reducer';
import { patch, useStudio } from '../store/store';
import type { NodeRun } from '../store/types';
import { StateBadge } from './StateBadge';
import { activeRun } from './view';

/** Model output is untrusted: always rendered as text, whitespace preserved, never as HTML. */
export function OutputText({ text, label }: { text: string; label?: string }) {
  return (
    <pre className="output" aria-label={label}>
      {text}
    </pre>
  );
}

export function VerdictLine({ c }: { c: Contribution }) {
  if (!c.verdict) return null;
  const v = c.verdict;
  return (
    <div className="verdict">
      <p>
        <span aria-hidden="true">{v.approve ? '✓ ' : '✕ '}</span>
        <strong>{v.approve ? 'Approved' : `Changes requested (${v.issues.length})`}</strong>
        {v.summary ? ` — ${v.summary}` : ''}
      </p>
      {v.issues.length > 0 && (
        <ul>
          {v.issues.map((i, k) => (
            <li key={k}>
              <span className="tag">{i.severity}</span> {i.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NodeConversation({ node, run }: { node: GraphNode; run: NodeRun | undefined }) {
  return (
    <article className="turn" aria-labelledby={`conv-${node.id}`}>
      <h3 id={`conv-${node.id}`}>
        <span className="mono">#{node.id}</span> {node.title}{' '}
        <StateBadge state={run?.state ?? 'pending'} />
        {run?.approved === false && <span className="tag">not approved</span>}
      </h3>
      {run?.contributions.map((c, i) => (
        <div key={i} className="contribution">
          <p className="meta">
            {c.role} · <span className="mono">{refKey(c.ref)}</span> · {formatUsd(c.costUsd)}
          </p>
          <VerdictLine c={c} />
          {!c.verdict && <OutputText text={c.text} />}
        </div>
      ))}
      {Object.entries(run?.streams ?? {}).map(([key, text]) => (
        <div key={key} className="contribution streaming">
          <p className="meta">{key} · writing…</p>
          <OutputText text={text} />
        </div>
      ))}
      {run?.error && <p className="error-text">Reason: {run.error}</p>}
      {run?.output !== undefined && (
        <>
          <p className="meta">Final output</p>
          <OutputText text={run.output || '(no output)'} />
        </>
      )}
    </article>
  );
}

function Notice() {
  const notice = useStudio((s) => s.notice);
  if (!notice) return null;
  return (
    <section className="notice" aria-labelledby="notice-title">
      <div className="row">
        <h3 id="notice-title">{notice.title}</h3>
        <button type="button" onClick={() => patch({ notice: undefined })}>
          Dismiss
        </button>
      </div>
      <OutputText text={notice.body} />
    </section>
  );
}

export function Conversation() {
  const run = useStudio(activeRun);
  const plan = useStudio((s) => s.plan);
  const conn = useStudio((s) => s.conn);
  return (
    <div className="conversation">
      <Notice />
      {plan && (
        <p className="muted">
          Plan for “{plan.request}” is waiting in the execution thread. Review it, then press Run.
        </p>
      )}
      {!run && !plan && (
        <div className="empty">
          <p>
            <strong>KP Studio</strong>{' '}
            {conn === 'open' ? 'is connected to the KernelPAI kernel.' : 'is not connected yet.'}
          </p>
          <p className="muted">
            Describe a task in the command bar. You will see the plan, who would do each step and
            the cost range before anything runs.
          </p>
        </div>
      )}
      {run && (
        <>
          <h3 className="sub">Request</h3>
          <OutputText text={run.request} />
          {run.graph?.nodes.map((n) => (
            <NodeConversation key={n.id} node={n} run={run.nodes[n.id]} />
          ))}
        </>
      )}
    </div>
  );
}
