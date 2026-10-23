/**
 * A disputed node (R-405, ADR-0029): critics, judges or voters disagree and the human
 * settles it. Positions and options are untrusted model output, each quoted as data. The
 * default is Reject (focus starts there): Escape, the timeout and Reject all fail closed —
 * the node fails with no output, patch or file. Only a picked option settles it; every
 * option is shown in full, and one the kernel marks `truncated` cannot be picked (P4-F11).
 */
import { useState } from 'react';
import { t } from '../i18n/core';
import { answerConfirm } from '../store/actions';
import type { ConfirmView } from '../store/types';
import { TimeLeft, useConfirmDeadline } from './ConfirmParts';
import { Quoted } from './MemoryFact';
import { Modal } from './Modal';

type Dispute = NonNullable<ConfirmView['dispute']>;

function Positions({ d }: { d: Dispute }) {
  if (d.positions.length === 0) return null;
  const label = (id: string | undefined) => d.options.find((o) => o.id === id)?.label;
  return (
    <section aria-labelledby="dispute-positions">
      <h3 id="dispute-positions" className="sub">
        {t('dispute.positions')}
      </h3>
      <ul className="positions">
        {d.positions.map((p, i) => (
          <li key={i}>
            <p className="small">
              <span className="mono">{p.ref}</span> · {p.role}
              {label(p.option) ? ` · ${t('dispute.backs', { option: label(p.option)! })}` : ''}
            </p>
            <Quoted text={p.says} label={t('dispute.says', { model: p.ref })} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Options(props: { d: Dispute; choice: string; pick: (id: string) => void }) {
  const { d, choice, pick } = props;
  return (
    <fieldset className="dispute-options">
      <legend>{t('dispute.options')}</legend>
      {d.options.map((o, i) => (
        <div key={o.id} className="dispute-option">
          <input
            type="radio"
            name="dispute-choice"
            id={`dispute-opt-${i}`}
            value={o.id}
            checked={choice === o.id}
            disabled={o.truncated === true}
            onChange={() => pick(o.id)}
            aria-describedby={`dispute-text-${i}`}
          />
          <label htmlFor={`dispute-opt-${i}`}>
            {o.label}
            {o.backers.length > 0 && (
              <span className="muted small">
                {' '}
                {t('dispute.backers', { models: o.backers.join(', ') })}
              </span>
            )}
          </label>
          <div id={`dispute-text-${i}`}>
            {o.truncated === true && (
              <p className="warn-text small">
                <span aria-hidden="true">⚠ </span>
                {t('dispute.truncated')}
              </p>
            )}
            <Quoted text={o.text} label={t('dispute.optionText', { option: o.label })} />
          </div>
        </div>
      ))}
    </fieldset>
  );
}

export function DisputeDialog({ c, queued }: { c: ConfirmView; queued: number }) {
  const d = c.dispute!;
  const [choice, setChoice] = useState('');
  const deadline = useConfirmDeadline(c);
  const reject = () => void answerConfirm(c.confirmId, false);
  return (
    <Modal
      role="alertdialog"
      labelledBy="dispute-title"
      describedBy="dispute-reason"
      onClose={reject}
      initialFocus=".dispute-reject"
      className="confirm dispute"
    >
      <h2 id="dispute-title">{t('dispute.title', { id: d.nodeId })}</h2>
      <p id="dispute-reason">{t('dispute.reason', { kind: d.kind, reason: d.reason })}</p>
      <p className="warn-text small">
        <span aria-hidden="true">⚠ </span>
        {t('dispute.untrusted')}
      </p>
      <Positions d={d} />
      <Options d={d} choice={choice} pick={setChoice} />
      <TimeLeft deadline={deadline} queued={queued} text="dispute.timeout" />
      <div className="row end">
        <button type="button" className="dispute-reject" onClick={reject}>
          {t('dispute.reject')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!choice}
          onClick={() => {
            if (d.options.some((o) => o.id === choice && o.truncated !== true))
              void answerConfirm(c.confirmId, true, choice);
          }}
        >
          {t('dispute.choose')}
        </button>
      </div>
    </Modal>
  );
}
