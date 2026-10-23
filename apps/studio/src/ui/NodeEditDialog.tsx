/**
 * Replay and fork dialogs (R-403). A replay reruns one finished node from its recorded
 * inputs with another model and/or protocol, beside the original. A fork plans a new run
 * from this node with an optional edit; the plan (likely cost and cap) shows before
 * anything runs. Both spend only through the kernel's budget gate.
 */
import { useState } from 'react';
import { t, type Key } from '../i18n/core';
import type { Ref } from '../rpc/schemas';
import { planFork, replayNode, type NodeEditInput, type Protocol } from '../store/learning';
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

function toRef(v: string): Ref | undefined {
  const [provider, ...rest] = v.split('/');
  return provider && rest.length ? { provider, model: rest.join('/') } : undefined;
}

function Fields(props: {
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

function Footer({ mode, empty, onClose }: { mode: EditMode; empty: boolean; onClose: () => void }) {
  return (
    <>
      <p className="muted small" id={`${mode}-note`}>
        {t(mode === 'replay' ? 'replay.note' : 'fork.note')}
      </p>
      <div className="row end">
        <button type="button" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          className="primary"
          disabled={empty}
          aria-describedby={`${mode}-note`}
        >
          {t(mode === 'replay' ? 'replay.submit' : 'fork.submit')}
        </button>
      </div>
    </>
  );
}

/** The model/protocol (and, for a fork, instruction) form in a dialog; Escape cancels. */
export function NodeEditDialog(props: {
  mode: EditMode;
  runId: string;
  nodeId: string;
  onClose: () => void;
}) {
  const { mode, runId, nodeId, onClose } = props;
  const [model, setModel] = useState('');
  const [protocol, setProtocol] = useState('');
  const [instruction, setInstruction] = useState('');
  const ref = toRef(model);
  const text = instruction.trim();
  const edit: NodeEditInput = {
    ...(ref ? { model: ref } : {}),
    ...(protocol ? { protocol: protocol as Protocol } : {}),
    ...(mode === 'fork' && text ? { instruction: text } : {}),
  };
  const empty = mode === 'replay' && !ref && !protocol;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (empty) return;
    onClose();
    void (mode === 'replay' ? replayNode(runId, nodeId, edit) : planFork(runId, nodeId, edit));
  };
  return (
    <Modal labelledBy={`${mode}-title`} describedBy={`${mode}-help`} onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id={`${mode}-title`}>
          {t(mode === 'replay' ? 'replay.title' : 'fork.dialogTitle', { id: nodeId })}
        </h2>
        <p id={`${mode}-help`} className="muted">
          {t(mode === 'replay' ? 'replay.help' : 'fork.help')}
        </p>
        <Fields {...{ mode, model, setModel, protocol, setProtocol }} />
        {mode === 'fork' && <Instruction value={instruction} set={setInstruction} />}
        <Footer mode={mode} empty={empty} onClose={onClose} />
      </form>
    </Modal>
  );
}
