import { t } from '../i18n/core';
import { formatDuration, formatRange, formatUsd } from '../store/format';
import { refKey } from '../store/reducer';
import { patch, useStudio } from '../store/store';
import type { RunView } from '../store/types';
import type { GraphNode } from '../rpc/schemas';
import { useNow } from './hooks';
import { ControlLog } from './ControlLog';
import { CostMeter } from './CostMeter';
import { columns, neighbour } from './layout';
import { NodeDetail } from './NodeDetail';
import { PlanBar } from './PlanBar';
import { RunControls } from './RunControls';
import { StateBadge } from './StateBadge';
import { nodeEstimate, useGraphView, type GraphView } from './view';
import { Zone } from './Zone';

function RunBar({ run }: { run: RunView }) {
  return (
    <div className="thread-bar" role="group" aria-label={t('thread.run')}>
      <StateBadge state={run.state} />
      <CostMeter spent={run.costUsd} est={run.estimate} />
      <span className="spacer" />
      <RunControls run={run} />
    </div>
  );
}

function NodeCard(props: { node: GraphNode; v: GraphView; now: number; selected: boolean }) {
  const { node, v, now, selected } = props;
  const n = v.run?.nodes[node.id];
  const est = nodeEstimate(v, node.id);
  const ref = n?.ref ?? node.model ?? est?.ref ?? undefined;
  const state = v.mode === 'plan' ? 'planned' : (n?.state ?? 'pending');
  const duration = n?.startedAt ? formatDuration((n.endedAt ?? now) - n.startedAt) : '–';
  const cost =
    v.mode === 'plan' || !n
      ? est
        ? t('thread.est', {
            range: est.band
              ? formatRange(est.band.lowUsd, est.band.highUsd)
              : formatRange(est.minUsd, est.expectedUsd),
          })
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
        <span className="mono">
          {ref ? refKey(ref) : est?.error ? t('thread.unroutable') : '—'}
        </span>
        {node.model && !n && <span className="tag">{t('thread.yourChoice')}</span>}
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
