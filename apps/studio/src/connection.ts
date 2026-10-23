/** Boot wiring: one RpcClient per page, feeding the store and serving the actions. */
import { RpcClient, type RpcClientOptions } from './rpc/client';
import { forgetToken, rememberToken } from './rpc/token';
import { loadModels, loadSessions, setClient } from './store/actions';
import { announce, handleNotification, log, patch } from './store/store';

let current: RpcClient | undefined;

const CONN_TEXT: Record<string, string> = {
  open: 'Connected to the KernelPAI kernel',
  reconnecting: 'Connection lost, reconnecting',
  unauthorized: 'The kernel refused the token',
  closed: 'Disconnected',
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
    onInvalid: (reason) => log('warn', `Ignored a message from the kernel: ${reason}`),
    onState: (state, detail) => {
      patch({ conn: state, connDetail: detail });
      if (CONN_TEXT[state]) announce(CONN_TEXT[state]!);
      if (state === 'unauthorized') forgetToken();
      if (state === 'open') {
        rememberToken(token);
        void loadSessions();
        void loadModels();
      }
    },
    ...extra,
  });
  current = client;
  setClient(client);
  client.connect();
  return client;
}

export function disconnect(): void {
  current?.close();
  current = undefined;
  setClient(undefined);
}
