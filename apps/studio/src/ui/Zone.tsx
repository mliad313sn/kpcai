import type { ReactNode } from 'react';
import { clampSize, SIZE_LIMITS } from '../store/prefs';
import { setPrefs, useStudio } from '../store/store';
import type { Zone as ZoneName } from '../store/types';

const LABELS: Record<ZoneName, string> = {
  explorer: 'Explorer',
  agents: 'Agents',
  thread: 'Execution thread',
};

export function toggleZone(zone: ZoneName): void {
  setPrefs((p) => ({ ...p, collapsed: { ...p.collapsed, [zone]: !p.collapsed[zone] } }));
}

/** A collapsible landmark region with a focusable heading (Alt+1..5 jumps to it). */
export function Zone(props: {
  zone: ZoneName;
  className?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { zone } = props;
  const collapsed = useStudio((s) => s.prefs.collapsed[zone]);
  const size = useStudio((s) => s.prefs.sizes[zone]);
  const label = LABELS[zone];
  const style = collapsed ? undefined : zone === 'thread' ? { height: size } : { width: size };
  return (
    <section
      className={`zone zone-${zone} ${collapsed ? 'collapsed' : ''} ${props.className ?? ''}`}
      aria-labelledby={`zone-${zone}-heading`}
      style={style}
    >
      <header className="zone-head">
        <h2 id={`zone-${zone}-heading`} tabIndex={-1}>
          {label}
        </h2>
        {!collapsed && props.actions}
        <button
          type="button"
          className="icon-btn"
          aria-expanded={!collapsed}
          aria-controls={`zone-${zone}-body`}
          onClick={() => toggleZone(zone)}
          title={`${collapsed ? 'Show' : 'Hide'} ${label}`}
        >
          <span aria-hidden="true">{collapsed ? '+' : '−'}</span>
          <span className="sr-only">
            {collapsed ? 'Show' : 'Hide'} {label}
          </span>
        </button>
      </header>
      <div id={`zone-${zone}-body`} className="zone-body" hidden={collapsed}>
        {props.children}
      </div>
    </section>
  );
}

const STEP = 16;

/**
 * Keyboard- and pointer-operable splitter (WAI-ARIA window splitter). `invert` is for zones
 * that grow when the handle moves left or up (agents, thread).
 */
export function Splitter(props: { zone: ZoneName; invert?: boolean }) {
  const { zone, invert } = props;
  const size = useStudio((s) => s.prefs.sizes[zone]);
  const collapsed = useStudio((s) => s.prefs.collapsed[zone]);
  if (collapsed) return null;
  const vertical = zone !== 'thread';
  const resize = (px: number) =>
    setPrefs((p) => ({ ...p, sizes: { ...p.sizes, [zone]: clampSize(zone, px) } }));
  const onKey = (e: React.KeyboardEvent) => {
    const grow = vertical ? (invert ? 'ArrowLeft' : 'ArrowRight') : 'ArrowUp';
    const shrink = vertical ? (invert ? 'ArrowRight' : 'ArrowLeft') : 'ArrowDown';
    if (e.key === grow) resize(size + STEP);
    else if (e.key === shrink) resize(size - STEP);
    else if (e.key === 'Home') resize(SIZE_LIMITS[zone].min);
    else if (e.key === 'End') resize(SIZE_LIMITS[zone].max);
    else return;
    e.preventDefault();
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const start = vertical ? e.clientX : e.clientY;
    const sign = vertical ? (invert ? -1 : 1) : -1;
    const move = (ev: PointerEvent) =>
      resize(size + sign * ((vertical ? ev.clientX : ev.clientY) - start));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={`Resize ${LABELS[zone]}`}
      aria-controls={`zone-${zone}-body`}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-valuenow={size}
      aria-valuemin={SIZE_LIMITS[zone].min}
      aria-valuemax={SIZE_LIMITS[zone].max}
      className={`splitter ${vertical ? 'splitter-v' : 'splitter-h'}`}
      onKeyDown={onKey}
      onPointerDown={onPointerDown}
    />
  );
}
