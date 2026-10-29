/** Org map toolbar (team or departments, filters) and the selected seat's details. */
import { useShallow } from 'zustand/react/shallow';
import { t } from '../../i18n/core';
import type { SeatFilter } from '../../enterprise/derive';
import { seatKey } from '../../enterprise/state';
import { patchUi, saveOrgMode, useEnt, type OrgMode } from '../../enterprise/store';
import { announce, patch, useStudio } from '../../store/store';
import { SeatStateBadge, SourceBadge, kindIcon } from './parts';

const FILTERS: SeatFilter[] = ['all', 'attention', 'working', 'idle'];

function setMode(orgMode: OrgMode): void {
  saveOrgMode(orgMode);
  patchUi({ orgMode });
}

/** Departments are an expert view (Charter §3): other tiers always see one team. */
export function useOrgMode(): OrgMode {
  const expert = useStudio((s) => s.prefs.tier === 'expert');
  const mode = useEnt((s) => s.ui.orgMode);
  return expert ? mode : 'team';
}

/** Program choice shared by the org map and the activity feed. */
export function ProgramFilter({ id }: { id: string }) {
  const programs = useEnt(useShallow((s) => s.data.programs.map((p) => p.programId)));
  const value = useEnt((s) => s.ui.programFilter);
  return (
    <span className="field">
      <label htmlFor={id}>{t('ent.filter.program')}</label>
      <select id={id} value={value} onChange={(e) => patchUi({ programFilter: e.target.value })}>
        <option value="">{t('ent.filter.allPrograms')}</option>
        {programs.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </span>
  );
}

function ModeToggle() {
  const mode = useOrgMode();
  return (
    <span role="group" aria-label={t('ent.org.showAs')} className="segmented">
      {(['team', 'departments'] as const).map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
          {t(m === 'team' ? 'ent.org.team' : 'ent.org.departments')}
        </button>
      ))}
    </span>
  );
}

export function OrgToolbar({ shown }: { shown: number }) {
  const expert = useStudio((s) => s.prefs.tier === 'expert');
  const filter = useEnt((s) => s.ui.filter);
  return (
    <div className="ent-toolbar">
      {expert ? <ModeToggle /> : null}
      <span className="field">
        <label htmlFor="ent-seat-filter">{t('ent.filter.seats')}</label>
        <select
          id="ent-seat-filter"
          value={filter}
          onChange={(e) => patchUi({ filter: e.target.value as SeatFilter })}
        >
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {t(`ent.filter.${f}`)}
            </option>
          ))}
        </select>
      </span>
      <ProgramFilter id="ent-org-program" />
      <span className="muted small">{t('ent.org.shown', { count: shown })}</span>
    </div>
  );
}

function openRun(): void {
  patch({ view: 'workspace', tab: 'runs' });
  announce(t('ent.announce.toWorkspace'));
}

/** The selected seat in words, with its run one click away. */
export function SeatDetail() {
  const seat = useEnt((s) =>
    s.ui.selectedSeat ? s.data.seats.find((x) => seatKey(x) === s.ui.selectedSeat) : undefined,
  );
  if (!seat) return null;
  return (
    <section className="seat-detail" aria-label={t('ent.seat.detail')}>
      <h4>
        <span aria-hidden="true">{kindIcon(seat.kind)} </span>
        {seat.title}
      </h4>
      <dl className="kv">
        <dt>{t('ent.seat.role')}</dt>
        <dd>{seat.kind}</dd>
        <dt>{t('ent.seat.department')}</dt>
        <dd>{seat.department}</dd>
        <dt>{t('ent.seat.program')}</dt>
        <dd className="mono">{seat.programId}</dd>
        <dt>{t('ent.seat.model')}</dt>
        <dd className="mono">
          {seat.model ? `${seat.model.provider}/${seat.model.model}` : t('ent.seat.noModel')}
        </dd>
        <dt>{t('ent.seat.source')}</dt>
        <dd>
          <SourceBadge source={seat.source} />
        </dd>
        <dt>{t('ent.seat.state')}</dt>
        <dd>
          <SeatStateBadge state={seat.state} />
        </dd>
        <dt>{t('ent.seat.wp')}</dt>
        <dd className="mono">{seat.wpId ?? '—'}</dd>
      </dl>
      <div className="row end">
        {seat.runId ? (
          <button type="button" onClick={openRun}>
            {t('ent.seat.openRun', { run: seat.runId })}
          </button>
        ) : null}
        <button type="button" onClick={() => patchUi({ selectedSeat: undefined })}>
          {t('common.close')}
        </button>
      </div>
    </section>
  );
}
