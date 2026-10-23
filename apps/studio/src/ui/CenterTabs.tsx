import { useRef } from 'react';
import { patch, useStudio } from '../store/store';
import type { Tab } from '../store/types';
import { Conversation } from './Conversation';
import { DiffView } from './DiffView';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'diff', label: 'Diff' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Files' },
];

function Placeholder({ what }: { what: string }) {
  return (
    <p className="muted empty">
      {what} arrives in phase 5, through the tool bus. Until then use{' '}
      <span className="mono">!</span> in the command bar to send a terminal request to the planner.
    </p>
  );
}

/** WAI-ARIA tabs with automatic activation: arrows, Home and End move between tabs. */
export function CenterTabs() {
  const tab = useStudio((s) => s.tab);
  const patches = useStudio((s) => (s.activeRunId ? s.runs[s.activeRunId]?.patches.length : 0));
  return (
    <section className="zone zone-center" aria-labelledby="zone-center-heading">
      <h2 id="zone-center-heading" className="sr-only" tabIndex={-1}>
        Workspace
      </h2>
      <TabList tab={tab} patches={patches ?? 0} />
      <TabPanel tab={tab} />
    </section>
  );
}

function TabList({ tab, patches }: { tab: Tab; patches: number }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const n = TABS.length;
    const moves: Record<string, number> = {
      ArrowRight: (i + 1) % n,
      ArrowLeft: (i - 1 + n) % n,
      Home: 0,
      End: n - 1,
    };
    const to = moves[e.key] ?? -1;
    if (to < 0) return;
    e.preventDefault();
    patch({ tab: TABS[to]!.id });
    refs.current[to]?.focus();
  };
  return (
    <div role="tablist" aria-label="Workspace views" className="tabs">
      {TABS.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={tab === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => patch({ tab: t.id })}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {t.label}
          {t.id === 'diff' && patches ? ` (${patches})` : ''}
        </button>
      ))}
    </div>
  );
}

function TabPanel({ tab }: { tab: Tab }) {
  return (
    <div
      role="tabpanel"
      id={`panel-${tab}`}
      aria-labelledby={`tab-${tab}`}
      tabIndex={0}
      className="tabpanel"
    >
      {tab === 'conversation' && <Conversation />}
      {tab === 'diff' && <DiffView />}
      {tab === 'terminal' && <Placeholder what="The terminal" />}
      {tab === 'files' && <Placeholder what="The file viewer" />}
    </div>
  );
}
