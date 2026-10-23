import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import WebSocket from 'ws';
import { FakeKernel, RpcFailure, TOKEN, until } from '../test-helpers/fake-kernel';
import { RpcClient } from './client';
import { isMethodNotFound, rawCall, setRawCaller } from './raw';

let kernel: FakeKernel | undefined;
let client: RpcClient | undefined;

afterEach(async () => {
  client?.close();
  setRawCaller(undefined);
  await kernel?.stop();
});

describe('raw calls for methods the protocol module does not list', () => {
  it('sends them as they are and checks the result with the caller schema', async () => {
    kernel = await new FakeKernel({
      'mcp.status': () => ({ servers: ['a'] }),
      'mcp.odd': () => ({ servers: 3 }),
    }).start();
    client = new RpcClient({
      url: kernel.url,
      token: TOKEN,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      onNotification: () => undefined,
    });
    await expect(rawCall('mcp.status', {}, z.object({}))).rejects.toThrow(
      /Not connected|not connected/i,
    );
    client.connect();
    await until(() => client!.state === 'open');
    setRawCaller(client);
    const schema = z.object({ servers: z.array(z.string()) });
    await expect(rawCall('mcp.status', { x: 1 }, schema)).resolves.toEqual({ servers: ['a'] });
    expect(kernel.calls('mcp.status')).toEqual([{ x: 1 }]);
    await expect(rawCall('mcp.odd', {}, schema)).rejects.toThrow(/does not understand/);
    const missing = await rawCall('mcp.nope', {}, schema).catch((e: unknown) => e);
    expect(isMethodNotFound(missing)).toBe(true);
    kernel.handlers.set('mcp.status', () => {
      throw new RpcFailure(-32003, 'refused');
    });
    const refused = await rawCall('mcp.status', {}, schema).catch((e: unknown) => e);
    expect(isMethodNotFound(refused)).toBe(false);
    expect(isMethodNotFound(new Error('x'))).toBe(false);
  });
});
