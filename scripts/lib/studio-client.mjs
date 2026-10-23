import { spawn } from 'node:child_process';

/**
 * Starts `kpai studio [...args]` and resolves once it printed its URL: `{ child, url, port, token,
 * stop }`. `stop()` sends Ctrl+C (SIGINT) and resolves with the exit code; Windows has no
 * SIGINT for child processes, so there the server is killed instead.
 */
export function startStudio(bin, { cwd, env, args = [], timeoutMs = 20_000 }) {
  const child = spawn(process.execPath, [bin, 'studio', ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const stop = async () => {
    child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGINT');
    const code = await exited;
    return { code, stderr: err };
  };
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`kpai studio printed no URL in ${timeoutMs} ms:\n${err}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const m = /KP Studio: (http:\/\/127\.0\.0\.1:(\d+)\/#token=([A-Za-z0-9._~-]+))/.exec(out);
      if (!m) return;
      clearTimeout(guard);
      resolve({ child, url: m[1], port: Number(m[2]), token: m[3], stderr: () => err, stop });
    });
    child.on('exit', (code) => reject(new Error(`kpai studio exited (${code}):\n${err}`)));
  });
}

/**
 * A JSON-RPC 2.0 client on Node's built-in WebSocket, with the same token transport as
 * KP Studio (ADR-0019: the bearer token rides as the second subprotocol). Confirmations
 * (`confirm.request`) go to `client.answer(params)`, which returns a boolean, or
 * `{ ok, choice }` to pick a disputed node's option (R-405); the default is "no".
 */
export function connectRpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, [
    'kernelpai.v1',
    `kernelpai.bearer.${token}`,
  ]);
  const waiting = new Map();
  const watchers = new Set();
  let next = 1;
  const client = {
    notes: [],
    confirms: [],
    answer: () => false,
    call(method, params = {}, timeoutMs = 60_000) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
        waiting.set(id, (m) => {
          clearTimeout(timer);
          if (m.error) reject(Object.assign(new Error(`${method}: ${m.error.message}`), m.error));
          else resolve(m.result);
        });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    },
    /** Resolves with the first notification (past or future) matching `pred`. */
    waitFor(pred, timeoutMs = 30_000, what = 'notification') {
      const hit = client.notes.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = (n) => {
          if (!pred(n)) return;
          clearTimeout(timer);
          watchers.delete(w);
          resolve(n);
        };
        const timer = setTimeout(() => {
          watchers.delete(w);
          reject(new Error(`no ${what} within ${timeoutMs} ms`));
        }, timeoutMs);
        watchers.add(w);
      });
    },
    close: () => ws.close(),
  };
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (typeof m.id === 'number' && !m.method) return waiting.get(m.id)?.(m);
    if (!m.method) return;
    const note = { method: m.method, params: m.params ?? {} };
    client.notes.push(note);
    if (note.method === 'confirm.request') {
      client.confirms.push(note.params);
      const a = client.answer(note.params);
      const body = a && typeof a === 'object' ? a : { ok: a === true };
      void client.call('confirm.answer', { confirmId: note.params.confirmId, ...body });
    }
    for (const w of [...watchers]) w(note);
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(client), { once: true });
    ws.addEventListener('close', (e) => reject(new Error(`WebSocket closed ${e.code}`)), {
      once: true,
    });
  });
}

/** Connects with `token` and resolves with the close code the server answers with. */
export function closeCode(port, token, timeoutMs = 10_000) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, [
    'kernelpai.v1',
    `kernelpai.bearer.${token}`,
  ]);
  return new Promise((resolve) => {
    const timer = setTimeout(() => (ws.close(), resolve(undefined)), timeoutMs);
    ws.addEventListener('close', (e) => (clearTimeout(timer), resolve(e.code)));
  });
}
