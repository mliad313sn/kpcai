import { t } from '../i18n/core';
import { formatDuration, formatUsd } from '../store/format';
import { isTerminal, refKey } from '../store/reducer';
import { patch } from '../store/store';
import type { NodeRun } from '../store/types';
import { OutputText, VerdictLine } from './Conversation';
import { PlanEditor } from './PlanEditor';
import { RoutingPanel } from './RoutingPanel';
import { RunControls } from './RunControls';
import { StateBadge } from './StateBadge';
import { InstructBox, Redirect } from './Steer';
import { nodeEstimate, RUN_LIVE, type GraphView } from './view';

function Contributions({ n }: { n: NodeRun | undefined }) {
  if (!n?.contributions.length) return null;
  return (
    <section aria-labelledby="detail-contrib">
      <h4 id="detail-contrib">{t('detail.contributions')}</h4>
      {n.contributions.map((c, i) => (
        <div key={i} className="contribution">
          <p className="meta">
            {c.role} · <span className="mono">{refKey(c.ref)}</span> · {formatUsd(c.costUsd)}
          </p>
          <VerdictLine c={c} />
          <details>
            <summary>{t('detail.text')}</summary>
            <OutputText text={c.text} />
          </details>
        </div>
      ))}
    </section>
  );
}

function RunActions({ v, nodeId, n }: { v: GraphView; nodeId: string; n: NodeRun | undefined }) {
  const run = v.run!;
  const live = RUN_LIVE.has(run.state);
  const notStarted = !n || n.state === 'pending';
  return (
    <>
      <div className="row">
        {live && n && !isTerminal(n.state) && <Redirect runId={run.runId} nodeId={nodeId} />}
        <button type="button" disabled>
          {t('detail.replay')}
        </button>
        <button type="button" disabled>
          {t('detail.fork')}
        </button>
        <RunControls run={run} />
      </div>
      {live && notStarted && <InstructBox runId={run.runId} nodeId={nodeId} />}
    </>
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
          {t('common.close')}
        </button>
      </div>
      <p className="small">
        <StateBadge state={v.mode === 'plan' ? 'planned' : (n?.state ?? 'pending')} /> · {node.type}{' '}
        · {est?.protocol ?? node.protocol}
        {n?.ref ? ` · ${refKey(n.ref)}` : ''}
        {n?.startedAt ? ` · ${formatDuration((n.endedAt ?? Date.now()) - n.startedAt)}` : ''}
        {n ? ` · ${formatUsd(n.costUsd)}` : ''}
      </p>
      {v.mode === 'plan' && <PlanEditor node={node} />}
      {v.run && <RunActions v={v} nodeId={nodeId} n={n} />}
      <RoutingPanel est={est} {...(n ? { n } : {})} />
      {prompt && (
        <details>
          <summary>{t('detail.prompt')}</summary>
          <OutputText text={prompt} />
        </details>
      )}
      <Contributions n={n} />
    </aside>
  );
}
