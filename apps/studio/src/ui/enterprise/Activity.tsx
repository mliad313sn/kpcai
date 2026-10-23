/**
 * Live activity feed (design §14.3): one plain-language line per event, newest first. Lines
 * are built by the kernel from typed events but still shown quoted, as text. Each line's
 * references open the workspace (runs, diffs) or the report. A WAI-ARIA feed, windowed for
 * thousands of lines: Page Down / Page Up and the arrows move between lines.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { t, type Key } from '../../i18n/core';
import type { Activity as ActivityLine, EvidenceRef } from '../../enterprise/schemas';
import { patchUi, useEnt } from '../../enterprise/store';
import { announce, patch } from '../../store/store';
import { ProgramFilter } from './OrgParts';
import { Quoted, clock } from './parts';
import { moveIndex, useWindow } from './virtual';

export const LINE_H = 60;

const REF_KEY: Record<EvidenceRef['kind'], Key> = {
  run: 'ent.ref.run',
  node: 'ent.ref.node',
  event: 'ent.ref.event',
  diff: 'ent.ref.diff',
  report: 'ent.ref.report',
  escalation: 'ent.ref.escalation',
};

/** Where a reference leads: the report archive, the inbox, or the workspace's runs. */
export function openRef(ref: EvidenceRef): void {
  if (ref.kind === 'report') return patchUi({ pane: 'reports' });
  if (ref.kind === 'escalation') {
    document.getElementById(`ask-${ref.id}`)?.focus();
    return;
  }
  patch({ view: 'workspace', tab: ref.kind === 'diff' ? 'diff' : 'runs' });
  announce(t('ent.announce.toWorkspace'));
}

export function RefButton({ r }: { r: EvidenceRef }) {
  return (
    <button type="button" className="ref" onClick={() => openRef(r)}>
      {t(REF_KEY[r.kind], { id: r.id })}
    </button>
  );
}

function Line(props: { line: ActivityLine; index: number; count: number; focused: boolean }) {
  const { line } = props;
  return (
    <article
      className="feed-line"
      data-line-index={props.index}
      tabIndex={props.focused ? 0 : -1}
      aria-posinset={props.index + 1}
      aria-setsize={props.count}
      aria-label={t('ent.feed.lineLabel', {
        time: clock(line.at),
        program: line.programId ?? t('ent.feed.portfolio'),
      })}
    >
      <span className="feed-time mono small muted">{clock(line.at)}</span>
      <span className="tag mono">{line.programId ?? t('ent.feed.portfolio')}</span>
      <Quoted text={line.text} className="feed-text" />
      <span className="feed-refs">
        {line.refs.slice(0, 3).map((r) => (
          <RefButton key={`${r.kind}:${r.id}`} r={r} />
        ))}
      </span>
    </article>
  );
}

function useFeedKeys(count: number, reveal: (row: number) => void) {
  const [focus, setFocus] = useState(0);
  const want = useRef(false);
  const box = useRef<HTMLDivElement | null>(null);
  const current = Math.min(focus, Math.max(0, count - 1));
  useEffect(() => {
    if (!want.current) return;
    want.current = false;
    box.current?.querySelector<HTMLElement>(`[data-line-index="${current}"]`)?.focus();
  }, [current]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.target as HTMLElement).classList.contains('feed-line')) return;
    const to = moveIndex(e.key, current, count, 1, 8);
    if (to === undefined) return;
    e.preventDefault();
    want.current = true;
    reveal(to);
    setFocus(to);
  };
  return { focus: current, onKeyDown, box };
}

function Feed({ lines }: { lines: ActivityLine[] }) {
  const win = useWindow(lines.length, LINE_H);
  const keys = useFeedKeys(lines.length, win.reveal);
  return (
    <div
      ref={(el) => {
        win.ref.current = el;
        keys.box.current = el;
      }}
      className="feed-scroll"
      onScroll={win.onScroll}
      onKeyDown={keys.onKeyDown}
    >
      <div className="vlist" style={{ height: win.total }}>
        <div
          className="vlist-window"
          role="feed"
          aria-label={t('ent.feed.label')}
          aria-busy="false"
          style={{ transform: `translateY(${win.offset}px)` }}
        >
          {lines.slice(win.start, win.end).map((line, i) => (
            <Line
              key={line.seq}
              line={line}
              index={win.start + i}
              count={lines.length}
              focused={keys.focus === win.start + i}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ActivityFeed() {
  const all = useEnt((s) => s.data.activity);
  const program = useEnt((s) => s.ui.programFilter);
  const lines = useMemo(
    () => (program ? all.filter((l) => l.programId === program) : all),
    [all, program],
  );
  return (
    <div className="feed">
      <div className="ent-toolbar">
        <ProgramFilter id="ent-feed-program" />
        <span className="muted small">{t('ent.feed.count', { count: lines.length })}</span>
      </div>
      {lines.length === 0 ? (
        <p className="muted empty">{t('ent.feed.empty')}</p>
      ) : (
        <Feed lines={lines} />
      )}
    </div>
  );
}
