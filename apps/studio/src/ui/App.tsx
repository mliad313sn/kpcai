import { useEffect } from 'react';
import { resolveLocale, t } from '../i18n/core';
import { useStudio } from '../store/store';
import { AgentsBoard } from './AgentsBoard';
import { CenterTabs } from './CenterTabs';
import { CommandBar } from './CommandBar';
import { EnterpriseView } from './enterprise/EnterpriseView';
import { ConfirmModal } from './ConfirmModal';
import { Explorer } from './Explorer';
import { Header } from './Header';
import { useDocumentTitle, useGlobalKeys, useThemeEffect } from './hooks';
import { Onboarding } from './Onboarding';
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
      {t(last.level === 'error' ? 'log.error' : 'log.warning', { message: last.message })}
    </p>
  );
}

/** The display language: `<html lang>` follows it, and the tree re-renders when it changes. */
function useLocale(): string {
  const locale = resolveLocale(useStudio((s) => s.prefs.locale));
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return locale;
}

/** The run console's middle row and thread (spec §4.1). */
function Workspace() {
  return (
    <>
      <main className="middle">
        <Explorer />
        <Splitter zone="explorer" />
        <CenterTabs />
        <Splitter zone="agents" invert />
        <AgentsBoard />
      </main>
      <Splitter zone="thread" />
      <Thread />
    </>
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
  const locale = useLocale();
  const view = useStudio((s) => s.view);
  return (
    <div className="studio" key={locale}>
      <a className="skip-link" href="#command-input">
        {t('app.skip')}
      </a>
      <Header url={url} />
      <CommandBar />
      {view === 'enterprise' ? <EnterpriseView /> : <Workspace />}
      <LastLog />
      <LiveRegion />
      <Palette />
      <ConfirmModal />
      <Onboarding />
    </div>
  );
}
