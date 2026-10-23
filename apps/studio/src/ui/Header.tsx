import { useState } from 'react';
import { connect } from '../connection';
import { t, type Key, type LocalePref } from '../i18n/core';
import { isValidToken } from '../rpc/token';
import { patch, setPrefs, useStudio } from '../store/store';
import { useEnt } from '../enterprise/store';
import { showView } from './hooks';
import { Modal } from './Modal';
import { nextTheme } from './Palette';

const CONN: Record<string, { icon: string; key: Key }> = {
  idle: { icon: '○', key: 'conn.idle' },
  connecting: { icon: '◌', key: 'conn.connecting' },
  open: { icon: '●', key: 'conn.open' },
  reconnecting: { icon: '◌', key: 'conn.reconnecting' },
  closed: { icon: '○', key: 'conn.closed' },
  unauthorized: { icon: '⚠', key: 'conn.unauthorized' },
};

const THEME: Record<string, Key> = {
  system: 'theme.system',
  dark: 'theme.dark',
  light: 'theme.light',
};

/** Language switch; each language is named in itself so anyone can find theirs. */
export function LanguageSelect() {
  const locale = useStudio((s) => s.prefs.locale);
  return (
    <span className="lang">
      <label htmlFor="lang-select">{t('header.language')}</label>
      <select
        id="lang-select"
        value={locale}
        onChange={(e) => setPrefs((p) => ({ ...p, locale: e.target.value as LocalePref }))}
      >
        <option value="system">{t('lang.system')}</option>
        <option value="en" lang="en">
          English
        </option>
        <option value="fr" lang="fr">
          Français
        </option>
      </select>
    </span>
  );
}

/** Workspace or Enterprise view (R-5E10); Alt+E switches too. */
function ViewSwitch() {
  const view = useStudio((s) => s.view);
  const asks = useEnt((s) => (s.ui.status === 'ready' ? s.data.inbox.length : 0));
  return (
    <nav aria-label={t('view.label')} className="view-switch segmented">
      <button
        type="button"
        aria-current={view === 'workspace' ? 'page' : undefined}
        onClick={() => showView('workspace')}
      >
        {t('view.workspace')}
      </button>
      <button
        type="button"
        aria-current={view === 'enterprise' ? 'page' : undefined}
        onClick={() => showView('enterprise')}
        aria-keyshortcuts="Alt+E"
      >
        {asks ? t('view.enterpriseAsks', { count: asks }) : t('view.enterprise')}
      </button>
    </nav>
  );
}

export function Header({ url }: { url: string }) {
  const conn = useStudio((s) => s.conn);
  const detail = useStudio((s) => s.connDetail);
  const prefs = useStudio((s) => s.prefs);
  const c = CONN[conn] ?? CONN.idle!;
  return (
    <header className="app-header">
      <h1 className="brand">KP Studio</h1>
      <p className={`conn conn-${conn}`} title={detail}>
        <span aria-hidden="true">{c.icon} </span>
        {t(c.key)}
        {detail && conn !== 'open' ? <span className="muted small"> ({detail})</span> : null}
      </p>
      <ViewSwitch />
      <span className="spacer" />
      <button type="button" onClick={() => patch({ paletteOpen: true })}>
        {t('header.commands')} <kbd>Ctrl K</kbd>
      </button>
      <button type="button" onClick={() => setPrefs((p) => ({ ...p, theme: nextTheme(p.theme) }))}>
        {t('header.theme', { theme: t(THEME[prefs.theme]!) })}
      </button>
      <button
        type="button"
        aria-pressed={prefs.density === 'compact'}
        onClick={() =>
          setPrefs((p) => ({ ...p, density: p.density === 'compact' ? 'comfortable' : 'compact' }))
        }
      >
        {t('header.compact')}
      </button>
      <LanguageSelect />
      {(conn === 'unauthorized' || conn === 'idle') && <TokenPrompt url={url} />}
    </header>
  );
}

/** Shown when no token came in the URL fragment, or the kernel refused it. */
export function TokenPrompt({ url }: { url: string }) {
  const [token, setToken] = useState('');
  const [open, setOpen] = useState(true);
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)}>
        {t('token.enter')}
      </button>
    );
  const valid = isValidToken(token.trim());
  return (
    <Modal labelledBy="token-title" describedBy="token-help" onClose={() => setOpen(false)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          setOpen(false);
          connect(url, token.trim());
        }}
      >
        <h2 id="token-title">{t('token.title')}</h2>
        <p id="token-help" className="muted">
          {t('token.help', { command: 'kpai studio', file: '$KPAI_HOME/server.json' })}
        </p>
        <label htmlFor="token-input">{t('token.label')}</label>
        <input
          id="token-input"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="row end">
          <button type="button" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {t('token.connect')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
