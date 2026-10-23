import { t } from '../i18n/core';
import { formatDuration, formatUsd } from '../store/format';
import { refKey } from '../store/reducer';
import { patch, useStudio } from '../store/store';
import type { NodeRun } from '../store/types';
import { OutputText, VerdictLine } from './Conversation';
import { PlanEditor } from './PlanEditor';
import { RoutingPanel } from './RoutingPanel';
import { isDisputed } from '../store/disputes';
import { DisputeNote, GradeBox, RunActions } from './NodeActions';
import { ReplayCompare } from './ReplayCompare';
import { StateBadge } from './StateBadge';
import { nodeEstimate, type GraphView } from './view';

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

/** Spec §4.2: the detail of one node — who, why, what it said, and how to steer it. */
export function NodeDetail({ v, nodeId }: { v: GraphView; nodeId: string }) {
  const node = v.graph.nodes.find((g) => g.id === nodeId)!;
  const n = v.run?.nodes[nodeId];
  const est = nodeEstimate(v, nodeId);
  const prompt = node.messages?.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
  const fork = useStudio((s) => s.plan?.fork !== undefined);
  const state = isDisputed(v.run, nodeId) ? 'disputed' : (n?.state ?? 'pending');
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
        <StateBadge state={v.mode === 'plan' ? 'planned' : state} /> · {node.type} ·{' '}
        {est?.protocol ?? node.protocol}
        {n?.ref ? ` · ${refKey(n.ref)}` : ''}
        {n?.startedAt ? ` · ${formatDuration((n.endedAt ?? Date.now()) - n.startedAt)}` : ''}
        {n ? ` · ${formatUsd(n.costUsd)}` : ''}
      </p>
      {v.mode === 'plan' &&
        (fork ? <p className="muted small">{t('fork.noEdit')}</p> : <PlanEditor node={node} />)}
      {v.run && <RunActions run={v.run} nodeId={nodeId} {...(n ? { n } : {})} />}
      {v.run && <DisputeNote run={v.run} nodeId={nodeId} />}
      {v.run && <ReplayCompare runId={v.run.runId} nodeId={nodeId} />}
      {v.run && <GradeBox run={v.run} nodeId={nodeId} {...(n ? { n } : {})} />}
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
