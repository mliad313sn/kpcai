/** Boot wiring: one RpcClient per page, feeding the store and serving the actions. */
import { loadSnapshot } from './enterprise/actions';
import { enterprise } from './enterprise/store';
import { t, type Key } from './i18n/core';
import { RpcClient, type RpcClientOptions } from './rpc/client';
import { setRawCaller } from './rpc/raw';
import { forgetToken, rememberToken } from './rpc/token';
import { loadModels, loadSessions, setClient } from './store/actions';
import { resetCompetence } from './store/learning';
import { loadPending } from './store/memory';
import { announce, confirmWithdrawn, handleNotification, log, patch, studio } from './store/store';

let current: RpcClient | undefined;

const CONN_TEXT: Record<string, Key> = {
  open: 'conn.announce.open',
  reconnecting: 'conn.announce.reconnecting',
  unauthorized: 'conn.announce.unauthorized',
  closed: 'conn.announce.closed',
};

export function connect(
  url: string,
  token: string,
  extra: Partial<RpcClientOptions> = {},
): RpcClient {
  current?.close();
  const client = new RpcClient({
    url,
    token,
    onNotification: handleNotification,
    onInvalid: (reason) => log('warn', t('conn.invalid', { reason })),
    onConfirmNotice: (_method, params) => confirmWithdrawn(params),
    onState: (state, detail) => {
      patch({ conn: state, connDetail: detail });
      if (CONN_TEXT[state]) announce(t(CONN_TEXT[state]!));
      if (state === 'unauthorized') forgetToken();
      if (state === 'open') {
        rememberToken(token);
        // First run (R-308): the onboarding screen opens once providers are being detected.
        if (!studio.getState().prefs.onboarded) patch({ onboardingOpen: true });
        void loadSessions();
        void loadModels();
        // Model proposals waiting for a human (ADR-0027): the Memory tab shows the count.
        void loadPending(true);
        resetCompetence();
        // A reconnect may have missed notices: an Enterprise view already shown reloads.
        if (enterprise.getState().ui.status !== 'idle') void loadSnapshot();
      }
    },
    ...extra,
  });
  current = client;
  setClient(client);
  setRawCaller(client);
  client.connect();
  return client;
}

/** Review P3-F10: a `ws=` that was not followed is reported, not silently dropped. */
export function reportRefusedWs(url: string): void {
  const body = t('conn.wsRefused', { url });
  log('warn', body);
  patch({ notice: { title: t('notice.connection'), body } });
  announce(body);
}

export function disconnect(): void {
  current?.close();
  current = undefined;
  setClient(undefined);
  setRawCaller(undefined);
}
