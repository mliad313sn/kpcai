/**
 * A minimal SMTP client (RFC 5321) for one plain-text message: EHLO, optional AUTH PLAIN,
 * MAIL, RCPT, DATA, QUIT. Plain TCP only to a loopback host (Q-11's "local SMTP");
 * implicit TLS otherwise. The password is read from the environment by the caller and
 * only written to the socket; an outcome carries the reply code, never the reply text.
 */
import { connect as tcp, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { isLoopbackHost } from './config.js';
import type { Outcome } from './http.js';

export interface Mail {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  to: readonly string[];
  subject: string;
  text: string;
  auth?: { user: string; pass: string };
  timeoutMs: number;
  now: Date;
}

class Reader {
  private buf = '';
  private waiters: Array<(line: string) => void> = [];
  private lines: string[] = [];

  constructor(sock: Socket) {
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line);
        else this.lines.push(line);
      }
    });
  }

  private line(): Promise<string> {
    const l = this.lines.shift();
    return l !== undefined ? Promise.resolve(l) : new Promise((r) => this.waiters.push(r));
  }

  /** The code of a complete reply (multi-line replies end with `NNN `). */
  async reply(): Promise<number> {
    for (;;) {
      const l = await this.line();
      if (/^\d{3}(?: |$)/.test(l)) return Number(l.slice(0, 3));
    }
  }
}

/** RFC 2047 for a non-ASCII subject; CR and LF never reach a header. */
function header(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ').slice(0, 300);
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat).toString('base64')}?=`;
}

export function message(m: Mail): string {
  const body = Buffer.from(m.text, 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: <${m.from}>`,
    `To: ${m.to.map((x) => `<${x}>`).join(', ')}`,
    `Subject: ${header(m.subject)}`,
    `Date: ${m.now.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

function open(m: Mail): Socket {
  if (m.secure) return tlsConnect({ host: m.host, port: m.port, servername: m.host });
  if (!isLoopbackHost(m.host)) throw new Error('plain SMTP only to loopback');
  return tcp({ host: m.host, port: m.port });
}

async function dialogue(sock: Socket, r: Reader, m: Mail): Promise<Outcome> {
  const step = async (cmd: string | undefined, want: number): Promise<Outcome | undefined> => {
    if (cmd !== undefined) sock.write(`${cmd}\r\n`);
    const code = await r.reply();
    if (code === want) return undefined;
    return { ok: false, retry: code >= 400 && code < 500, status: `smtp-${code}` };
  };
  const plain = m.auth ? Buffer.from(`\0${m.auth.user}\0${m.auth.pass}`).toString('base64') : '';
  const steps: Array<[string | undefined, number]> = [
    [undefined, 220],
    ['EHLO kpai.localhost', 250],
    ...(m.auth ? [[`AUTH PLAIN ${plain}`, 235] as [string, number]] : []),
    [`MAIL FROM:<${m.from}>`, 250],
    ...m.to.map((x) => [`RCPT TO:<${x}>`, 250] as [string, number]),
    ['DATA', 354],
    [`${message(m).replace(/^\./gm, '..')}\r\n.`, 250],
  ];
  for (const [cmd, want] of steps) {
    const bad = await step(cmd, want);
    if (bad) return bad;
  }
  sock.write('QUIT\r\n');
  return { ok: true, retry: false, status: 'smtp-250' };
}

/** Sends one message; never throws, never returns server text. */
export async function sendMail(m: Mail): Promise<Outcome> {
  let sock: Socket | undefined;
  try {
    const s = open(m);
    sock = s;
    const failed = new Promise<Outcome>((resolve) => {
      // `on`, not `once`: a later socket error (e.g. a reset after QUIT) must never be unhandled.
      s.on('error', () => resolve({ ok: false, retry: true, status: 'network' }));
      s.setTimeout(m.timeoutMs, () => resolve({ ok: false, retry: true, status: 'timeout' }));
      s.once('close', () => resolve({ ok: false, retry: true, status: 'network' }));
    });
    return await Promise.race([dialogue(s, new Reader(s), m), failed]);
  } catch {
    return { ok: false, retry: false, status: 'endpoint-refused' };
  } finally {
    sock?.end();
    sock?.destroy();
  }
}
