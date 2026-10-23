import { useState } from 'react';
import { connect } from '../connection';
import { isValidToken } from '../rpc/token';
import { patch, setPrefs, useStudio } from '../store/store';
import { Modal } from './Modal';
import { nextTheme } from './Palette';

const CONN: Record<string, { icon: string; text: string }> = {
  idle: { icon: '○', text: 'Not connected' },
  connecting: { icon: '◌', text: 'Connecting…' },
  open: { icon: '●', text: 'Connected to KernelPAI kernel' },
  reconnecting: { icon: '◌', text: 'Reconnecting…' },
  closed: { icon: '○', text: 'Disconnected' },
  unauthorized: { icon: '⚠', text: 'Token refused' },
};

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
        {c.text}
        {detail && conn !== 'open' ? <span className="muted small"> ({detail})</span> : null}
      </p>
      <span className="spacer" />
      <button type="button" onClick={() => patch({ paletteOpen: true })}>
        Commands <kbd>Ctrl K</kbd>
      </button>
      <button type="button" onClick={() => setPrefs((p) => ({ ...p, theme: nextTheme(p.theme) }))}>
        Theme: {prefs.theme}
      </button>
      <button
        type="button"
        aria-pressed={prefs.density === 'compact'}
        onClick={() =>
          setPrefs((p) => ({ ...p, density: p.density === 'compact' ? 'comfortable' : 'compact' }))
        }
      >
        Compact
      </button>
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
        Enter token
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
        <h2 id="token-title">Connect to the KernelPAI kernel</h2>
        <p id="token-help" className="muted">
          Paste the token printed by <span className="mono">kpai serve</span> (also in{' '}
          <span className="mono">$KPAI_HOME/server.json</span>). It stays in this tab.
        </p>
        <label htmlFor="token-input">Token</label>
        <input
          id="token-input"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="row end">
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            Connect
          </button>
        </div>
      </form>
    </Modal>
  );
}
