import { t } from '../i18n/core';
import { formatDuration, formatRange, formatUsd } from '../store/format';
import { refKey } from '../store/reducer';
import { patch, useStudio } from '../store/store';
import type { NodeRun, RunView } from '../store/types';
import type { GraphNode, NodeEstimate } from '../rpc/schemas';
import { useNow } from './hooks';
import { ControlLog } from './ControlLog';
import { CostMeter } from './CostMeter';
import { columns, neighbour } from './layout';
import { NodeDetail } from './NodeDetail';
import { PlanBar } from './PlanBar';
import { RunControls } from './RunControls';
import { StateBadge } from './StateBadge';
import { isDisputed } from '../store/disputes';
import { VerificationLine } from './Evidence';
import { nodeEstimate, useGraphView, type GraphView } from './view';
import { Zone } from './Zone';

function RunBar({ run }: { run: RunView }) {
  return (
    <>
      <div className="thread-bar" role="group" aria-label={t('thread.run')}>
        <StateBadge state={run.state} />
        <CostMeter spent={run.costUsd} est={run.estimate} />
        {run.forkOf && (
          <span className="tag">
            {t('fork.of', { run: run.forkOf.runId.slice(0, 8), id: run.forkOf.nodeId })}
          </span>
        )}
        <span className="spacer" />
        <RunControls run={run} />
      </div>
      {run.verification && <VerificationLine v={run.verification} />}
    </>
  );
}

/** A node's cost: the estimate's band before it runs, what it spent once it has. */
function costText(v: GraphView, n: NodeRun | undefined, est: NodeEstimate | undefined): string {
  if (v.mode === 'run' && n) return formatUsd(n.costUsd);
  if (!est) return '–';
  const range = est.band
    ? formatRange(est.band.lowUsd, est.band.highUsd)
    : formatRange(est.minUsd, est.expectedUsd);
  return t('thread.est', { range });
}

/** Reused from the parent run (fork plan or forked run): not run, not billed again. */
function reusedIn(v: GraphView, plan: { fork?: { reused: string[] } } | undefined, id: string) {
  return v.mode === 'plan' ? !!plan?.fork?.reused.includes(id) : !!v.run?.reused?.includes(id);
}

function NodeCard(props: { node: GraphNode; v: GraphView; now: number; selected: boolean }) {
  const { node, v, now, selected } = props;
  const n = v.run?.nodes[node.id];
  const est = nodeEstimate(v, node.id);
  const ref = n?.ref ?? node.model ?? est?.ref ?? undefined;
  const plan = useStudio((s) => s.plan);
  const reused = reusedIn(v, plan, node.id);
  const state =
    v.mode === 'plan'
      ? 'planned'
      : isDisputed(v.run, node.id)
        ? 'disputed'
        : (n?.state ?? 'pending');
  const duration = n?.startedAt ? formatDuration((n.endedAt ?? now) - n.startedAt) : '–';
  const cost = costText(v, n, est);
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
        <span className="mono">
          {ref ? refKey(ref) : est?.error ? t('thread.unroutable') : '—'}
        </span>
        {node.model && !n && <span className="tag">{t('thread.yourChoice')}</span>}
        {reused && <span className="tag">{t('thread.reused')}</span>}
      </span>
      <span className="node-meta small">
        <span>
          <span className="sr-only">{t('thread.duration')} </span>
          {duration}
        </span>
        <span>
          <span className="sr-only">{t('thread.cost')} </span>
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
        <ol key={i} className="graph-col" aria-label={t('thread.step', { n: i + 1 })}>
          {col.map((node) => (
            <li key={node.id}>
              {node.dependsOn.length > 0 && (
                <span className="deps small muted">
                  {t('thread.after', { nodes: node.dependsOn.map((d) => `#${d}`).join(', ') })}
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
  const plan = useStudio((s) => s.plan);
  const selected = useStudio((s) => s.selectedNodeId);
  const planning = useStudio((s) => s.planning);
  return (
    <Zone zone="thread">
      {!v ? (
        <p className="muted empty">{planning ? t('thread.planning') : t('thread.empty')}</p>
      ) : (
        <>
          {v.mode === 'plan' && plan ? <PlanBar plan={plan} /> : v.run && <RunBar run={v.run} />}
          <div className="thread-body">
            <div className="thread-main">
              <Graph v={v} />
              {v.run && <ControlLog entries={v.run.controls} />}
            </div>
            {selected && v.graph.nodes.some((n) => n.id === selected) && (
              <NodeDetail v={v} nodeId={selected} />
            )}
          </div>
        </>
      )}
    </Zone>
  );
}
