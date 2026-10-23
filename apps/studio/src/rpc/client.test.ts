import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FakeKernel, NEVER, RpcFailure, TOKEN, until } from '../test-helpers/fake-kernel';
import { RpcClient, RpcError, type ConnState, type RpcClientOptions } from './client';

let kernel: FakeKernel | undefined;
let client: RpcClient | undefined;

afterEach(async () => {
  client?.close();
  await kernel?.stop();
  client = kernel = undefined;
});

async function setup(opts: Partial<RpcClientOptions> = {}, handlers = {}) {
  kernel = await new FakeKernel(handlers).start();
  const states: Array<[ConnState, string | undefined]> = [];
  const notes: Array<[string, unknown]> = [];
  const invalid: string[] = [];
  client = new RpcClient({
    url: kernel.url,
    token: TOKEN,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    onNotification: (n, p) => notes.push([n, p]),
    onState: (s, d) => states.push([s, d]),
    onInvalid: (r) => invalid.push(r),
    backoff: { initialMs: 20, maxMs: 80 },
    ...opts,
  });
  client.connect();
  return { k: kernel, c: client, states, notes, invalid };
}

const open = (c: RpcClient) => until(() => expect(c.state).toBe('open'));

describe('RpcClient', () => {
  it('sends the bearer token as a subprotocol and says hello', async () => {
    const { k, c, states } = await setup();
    await open(c);
    expect(k.protocols).toEqual(['kernelpai.v1', `kernelpai.bearer.${TOKEN}`]);
    expect(k.calls('kernel.hello')).toEqual([{ client: 'kp-studio', protocol: 1 }]);
    expect(states.map((s) => s[0])).toEqual(['connecting', 'open']);
  });

  it('resolves results and rejects error replies with their code', async () => {
    const { c } = await setup(
      {},
      {
        stats: () => ({ calls: 2 }),
        'run.cancel': () => {
          throw new RpcFailure(-32004, 'no such run');
        },
      },
    );
    await open(c);
    await expect(c.call('stats', {})).resolves.toEqual({ calls: 2 });
    const err = await c.call('run.cancel', { runId: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32004);
    expect((err as RpcError).message).toBe('no such run');
  });

  it('rejects invalid params before sending anything', async () => {
    const { k, c } = await setup();
    await open(c);
    const err = (await c.call('run.cancel', { runId: '' }).catch((e: unknown) => e)) as RpcError;
    expect(err.code).toBe('invalid_params');
    expect(k.calls('run.cancel')).toEqual([]);
  });

  it('times out a request that gets no answer', async () => {
    const { c } = await setup({}, { stats: NEVER });
    await open(c);
    const err = (await c.call('stats', {}, 30).catch((e: unknown) => e)) as RpcError;
    expect(err.code).toBe('timeout');
  });

  it('rejects calls while disconnected', async () => {
    const { c } = await setup();
    c.close();
    const err = (await c.call('stats', {}).catch((e: unknown) => e)) as RpcError;
    expect(err.code).toBe('disconnected');
    expect(c.state).toBe('closed');
  });

  it('delivers valid notifications and drops invalid or unknown ones', async () => {
    const { k, c, notes, invalid } = await setup();
    await open(c);
    k.notify('run.state', { runId: 'r1', state: 'paused' });
    k.notify('run.state', { runId: 'r1', state: 'exploded' });
    k.notify('evil.method', {});
    k.sendRaw('{not json');
    k.sendRaw('42');
    k.sendRaw(JSON.stringify({ jsonrpc: '1.0', method: 'log' }));
    k.sendRaw(JSON.stringify({ jsonrpc: '2.0', result: 1 }));
    k.notify('log', { level: 'info', message: 'last' });
    await until(() => expect(notes.at(-1)?.[0]).toBe('log'));
    expect(notes).toEqual([
      ['run.state', { runId: 'r1', state: 'paused' }],
      ['log', { level: 'info', message: 'last' }],
    ]);
    expect(invalid).toEqual([
      'invalid run.state',
      'unknown notification evil.method',
      'unparseable message',
      'not an object',
      'not JSON-RPC 2.0',
      'unexpected message',
    ]);
  });

  it('acknowledges server requests and refuses unknown ones', async () => {
    const { k, c, notes } = await setup();
    await open(c);
    const confirm = {
      confirmId: 'c1',
      kind: 'tool',
      question: 'run rm?',
      risk: 'destructive',
      timeoutMs: 1000,
    };
    k.sendRaw(
      JSON.stringify({ jsonrpc: '2.0', id: 'srv1', method: 'confirm.request', params: confirm }),
    );
    k.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 'srv2', method: 'nope', params: {} }));
    k.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 'srv3', method: 'log', params: {} }));
    await until(() => expect(k.replies).toHaveLength(3));
    expect(notes).toEqual([['confirm.request', confirm]]);
    expect(k.replies).toEqual([
      { jsonrpc: '2.0', id: 'srv1', result: null },
      { jsonrpc: '2.0', id: 'srv2', error: { code: -32601, message: 'unknown method nope' } },
      { jsonrpc: '2.0', id: 'srv3', error: { code: -32602, message: 'invalid params' } },
    ]);
  });

  it('reconnects with backoff after the connection drops, failing pending calls', async () => {
    const { k, c, states } = await setup({}, { stats: NEVER });
    await open(c);
    const pending = c.call('stats', {}).catch((e: unknown) => e);
    k.dropClients();
    expect(((await pending) as RpcError).code).toBe('disconnected');
    await until(() => expect(states.filter((s) => s[0] === 'open')).toHaveLength(2));
    expect(states.map((s) => s[0])).toContain('reconnecting');
    expect(states.find((s) => s[0] === 'reconnecting')?.[1]).toMatch(/retrying in/);
  });

  it('stops on a refused token (close code 4401) without retrying', async () => {
    const { k, c, states } = await setup({ token: 'wrong-token-xyz' });
    await until(() => expect(c.state).toBe('unauthorized'));
    expect(states.at(-1)).toEqual(['unauthorized', 'bad token']);
    await new Promise((r) => setTimeout(r, 60));
    expect(k.received).toEqual([]);
    expect(c.state).toBe('unauthorized');
  });

  it('stops when hello is refused as unauthorized', async () => {
    const { c } = await setup(
      {},
      {
        'kernel.hello': () => {
          throw new RpcFailure(-32001, 'expired');
        },
      },
    );
    await until(() => expect(c.state).toBe('unauthorized'));
  });

  it('treats a kernel without hello as usable', async () => {
    const { c, states } = await setup(
      {},
      {
        'kernel.hello': () => {
          throw new RpcFailure(-32601, 'unknown');
        },
      },
    );
    await open(c);
    expect(states.at(-1)).toEqual(['open', 'unknown']);
  });

  it('reports a constructor failure as closed', async () => {
    class Bad {
      constructor() {
        throw new Error('bad url');
      }
    }
    const { c, states } = await setup({
      WebSocketImpl: Bad as unknown as typeof globalThis.WebSocket,
    });
    expect(c.state).toBe('closed');
    expect(states.at(-1)).toEqual(['closed', 'bad url']);
  });
});
