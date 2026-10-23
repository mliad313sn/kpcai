/**
 * The fork dialog (R-403) and the model/protocol fields it shares with the replay dialog
 * (ReplayDialog.tsx). A fork plans a new run from this node with an optional edit; the
 * plan (likely cost and cap) shows before anything runs, and it spends only through the
 * kernel's budget gate.
 */
import { useState } from 'react';
import { t, type Key } from '../i18n/core';
import type { Ref } from '../rpc/schemas';
import { planFork, type NodeEditInput, type Protocol } from '../store/learning';
import { refKey } from '../store/reducer';
import { useStudio } from '../store/store';
import { Modal } from './Modal';

const PROTOCOLS: Array<[Protocol, Key]> = [
  ['solo', 'protocol.solo'],
  ['author_critic', 'protocol.author_critic'],
  ['debate', 'protocol.debate'],
  ['vote', 'protocol.vote'],
];

export type EditMode = 'replay' | 'fork';

export function toRef(v: string): Ref | undefined {
  const [provider, ...rest] = v.split('/');
  return provider && rest.length ? { provider, model: rest.join('/') } : undefined;
}

export function Fields(props: {
  mode: EditMode;
  model: string;
  setModel: (v: string) => void;
  protocol: string;
  setProtocol: (v: string) => void;
}) {
  const models = useStudio((s) => s.models);
  const { mode } = props;
  return (
    <div className="form-grid">
      <label htmlFor={`${mode}-model`}>{t('edit.model')}</label>
      <select
        id={`${mode}-model`}
        value={props.model}
        onChange={(e) => props.setModel(e.target.value)}
      >
        <option value="">{t('edit.routed')}</option>
        {models.map((m) => (
          <option key={refKey(m)} value={refKey(m)}>
            {refKey(m)}
          </option>
        ))}
      </select>
      <label htmlFor={`${mode}-protocol`}>{t('edit.protocol')}</label>
      <select
        id={`${mode}-protocol`}
        value={props.protocol}
        onChange={(e) => props.setProtocol(e.target.value)}
      >
        <option value="">{t('nodeEdit.asRecorded')}</option>
        {PROTOCOLS.map(([p, key]) => (
          <option key={p} value={p}>
            {t(key)}
          </option>
        ))}
      </select>
    </div>
  );
}

function Instruction({ value, set }: { value: string; set: (v: string) => void }) {
  return (
    <>
      <label htmlFor="fork-instruction">{t('fork.instruction')}</label>
      <textarea
        id="fork-instruction"
        rows={3}
        maxLength={10_000}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </>
  );
}

function Footer({ onClose }: { onClose: () => void }) {
  return (
    <>
      <p className="muted small" id="fork-note">
        {t('fork.note')}
      </p>
      <div className="row end">
        <button type="button" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="primary" aria-describedby="fork-note">
          {t('fork.submit')}
        </button>
      </div>
    </>
  );
}

/** The fork form (model, protocol, instruction) in a dialog; Escape cancels. */
export function ForkDialog(props: { runId: string; nodeId: string; onClose: () => void }) {
  const { runId, nodeId, onClose } = props;
  const [model, setModel] = useState('');
  const [protocol, setProtocol] = useState('');
  const [instruction, setInstruction] = useState('');
  const ref = toRef(model);
  const text = instruction.trim();
  const edit: NodeEditInput = {
    ...(ref ? { model: ref } : {}),
    ...(protocol ? { protocol: protocol as Protocol } : {}),
    ...(text ? { instruction: text } : {}),
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onClose();
    void planFork(runId, nodeId, edit);
  };
  return (
    <Modal labelledBy="fork-title" describedBy="fork-help" onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id="fork-title">{t('fork.dialogTitle', { id: nodeId })}</h2>
        <p id="fork-help" className="muted">
          {t('fork.help')}
        </p>
        <Fields {...{ mode: 'fork' as const, model, setModel, protocol, setProtocol }} />
        <Instruction value={instruction} set={setInstruction} />
        <Footer onClose={onClose} />
      </form>
    </Modal>
  );
}
