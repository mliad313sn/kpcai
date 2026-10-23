import { useRef } from 'react';
import { t, type Key } from '../i18n/core';
import { patch, useStudio } from '../store/store';
import type { Tab } from '../store/types';
import { Conversation } from './Conversation';
import { DiffView } from './DiffView';
import { ArtifactsView } from './ArtifactsView';
import { EvidenceView } from './Evidence';
import { MemoryView } from './MemoryView';
import { RunsView } from './RunsView';
import { ToolsView } from './ToolsView';

export const TABS: Array<{ id: Tab; label: Key }> = [
  { id: 'conversation', label: 'tab.conversation' },
  { id: 'diff', label: 'tab.diff' },
  { id: 'artifacts', label: 'tab.artifacts' },
  { id: 'runs', label: 'tab.runs' },
  { id: 'memory', label: 'tab.memory' },
  { id: 'evidence', label: 'tab.evidence' },
  { id: 'tools', label: 'tab.tools' },
  { id: 'terminal', label: 'tab.terminal' },
  { id: 'files', label: 'tab.files' },
];

function Placeholder({ what }: { what: Key }) {
  return <p className="muted empty">{t(what)}</p>;
}

/** WAI-ARIA tabs with automatic activation: arrows, Home and End move between tabs. */
export function CenterTabs() {
  const tab = useStudio((s) => s.tab);
  const patches = useStudio((s) => (s.activeRunId ? s.runs[s.activeRunId]?.patches.length : 0));
  const pending = useStudio((s) => s.memory.pending.length);
  return (
    <section className="zone zone-center" aria-labelledby="zone-center-heading">
      <h2 id="zone-center-heading" className="sr-only" tabIndex={-1}>
        {t('zone.workspace')}
      </h2>
      <TabList tab={tab} patches={patches ?? 0} pending={pending} />
      <TabPanel tab={tab} />
    </section>
  );
}

function tabLabel(tab: (typeof TABS)[number], patches: number, pending: number): string {
  if (tab.id === 'diff' && patches) return t('tab.diffCount', { count: patches });
  if (tab.id === 'memory' && pending) return t('tab.memoryCount', { count: pending });
  return t(tab.label);
}

function TabList(props: { tab: Tab; patches: number; pending: number }) {
  const { tab: current, patches, pending } = props;
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
    <div role="tablist" aria-label={t('tab.list')} className="tabs">
      {TABS.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={current === tab.id}
          aria-controls={`panel-${tab.id}`}
          tabIndex={current === tab.id ? 0 : -1}
          onClick={() => patch({ tab: tab.id })}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {tabLabel(tab, patches, pending)}
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
      {tab === 'runs' && <RunsView />}
      {tab === 'artifacts' && <ArtifactsView />}
      {tab === 'memory' && <MemoryView />}
      {tab === 'evidence' && <EvidenceView />}
      {tab === 'tools' && <ToolsView />}
      {tab === 'terminal' && <Placeholder what="tab.terminalLater" />}
      {tab === 'files' && <Placeholder what="tab.filesLater" />}
    </div>
  );
}
