import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { connect } from './connection';
import { readConnectionSettings } from './rpc/token';
import { App } from './ui/App';
import './styles.css';

const settings = readConnectionSettings(window.location, window.history);
// Connect first so the first render already says "connecting" instead of asking for a token.
if (settings.token) connect(settings.url, settings.token);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App url={settings.url} />
  </StrictMode>,
);
