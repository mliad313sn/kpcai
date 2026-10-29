/**
 * The live organisation map (design §14.3, R-5E10): every seat with its role, model,
 * source (local, API, subscription) and state. The team view is the default (R7); the
 * departments view groups seats by department (expert). Windowed for hundreds of seats;
 * arrow keys, Page keys, Home and End move between seats; Enter shows a seat's details.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { t } from '../../i18n/core';
import { matchesFilter, orgRows, type OrgRow } from '../../enterprise/derive';
import type { SeatView } from '../../enterprise/schemas';
import { seatKey } from '../../enterprise/state';
import { patchUi, useEnt } from '../../enterprise/store';
import { OrgToolbar, SeatDetail, useOrgMode } from './OrgParts';
import { SeatStateBadge, SourceBadge, kindIcon } from './parts';
import { moveIndex, useSize, useWindowOn } from './virtual';

/** Card geometry in px: the smallest card width, and a fixed row height so the window
 * computes rows without measuring them. Cards share the row's width evenly. */
export const CARD_W = 240;
export const ROW_H = 104;
export const HEAD_H = 44;

interface Layout {
  rows: OrgRow[];
  /** Seats in display order, and the row each one sits in. */
  order: SeatView[];
  rowOf: number[];
}

function layout(seats: SeatView[], mode: 'team' | 'departments', perRow: number): Layout {
  const rows = orgRows(seats, mode, perRow);
  const order: SeatView[] = [];
  const rowOf: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind !== 'seats') return;
    for (const s of r.seats) {
      order.push(s);
      rowOf.push(i);
    }
  });
  return { rows, order, rowOf };
}

function useVisibleSeats(): SeatView[] {
  const seats = useEnt((s) => s.data.seats);
  const { filter, program } = useEnt(
    useShallow((s) => ({ filter: s.ui.filter, program: s.ui.programFilter })),
  );
  return useMemo(
    () => seats.filter((s) => matchesFilter(s, filter) && (!program || s.programId === program)),
    [seats, filter, program],
  );
}

function SeatCard(props: {
  seat: SeatView;
  index: number;
  count: number;
  focused: boolean;
  selected: boolean;
  showDept: boolean;
}) {
  const { seat, index, count } = props;
  return (
    <button
      type="button"
      className={`seat-card seat-${seat.state}`}
      data-seat-index={index}
      tabIndex={props.focused ? 0 : -1}
      aria-pressed={props.selected}
      onClick={() => patchUi({ selectedSeat: props.selected ? undefined : seatKey(seat) })}
    >
      <span className="seat-top">
        <span className="seat-avatar" aria-hidden="true">
          {kindIcon(seat.kind)}
        </span>
        <span className="seat-title">{seat.title}</span>
      </span>
      <span className="seat-meta muted small">
        {props.showDept ? `${seat.department} · ` : ''}
        <span className="mono">
          {seat.model ? `${seat.model.provider}/${seat.model.model}` : t('ent.seat.noModel')}
        </span>
      </span>
      <span className="seat-badges">
        <SeatStateBadge state={seat.state} />
        <SourceBadge source={seat.source} />
        {seat.wpId ? <span className="tag mono">{seat.wpId}</span> : null}
      </span>
      <span className="sr-only">{t('ent.org.position', { n: index + 1, count })}</span>
    </button>
  );
}

function RowView(props: {
  row: OrgRow;
  firstIndex: number;
  count: number;
  focus: number;
  selected: string | undefined;
  showDept: boolean;
  perRow: number;
}) {
  const { row } = props;
  if (row.kind === 'head')
    return (
      <h4 className="org-dept">
        {row.department}{' '}
        <span className="muted small">{t('ent.org.deptCount', { count: row.counts.total })}</span>
      </h4>
    );
  return (
    <div className="org-row" style={{ '--per-row': props.perRow } as CSSProperties}>
      {row.seats.map((seat, i) => (
        <SeatCard
          key={seatKey(seat)}
          seat={seat}
          index={props.firstIndex + i}
          count={props.count}
          focused={props.focus === props.firstIndex + i}
          selected={props.selected === seatKey(seat)}
          showDept={props.showDept}
        />
      ))}
    </div>
  );
}

/** Index of the first seat of every row (heads repeat the next seat's index). */
function firstIndexes(rows: OrgRow[]): number[] {
  let n = 0;
  return rows.map((r) => {
    const at = n;
    if (r.kind === 'seats') n += r.seats.length;
    return at;
  });
}

function useOrgKeys(lay: Layout, perRow: number, reveal: (row: number) => void) {
  const [focus, setFocus] = useState(0);
  const wantFocus = useRef(false);
  const box = useRef<HTMLDivElement | null>(null);
  const count = lay.order.length;
  const current = Math.min(focus, Math.max(0, count - 1));
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    box.current?.querySelector<HTMLElement>(`[data-seat-index="${current}"]`)?.focus();
  }, [current]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const to = moveIndex(e.key, current, count, perRow, 4);
    if (to === undefined) return;
    e.preventDefault();
    wantFocus.current = true;
    reveal(lay.rowOf[to] ?? 0);
    setFocus(to);
    if (to === current)
      box.current?.querySelector<HTMLElement>(`[data-seat-index="${to}"]`)?.focus();
  };
  return { focus: current, onKeyDown, box };
}

function Grid({ seats }: { seats: SeatView[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const size = useSize(ref);
  const mode = useOrgMode();
  const selected = useEnt((s) => s.ui.selectedSeat);
  const perRow = Math.max(1, Math.floor(size.width / CARD_W));
  const lay = useMemo(() => layout(seats, mode, perRow), [seats, mode, perRow]);
  const firsts = useMemo(() => firstIndexes(lay.rows), [lay]);
  const heights = useMemo(() => lay.rows.map((r) => (r.kind === 'head' ? HEAD_H : ROW_H)), [lay]);
  const win = useWindowOn(ref, size, heights);
  const keys = useOrgKeys(lay, perRow, win.reveal);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        keys.box.current = el;
      }}
      className="org-scroll"
      role="group"
      aria-label={t('ent.org.label', { count: seats.length })}
      onScroll={win.onScroll}
      onKeyDown={keys.onKeyDown}
    >
      <div className="vlist" style={{ height: win.total }}>
        <div className="vlist-window" style={{ transform: `translateY(${win.offset}px)` }}>
          {lay.rows.slice(win.start, win.end).map((row, i) => (
            <div className={`org-line org-line-${row.kind}`} key={row.key}>
              <RowView
                row={row}
                firstIndex={firsts[win.start + i] ?? 0}
                count={seats.length}
                focus={keys.focus}
                selected={selected}
                showDept={mode === 'team'}
                perRow={perRow}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function OrgMap() {
  const seats = useVisibleSeats();
  const total = useEnt((s) => s.data.seats.length);
  return (
    <div className="org">
      <OrgToolbar shown={seats.length} />
      {total === 0 ? (
        <p className="muted empty">{t('ent.org.empty')}</p>
      ) : seats.length === 0 ? (
        <p className="muted empty">{t('ent.org.noneMatch')}</p>
      ) : (
        <Grid seats={seats} />
      )}
      <SeatDetail />
    </div>
  );
}
