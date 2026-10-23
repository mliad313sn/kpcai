/**
 * Replay a finished node (R-403) in two steps (P4-F5). The user picks a model and/or a
 * protocol and asks for the estimate: `run.replayPlan` spends nothing and says the likely
 * cost, the cap and the routing the replay is held to (the original run's, P4-F2). Only
 * then does the same button become "Run replay (cap …)". Changing the choice drops the
 * estimate: what runs is always what was shown.
 */
import { useRef, useState } from 'react';
import { t } from '../i18n/core';
import { costLine, costOf } from '../store/cost';
import { formatUsd } from '../store/format';
import type { NodeEditInput, Protocol } from '../store/learning';
import { planReplay, routingLines, runReplay, type ReplayPlanView } from '../store/replay';
import { useStudio } from '../store/store';
import { Modal } from './Modal';
import { Fields, toRef } from './NodeEditDialog';

function Estimate({ plan }: { plan: ReplayPlanView }) {
  const mine = useStudio((s) => s.runOptions);
  return (
    <section aria-labelledby="replay-estimate-title" className="replay-estimate">
      <h3 id="replay-estimate-title" className="sub">
        {t('replay.estimateTitle')}
      </h3>
      <p>{costLine(plan.estimate)}</p>
      <ul className="small">
        {routingLines(plan, mine).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {plan.scopeProblems.map((p) => (
        <p key={p} className="warn-text small">
          <span aria-hidden="true">⚠ </span>
          {t('replay.scopeProblem', { problem: p })}
        </p>
      ))}
    </section>
  );
}

function submitLabel(plan: ReplayPlanView | undefined, busy: boolean): string {
  if (busy) return t('replay.estimating');
  if (!plan) return t('replay.estimate');
  return t('replay.run', { cap: formatUsd(costOf(plan.estimate).cap) });
}

/** The choice, its estimate and the estimate's state; a new choice drops the estimate. */
function useReplayPlan(runId: string, nodeId: string) {
  const [model, setModel] = useState('');
  const [protocol, setProtocol] = useState('');
  const [plan, setPlan] = useState<ReplayPlanView | undefined>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Only the answer to the latest choice is kept (a slower, older estimate is dropped).
  const asked = useRef(0);
  const ref = toRef(model);
  const edit: NodeEditInput = {
    ...(ref ? { model: ref } : {}),
    ...(protocol ? { protocol: protocol as Protocol } : {}),
  };
  const changed = (set: (v: string) => void) => (v: string) => {
    asked.current += 1;
    set(v);
    setPlan(undefined);
    setError('');
    setBusy(false);
  };
  const estimate = async () => {
    const n = ++asked.current;
    setBusy(true);
    setError('');
    const r = await planReplay(runId, nodeId, edit);
    if (n !== asked.current) return;
    setBusy(false);
    if (r.ok) setPlan(r.plan);
    else setError(r.error);
  };
  const fields = {
    model,
    setModel: changed(setModel),
    protocol,
    setProtocol: changed(setProtocol),
  };
  return { fields, plan, error, busy, empty: !ref && !protocol, estimate };
}

function Footer(props: {
  plan?: ReplayPlanView;
  busy: boolean;
  off: boolean;
  onClose: () => void;
}) {
  const { plan, busy, off, onClose } = props;
  return (
    <>
      <p className="muted small" id="replay-note">
        {t(plan ? 'replay.noteRun' : 'replay.note')}
      </p>
      <div className="row end">
        <button type="button" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="primary" disabled={off} aria-describedby="replay-note">
          {submitLabel(plan, busy)}
        </button>
      </div>
    </>
  );
}

/** The replay dialog: choice, estimate, then Run; Escape cancels and nothing is spent. */
export function ReplayDialog(props: { runId: string; nodeId: string; onClose: () => void }) {
  const { runId, nodeId, onClose } = props;
  const { fields, plan, error, busy, empty, estimate } = useReplayPlan(runId, nodeId);
  const off = empty || busy || (plan?.scopeProblems.length ?? 0) > 0;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (off) return;
    if (!plan) return void estimate();
    onClose();
    void runReplay(plan);
  };
  return (
    <Modal labelledBy="replay-title" describedBy="replay-help" onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id="replay-title">{t('replay.title', { id: nodeId })}</h2>
        <p id="replay-help" className="muted">
          {t('replay.help')}
        </p>
        <Fields mode="replay" {...fields} />
        {plan && <Estimate plan={plan} />}
        {error && (
          <p role="alert" className="error-text small">
            {t('fail.replayPlan', { error })}
          </p>
        )}
        <Footer plan={plan} busy={busy} off={off} onClose={onClose} />
      </form>
    </Modal>
  );
}
