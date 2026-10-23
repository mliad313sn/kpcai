import { discardPlan, startRun } from '../store/actions';
import { formatDuration, formatRange, formatUsd } from '../store/format';
import { refKey } from '../store/reducer';
import { patch, useStudio } from '../store/store';
import type { RunView } from '../store/types';
import type { GraphNode } from '../rpc/schemas';
import { useNow } from './hooks';
import { columns, neighbour } from './layout';
import { NodeDetail } from './NodeDetail';
import { RunControls } from './RunControls';
import { StateBadge } from './StateBadge';
import { nodeEstimate, useGraphView, type GraphView } from './view';
import { Zone } from './Zone';

function PlanBar({ v }: { v: GraphView }) {
  const est = v.estimate;
  const conn = useStudio((s) => s.conn);
  const blocked = est ? !est.complete : false;
  return (
    <div className="thread-bar" role="group" aria-label="Plan">
      <StateBadge state="planned" />
      <span>
        {v.graph.nodes.length} node(s) · {v.graph.createdBy}: {v.graph.reason}
      </span>
      {est && (
        <span>
          Estimate <strong>{formatRange(est.minUsd, est.totalUsd)}</strong>
        </span>
      )}
      {blocked && (
        <span className="error-text" role="note">
          <span aria-hidden="true">⚠ </span>Cannot run as planned: {est?.problems.join('; ')}
        </span>
      )}
      <span className="spacer" />
      <button type="button" onClick={discardPlan}>
        Discard
      </button>
      <button
        type="button"
        className="primary"
        disabled={blocked || conn !== 'open'}
        onClick={() => void startRun()}
      >
        Run{est ? ` (≤ ${formatUsd(est.totalUsd)})` : ''}
      </button>
    </div>
  );
}

function RunBar({ run }: { run: RunView }) {
  return (
    <div className="thread-bar" role="group" aria-label="Run">
      <StateBadge state={run.state} />
      <span>
        Cost so far <strong>{formatUsd(run.costUsd)}</strong>
        {run.estimate ? ` of ≤ ${formatUsd(run.estimate.totalUsd)} estimated` : ''}
      </span>
      <span className="spacer" />
      <RunControls run={run} />
    </div>
  );
}

function NodeCard(props: { node: GraphNode; v: GraphView; now: number; selected: boolean }) {
  const { node, v, now, selected } = props;
  const n = v.run?.nodes[node.id];
  const est = nodeEstimate(v, node.id);
  const ref = n?.ref ?? est?.ref ?? undefined;
  const state = v.mode === 'plan' ? 'planned' : (n?.state ?? 'pending');
  const duration = n?.startedAt ? formatDuration((n.endedAt ?? now) - n.startedAt) : '–';
  const cost =
    v.mode === 'plan' || !n
      ? est
        ? `est. ${formatRange(est.minUsd, est.expectedUsd)}`
        : '–'
      : formatUsd(n.costUsd);
  return (
    <button
      type="button"
      id={`node-${node.id}`}
      className={`node state-${state} ${selected ? 'selected' : ''}`}
      aria-pressed={selected}
      onClick={() => patch({ selectedNodeId: selected ? undefined : node.id })}
    >
      <span className="node-head">
        <span className="mono">#{node.id}</span> <StateBadge state={state} />
      </span>
      <span className="node-title">{node.title}</span>
      <span className="node-meta small">
        <span className="mono">{ref ? refKey(ref) : est?.error ? 'unroutable' : '—'}</span>
      </span>
      <span className="node-meta small">
        <span>
          <span className="sr-only">duration </span>
          {duration}
        </span>
        <span>
          <span className="sr-only">cost </span>
          {cost}
        </span>
      </span>
    </button>
  );
}

function Graph({ v }: { v: GraphView }) {
  const selected = useStudio((s) => s.selectedNodeId);
  const live = v.run ? ['starting', 'running', 'paused'].includes(v.run.state) : false;
  const now = useNow(1000, live);
  const cols = columns(v.graph.nodes);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const id = (e.target as HTMLElement).id.replace(/^node-/, '');
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const to = neighbour(cols, id, e.key as 'ArrowUp');
    if (!to) return;
    e.preventDefault();
    document.getElementById(`node-${to}`)?.focus();
  };
  return (
    <div className="graph" onKeyDown={onKeyDown}>
      {cols.map((col, i) => (
        <ol key={i} className="graph-col" aria-label={`Step ${i + 1}`}>
          {col.map((node) => (
            <li key={node.id}>
              {node.dependsOn.length > 0 && (
                <span className="deps small muted">
                  after {node.dependsOn.map((d) => `#${d}`).join(', ')}
                </span>
              )}
              <NodeCard node={node} v={v} now={now} selected={selected === node.id} />
            </li>
          ))}
        </ol>
      ))}
    </div>
  );
}

export function Thread() {
  const v = useGraphView();
  const selected = useStudio((s) => s.selectedNodeId);
  const planning = useStudio((s) => s.planning);
  return (
    <Zone zone="thread">
      {!v ? (
        <p className="muted empty">
          {planning ? 'Planning…' : 'The task graph appears here as soon as a request is planned.'}
        </p>
      ) : (
        <>
          {v.mode === 'plan' ? <PlanBar v={v} /> : v.run && <RunBar run={v.run} />}
          <div className="thread-body">
            <Graph v={v} />
            {selected && v.graph.nodes.some((n) => n.id === selected) && (
              <NodeDetail v={v} nodeId={selected} />
            )}
          </div>
        </>
      )}
    </Zone>
  );
}
