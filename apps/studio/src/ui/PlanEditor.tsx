import { useState } from 'react';
import { t, type Key } from '../i18n/core';
import type { GraphNode, Ref } from '../rpc/schemas';
import {
  CRITICALITIES,
  PROTOCOLS,
  editNode,
  removeNode,
  type Criticality,
  type Protocol,
} from '../store/plan-edit';
import { refKey } from '../store/reducer';
import { useStudio } from '../store/store';

const ROUTED = '';

const PROTOCOL_TEXT: Record<Protocol, Key> = {
  solo: 'protocol.solo',
  author_critic: 'protocol.author_critic',
  debate: 'protocol.debate',
  vote: 'protocol.vote',
};

const CRITICALITY_TEXT: Record<Criticality, Key> = {
  low: 'criticality.low',
  normal: 'criticality.normal',
  critical: 'criticality.critical',
};

function byProvider(models: Ref[]): Array<[string, string[]]> {
  const map = new Map<string, string[]>();
  for (const m of models) map.set(m.provider, [...(map.get(m.provider) ?? []), m.model]);
  return [...map.entries()];
}

function ModelSelect({ node }: { node: GraphNode }) {
  const models = useStudio((s) => s.models);
  const current = node.model ? refKey(node.model) : ROUTED;
  const known = models.some((m) => refKey(m) === current);
  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    const [provider, ...rest] = v.split('/');
    editNode(node.id, {
      model: v === ROUTED || !provider ? null : { provider, model: rest.join('/') },
    });
  };
  return (
    <>
      <label htmlFor="edit-model">{t('edit.model')}</label>
      <select id="edit-model" value={current} onChange={onChange}>
        <option value={ROUTED}>{t('edit.routed')}</option>
        {current !== ROUTED && !known && (
          <option value={current}>{t('edit.unavailable', { model: current })}</option>
        )}
        {byProvider(models).map(([provider, list]) => (
          <optgroup key={provider} label={provider}>
            {list.map((m) => (
              <option key={m} value={`${provider}/${m}`}>
                {provider}/{m}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </>
  );
}

function BudgetInput({ node }: { node: GraphNode }) {
  const [text, setText] = useState(node.budgetUsd === undefined ? '' : String(node.budgetUsd));
  const commit = () => {
    const t = text.trim();
    if (t === '') return editNode(node.id, { budgetUsd: null });
    const v = Number(t);
    if (Number.isFinite(v) && v >= 0) editNode(node.id, { budgetUsd: v });
  };
  const invalid = text.trim() !== '' && !(Number(text) >= 0);
  return (
    <>
      <label htmlFor="edit-budget">{t('edit.budget')}</label>
      <input
        id="edit-budget"
        type="text"
        inputMode="decimal"
        value={text}
        aria-invalid={invalid}
        aria-describedby="edit-budget-help"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())}
      />
      <span id="edit-budget-help" className="muted small">
        {t(invalid ? 'edit.budgetInvalid' : 'edit.budgetHelp')}
      </span>
    </>
  );
}

/**
 * R-301: change a node before launch — model (pinned, no automatic fallback, ADR-0020),
 * protocol, criticality, budget — or remove it. Each change applies at once and is checked
 * by the kernel (`plan.validate`) right after.
 */
export function PlanEditor({ node }: { node: GraphNode }) {
  const count = useStudio((s) => s.plan?.graph.nodes.length ?? 0);
  return (
    <section aria-labelledby="edit-title" className="plan-editor">
      <h4 id="edit-title">{t('edit.title')}</h4>
      <div className="form-grid" key={node.id}>
        <ModelSelect node={node} />
        <label htmlFor="edit-protocol">{t('edit.protocol')}</label>
        <select
          id="edit-protocol"
          value={node.protocol}
          onChange={(e) => editNode(node.id, { protocol: e.target.value as Protocol })}
        >
          {PROTOCOLS.map((p) => (
            <option key={p} value={p}>
              {t(PROTOCOL_TEXT[p])}
            </option>
          ))}
        </select>
        <label htmlFor="edit-criticality">{t('edit.criticality')}</label>
        <select
          id="edit-criticality"
          value={node.criticality ?? 'normal'}
          onChange={(e) => editNode(node.id, { criticality: e.target.value as Criticality })}
        >
          {CRITICALITIES.map((c) => (
            <option key={c} value={c}>
              {t(CRITICALITY_TEXT[c])}
            </option>
          ))}
        </select>
        <BudgetInput node={node} />
      </div>
      <button
        type="button"
        className="danger"
        disabled={count < 2}
        onClick={() => removeNode(node.id)}
      >
        {t('edit.remove')}
      </button>
    </section>
  );
}
