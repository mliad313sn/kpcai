import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { connect, reportRefusedWs } from './connection';
import { readConnectionSettings } from './rpc/token';
import { App } from './ui/App';
import './styles.css';
import './console.css';
import './learn.css';

const settings = readConnectionSettings(window.location, window.history);
if (settings.wsRefused) reportRefusedWs(settings.url);
// Connect first so the first render already says "connecting" instead of asking for a token.
if (settings.token) connect(settings.url, settings.token);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App url={settings.url} />
  </StrictMode>,
);
