import { useState } from 'react';
import type { NodeEstimate } from '../rpc/schemas';
import { loadModels, redirectNode } from '../store/actions';
import { formatDuration, formatRange, formatScore, formatUsd } from '../store/format';
import { isTerminal, refKey } from '../store/reducer';
import { patch, useStudio } from '../store/store';
import type { NodeRun } from '../store/types';
import { OutputText, VerdictLine } from './Conversation';
import { RunControls } from './RunControls';
import { StateBadge } from './StateBadge';
import { nodeEstimate, type GraphView } from './view';

function Routing({ est, n }: { est: NodeEstimate | undefined; n: NodeRun | undefined }) {
  const reason = n?.reason ?? est?.reason;
  return (
    <section aria-labelledby="detail-routing">
      <h4 id="detail-routing">Routing</h4>
      <p>
        {reason ?? (
          <span className="muted">
            The kernel does not report a per-node routing reason yet; the plan below shows who was
            chosen for each step.
          </span>
        )}
      </p>
      {est?.upgraded && <p>Protocol upgraded: {est.upgraded}</p>}
      {est?.error && <p className="error-text">Cannot route: {est.error}</p>}
      <p className="small">Router score: {formatScore(n?.score ?? est?.score)}</p>
      {est && est.steps.length > 0 && (
        <table className="steps small">
          <caption className="sr-only">Planned steps</caption>
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Model</th>
              <th scope="col">Calls</th>
              <th scope="col">Estimate</th>
            </tr>
          </thead>
          <tbody>
            {est.steps.map((s, i) => (
              <tr key={i}>
                <th scope="row">{s.role}</th>
                <td className="mono">
                  {refKey(s.ref)}
                  {s.diversityWaived ? ' (same provider allowed)' : ''}
                </td>
                <td className="num">
                  {s.calls.min === s.calls.max ? s.calls.max : `${s.calls.min}–${s.calls.max}`}
                </td>
                <td className="num">{formatRange(s.minUsd, s.expectedUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Redirect({ runId, nodeId }: { runId: string; nodeId: string }) {
  const models = useStudio((s) => s.models);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const [provider, ...rest] = value.split('/');
    const model = rest.join('/');
    if (!provider || !model) return;
    void redirectNode(runId, nodeId, { provider, model });
    setOpen(false);
  };
  if (!open)
    return (
      <button type="button" onClick={() => (setOpen(true), void loadModels())}>
        Redirect to…
      </button>
    );
  return (
    <form className="row" onSubmit={submit} aria-label="Redirect node">
      <label htmlFor="redirect-model">Model</label>
      <input
        id="redirect-model"
        list="redirect-models"
        placeholder="provider/model"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <datalist id="redirect-models">
        {models.map((m) => (
          <option key={refKey(m)} value={refKey(m)} />
        ))}
      </datalist>
      <button type="submit" className="primary" disabled={!/^[^/]+\/.+/.test(value)}>
        Redirect
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Close
      </button>
    </form>
  );
}

function Contributions({ n }: { n: NodeRun | undefined }) {
  if (!n?.contributions.length) return null;
  return (
    <section aria-labelledby="detail-contrib">
      <h4 id="detail-contrib">Contributions</h4>
      {n.contributions.map((c, i) => (
        <div key={i} className="contribution">
          <p className="meta">
            {c.role} · <span className="mono">{refKey(c.ref)}</span> · {formatUsd(c.costUsd)}
          </p>
          <VerdictLine c={c} />
          <details>
            <summary>Text</summary>
            <OutputText text={c.text} />
          </details>
        </div>
      ))}
    </section>
  );
}

/** Spec §4.2: the detail of one node — who, why, what it said, and how to steer it. */
export function NodeDetail({ v, nodeId }: { v: GraphView; nodeId: string }) {
  const node = v.graph.nodes.find((g) => g.id === nodeId)!;
  const n = v.run?.nodes[nodeId];
  const est = nodeEstimate(v, nodeId);
  const prompt = node.messages?.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
  return (
    <aside className="detail" aria-labelledby="detail-title">
      <div className="row">
        <h3 id="detail-title" tabIndex={-1}>
          <span className="mono">#{node.id}</span> {node.title}
        </h3>
        <button type="button" onClick={() => patch({ selectedNodeId: undefined })}>
          Close
        </button>
      </div>
      <p className="small">
        <StateBadge state={v.mode === 'plan' ? 'planned' : (n?.state ?? 'pending')} /> · {node.type}{' '}
        · {est?.protocol ?? node.protocol}
        {n?.ref ? ` · ${refKey(n.ref)}` : ''}
        {n?.startedAt ? ` · ${formatDuration((n.endedAt ?? Date.now()) - n.startedAt)}` : ''}
        {n ? ` · ${formatUsd(n.costUsd)}` : ''}
      </p>
      {v.run && (
        <div className="row">
          {n && !isTerminal(n.state) && <Redirect runId={v.run.runId} nodeId={nodeId} />}
          <button type="button" disabled title="Phase 4">
            Replay (phase 4)
          </button>
          <button type="button" disabled title="Phase 4">
            Fork (phase 4)
          </button>
          <RunControls run={v.run} />
        </div>
      )}
      <Routing est={est} n={n} />
      {prompt && (
        <details>
          <summary>Prompt</summary>
          <OutputText text={prompt} />
        </details>
      )}
      <Contributions n={n} />
    </aside>
  );
}
