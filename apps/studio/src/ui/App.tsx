import { useStudio } from '../store/store';
import { AgentsBoard } from './AgentsBoard';
import { CenterTabs } from './CenterTabs';
import { CommandBar } from './CommandBar';
import { ConfirmModal } from './ConfirmModal';
import { Explorer } from './Explorer';
import { Header } from './Header';
import { useDocumentTitle, useGlobalKeys, useThemeEffect } from './hooks';
import { Palette } from './Palette';
import { Thread } from './Thread';
import { Splitter } from './Zone';

/** Polite announcements of run state changes, plan readiness and confirmations. */
function LiveRegion() {
  const a = useStudio((s) => s.announcement);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {a.text ? <span key={a.seq}>{a.text}</span> : null}
    </div>
  );
}

function LastLog() {
  const last = useStudio((s) => s.logs[s.logs.length - 1]);
  if (!last || last.level === 'info') return null;
  return (
    <p className={`status-line log-${last.level}`}>
      <span aria-hidden="true">{last.level === 'error' ? '✕ ' : '⚠ '}</span>
      {last.level === 'error' ? 'Error: ' : 'Warning: '}
      {last.message}
    </p>
  );
}

/**
 * Spec §4.1: command bar on top; explorer, central tabs and agents board in the middle;
 * the execution thread across the bottom. Every zone but the centre can be resized and hidden.
 */
export function App({ url }: { url: string }) {
  useThemeEffect();
  useGlobalKeys();
  useDocumentTitle();
  return (
    <div className="studio">
      <a className="skip-link" href="#command-input">
        Skip to command bar
      </a>
      <Header url={url} />
      <CommandBar />
      <main className="middle">
        <Explorer />
        <Splitter zone="explorer" />
        <CenterTabs />
        <Splitter zone="agents" invert />
        <AgentsBoard />
      </main>
      <Splitter zone="thread" />
      <Thread />
      <LastLog />
      <LiveRegion />
      <Palette />
      <ConfirmModal />
    </div>
  );
}
