import { t } from '../i18n/core';
import { discardPlan, isEdited, startRun } from '../store/actions';
import { costOf } from '../store/cost';
import { formatUsd } from '../store/format';
import { resetPlan } from '../store/plan-edit';
import { useStudio } from '../store/store';
import type { PlanView } from '../store/types';
import { CostBand } from './CostMeter';
import { StateBadge } from './StateBadge';

/** Why Run is disabled, or undefined when the plan can run. */
export function runBlocker(plan: PlanView, conn: string): string | undefined {
  if (conn !== 'open') return t('plan.block.conn');
  if (plan.checking) return t('plan.block.checking');
  if (plan.check && !plan.check.ok) return t('plan.block.problems');
  if (isEdited(plan) && !plan.check) return t('plan.block.unchecked');
  if (!plan.estimate.complete) return t('plan.block.unroutable');
  return undefined;
}

function CheckResult({ plan }: { plan: PlanView }) {
  const c = plan.check;
  const est = plan.estimate;
  const problems = c ? c.problems : est.complete ? [] : est.problems;
  return (
    <div className="plan-check" aria-live="polite">
      {plan.checking && <p className="muted small">{t('plan.checking')}</p>}
      {problems.length > 0 && (
        <div className="error-text" role="note">
          <p>
            <span aria-hidden="true">✕ </span>
            <strong>{t(c ? 'plan.cannotEdited' : 'plan.cannotPlanned')}</strong>
          </p>
          <ul>
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {c && c.warnings.length > 0 && (
        <ul className="warn-text">
          {c.warnings.map((w, i) => (
            <li key={i}>
              <span aria-hidden="true">⚠ </span>
              {t('plan.warning', { warning: w })}
            </li>
          ))}
        </ul>
      )}
      {c && c.changes.length > 0 && (
        <details>
          <summary>{t('plan.edits', { count: c.changes.length })}</summary>
          <ul className="small">
            {c.changes.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** R-306: rule files every node gets, by name only, marked untrusted. */
function RulesLine({ plan }: { plan: PlanView }) {
  const r = plan.rules;
  if (!r || r.files.length === 0) return null;
  const files = r.files.filter((f) => f.applies).map((f) => f.path);
  return (
    <p className="small muted">
      {t('plan.rules', { count: files.length, files: files.join(', ') })}
      {r.skippedForbidden > 0 ? ` ${t('plan.rulesForbidden', { count: r.skippedForbidden })}` : ''}
    </p>
  );
}

/** D-020: the domain packs chosen for this workspace, why, their limits and scope status. */
function PacksLine({ plan }: { plan: PlanView }) {
  const packs = plan.packs?.packs ?? [];
  const scope = plan.scope;
  if (packs.length === 0 && !scope) return null;
  return (
    <div className="small">
      {packs.map((p) => (
        <p key={p.id}>
          {t('plan.pack', { name: p.name, reason: p.reason })}
          {p.limits.length > 0 ? ` ${t('plan.packLimits', { limits: p.limits.join(' · ') })}` : ''}
        </p>
      ))}
      {plan.packs?.lines.map((l, i) => (
        <p key={i} className="muted">
          {l}
        </p>
      ))}
      {scope?.lines.map((l, i) => (
        <p key={i}>{l}</p>
      ))}
      {scope?.problems.map((p, i) => (
        <p key={i} className="error-text">
          {t('plan.scopeProblem', { problem: p })}
        </p>
      ))}
    </div>
  );
}

/** R-301/R-302: the plan before launch, its band and cap, the check of the user's edits. */
export function PlanBar({ plan }: { plan: PlanView }) {
  const conn = useStudio((s) => s.conn);
  const blocker = runBlocker(plan, conn);
  const edited = isEdited(plan);
  return (
    <div className="plan-bar">
      <div className="thread-bar" role="group" aria-label={t('plan.label')}>
        <StateBadge state="planned" />
        <span>
          {t(edited ? 'plan.summaryEdited' : 'plan.summary', {
            count: plan.graph.nodes.length,
            by: plan.graph.createdBy,
            reason: plan.graph.reason,
          })}
        </span>
        <CostBand est={plan.estimate} />
        <span className="spacer" />
        {edited && (
          <button type="button" onClick={resetPlan}>
            {t('plan.undo')}
          </button>
        )}
        <button type="button" onClick={discardPlan}>
          {t('plan.discard')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={blocker !== undefined}
          aria-describedby={blocker ? 'run-blocker' : undefined}
          onClick={() => void startRun()}
        >
          {t('plan.run', { cap: formatUsd(costOf(plan.estimate).cap) })}
        </button>
        {blocker && (
          <span id="run-blocker" className="sr-only">
            {t('plan.disabled', { why: blocker })}
          </span>
        )}
      </div>
      <RulesLine plan={plan} />
      <PacksLine plan={plan} />
      <CheckResult plan={plan} />
    </div>
  );
}
