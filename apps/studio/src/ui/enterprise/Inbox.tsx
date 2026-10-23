/**
 * Sponsor inbox (design §14.3, S10 R8). A consequential ask shows the assurance label of
 * the run it is about (R5); Approve unlocks only once its evidence was opened, which the
 * kernel journals (`program.viewed`). Trivial asks are batched into one decision. There is
 * no "approve all" for consequential asks, and silence is always a no.
 */
import { t } from '../../i18n/core';
import { splitInbox } from '../../enterprise/derive';
import type { InboxItem, ResultEntry } from '../../enterprise/schemas';
import { answer, answerBatch, canApprove, toggleEvidence } from '../../enterprise/actions';
import { patchUi, useEnt } from '../../enterprise/store';
import { formatUsd } from '../../store/format';
import { useNow } from '../hooks';
import { RefButton } from './Activity';
import { AssuranceBadge, Quoted, formatAge } from './parts';

function Evidence({ item }: { item: InboxItem }) {
  return (
    <div id={`evidence-${item.escalationId}`} className="evidence-panel">
      <p className="small">
        {t('ent.inbox.rule')} <span className="mono">{item.rule}</span>
      </p>
      {item.evidence.length === 0 ? (
        <p className="small tone-warn">{t('ent.inbox.noEvidence')}</p>
      ) : (
        <ul className="plain refs">
          {item.evidence.map((r) => (
            <li key={`${r.kind}:${r.id}`}>
              <RefButton r={r} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Waiting({ item }: { item: InboxItem }) {
  const now = useNow(30_000);
  const at = item.askedAt ? Date.parse(item.askedAt) : NaN;
  if (!Number.isFinite(at)) return null;
  return (
    <span className="small muted">{t('ent.inbox.waiting', { age: formatAge(now - at) })}</span>
  );
}

function Answers({ item }: { item: InboxItem }) {
  const open = useEnt((s) => s.ui.evidenceOpen === item.escalationId);
  const viewed = item.viewed === true;
  const locked = !canApprove(item);
  const hint = `hint-${item.escalationId}`;
  return (
    <div className="row end">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`evidence-${item.escalationId}`}
        onClick={() => void toggleEvidence(item)}
      >
        {t(open ? 'ent.inbox.hideEvidence' : 'ent.inbox.openEvidence', {
          count: item.evidence.length,
        })}
      </button>
      <button type="button" onClick={() => void answer(item, false)}>
        {t('ent.inbox.decline')}
      </button>
      <button
        type="button"
        className="primary"
        aria-disabled={locked}
        aria-describedby={locked ? hint : undefined}
        onClick={() => void answer(item, true)}
      >
        {t('ent.inbox.approve')}
      </button>
      {locked ? (
        <span id={hint} className="small muted">
          {t('ent.inbox.openFirst')}
        </span>
      ) : viewed ? (
        <span className="small muted">{t('ent.inbox.viewed')}</span>
      ) : null}
    </div>
  );
}

/** The delivered run an ask is about: by a `run` reference, else by its work package. */
function resultFor(item: InboxItem, results: readonly ResultEntry[]): ResultEntry | undefined {
  const runs = new Set(item.evidence.filter((r) => r.kind === 'run').map((r) => r.id));
  const wp = item.subject?.wpId;
  return (
    results.find((r) => runs.has(r.runId)) ??
    (wp ? results.findLast((r) => r.programId === item.programId && r.wpId === wp) : undefined)
  );
}

function Subject({ item }: { item: InboxItem }) {
  const result = useEnt((s) => resultFor(item, s.data.results));
  return (
    <>
      {item.subject ? (
        <p className="small">
          {t('ent.inbox.subject', { wp: item.subject.wpId, cap: formatUsd(item.subject.capUsd) })}
        </p>
      ) : null}
      {result ? <AssuranceBadge label={result.assurance} why={result.basis} /> : null}
    </>
  );
}

function Ask({ item }: { item: InboxItem }) {
  const open = useEnt((s) => s.ui.evidenceOpen === item.escalationId);
  return (
    <li>
      <article
        id={`ask-${item.escalationId}`}
        tabIndex={-1}
        className="ask"
        aria-labelledby={`ask-q-${item.escalationId}`}
      >
        <div className="row">
          <span className="tag mono">{item.programId}</span>
          <Waiting item={item} />
        </div>
        <p id={`ask-q-${item.escalationId}`} className="ask-q">
          <Quoted text={item.question} />
        </p>
        <Subject item={item} />
        {open ? <Evidence item={item} /> : null}
        <Answers item={item} />
      </article>
    </li>
  );
}

function Batch({ items }: { items: InboxItem[] }) {
  const open = useEnt((s) => s.ui.batchOpen);
  if (items.length === 0) return null;
  return (
    <section className="batch" aria-labelledby="batch-h">
      <div className="row">
        <h4 id="batch-h">{t('ent.inbox.batchTitle', { count: items.length })}</h4>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="batch-list"
          onClick={() => patchUi({ batchOpen: !open })}
        >
          {t(open ? 'ent.inbox.batchHide' : 'ent.inbox.batchReview')}
        </button>
      </div>
      <p className="small muted">{t('ent.inbox.batchWhy')}</p>
      {open ? (
        <>
          <ul id="batch-list" className="plain small">
            {items.map((i) => (
              <li key={i.escalationId}>
                <span className="tag mono">{i.programId}</span> <Quoted text={i.question} />
              </li>
            ))}
          </ul>
          <div className="row end">
            <button type="button" onClick={() => void answerBatch(items, false)}>
              {t('ent.inbox.batchDecline', { count: items.length })}
            </button>
            <button type="button" className="primary" onClick={() => void answerBatch(items, true)}>
              {t('ent.inbox.batchApprove', { count: items.length })}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function Inbox() {
  const items = useEnt((s) => s.data.inbox);
  const { consequential, trivial } = splitInbox(items);
  return (
    <section className="inbox panel" aria-labelledby="ent-inbox-h">
      <h3 id="ent-inbox-h">{t('ent.inbox.title', { count: items.length })}</h3>
      {items.length === 0 ? <p className="muted empty">{t('ent.inbox.empty')}</p> : null}
      {consequential.length ? (
        <ul className="plain asks">
          {consequential.map((i) => (
            <Ask key={i.escalationId} item={i} />
          ))}
        </ul>
      ) : null}
      <Batch items={trivial} />
      <p className="small muted">{t('ent.inbox.silence')}</p>
    </section>
  );
}
