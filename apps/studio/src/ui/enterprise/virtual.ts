/**
 * Windowed rendering for long lists (R-5E11: smooth with 500 seats and thousands of feed
 * lines): only the rows in view, plus a few above and below, are in the DOM. Every row has
 * a known height in px (no measuring). Keyboard focus is kept by the callers, which scroll a row into view
 * before focusing it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Used before layout (and in jsdom, which has no layout). */
const FALLBACK = { width: 960, height: 640 };

export interface WindowState {
  ref: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** First and last (exclusive) rendered row. */
  start: number;
  end: number;
  /** Total height and the offset of the first rendered row, px. */
  total: number;
  offset: number;
  width: number;
  /** Scrolls so `row` is fully visible. */
  reveal: (row: number) => void;
}

export function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState(FALLBACK);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setSize({
        width: el.clientWidth || FALLBACK.width,
        height: el.clientHeight || FALLBACK.height,
      });
    measure();
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (!RO) return;
    const ro = new RO(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Top of every row and the total height, from the rows' fixed heights. */
export function rowTops(heights: readonly number[]): { tops: number[]; total: number } {
  const tops: number[] = [];
  let y = 0;
  for (const h of heights) {
    tops.push(y);
    y += h;
  }
  return { tops, total: y };
}

/** Index of the row that contains `y` (binary search over the tops). */
function rowAt(tops: readonly number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

export function windowRange(
  tops: readonly number[],
  scrollTop: number,
  height: number,
  overscan = 4,
): { start: number; end: number } {
  if (tops.length === 0) return { start: 0, end: 0 };
  const first = rowAt(tops, scrollTop);
  const last = rowAt(tops, scrollTop + height);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(tops.length, last + 1 + overscan),
  };
}

export function useWindow(count: number, rowHeight: number): WindowState {
  const ref = useRef<HTMLDivElement | null>(null);
  const heights = useMemo(() => new Array<number>(count).fill(rowHeight), [count, rowHeight]);
  return useWindowOn(ref, useSize(ref), heights);
}

/** `useWindow` on a container the caller already measures (to lay out its rows first). */
export function useWindowOn(
  ref: React.RefObject<HTMLDivElement | null>,
  size: { width: number; height: number },
  heights: readonly number[],
): WindowState {
  const [scrollTop, setScrollTop] = useState(0);
  const { tops, total } = useMemo(() => rowTops(heights), [heights]);
  const onScroll = useCallback(() => setScrollTop(ref.current?.scrollTop ?? 0), [ref]);
  const reveal = useCallback(
    (row: number) => {
      const el = ref.current;
      if (!el) return;
      const top = tops[row] ?? 0;
      const bottom = top + (heights[row] ?? 0);
      const view = el.clientHeight || FALLBACK.height;
      let next = el.scrollTop;
      if (top < next) next = top;
      else if (bottom > next + view) next = bottom - view;
      if (next !== el.scrollTop) el.scrollTop = next;
      setScrollTop(next);
    },
    [ref, tops, heights],
  );
  const { start, end } = windowRange(tops, scrollTop, size.height);
  return { ref, onScroll, start, end, total, offset: tops[start] ?? 0, width: size.width, reveal };
}

/** Index moves for list keys; undefined for keys a list does not handle. */
export function moveIndex(
  key: string,
  index: number,
  count: number,
  perRow = 1,
  page = 10,
): number | undefined {
  const last = count - 1;
  const moves: Record<string, number> = {
    ArrowDown: index + perRow,
    ArrowUp: index - perRow,
    ArrowRight: index + 1,
    ArrowLeft: index - 1,
    PageDown: index + page * perRow,
    PageUp: index - page * perRow,
    Home: 0,
    End: last,
  };
  const to = moves[key];
  if (to === undefined || count === 0) return undefined;
  if (perRow === 1 && (key === 'ArrowRight' || key === 'ArrowLeft')) return undefined;
  return Math.max(0, Math.min(last, to));
}
