/** A local fake SMTP server: accepts one or more messages and records the dialogue. */
import { createServer, type AddressInfo, type Socket } from 'node:net';

export interface FakeSmtp {
  host: string;
  port: number;
  /** Every command line received (AUTH lines included, for the assertion that they go only here). */
  commands: string[];
  /** Decoded message bodies and raw headers. */
  messages: Array<{ headers: string; text: string; from: string; to: string[] }>;
  close(): Promise<void>;
}

/** `reject` answers this code to MAIL FROM (e.g. 451 to test retries) for the first N tries. */
export async function fakeSmtp(
  o: { reject?: { code: number; times: number } } = {},
): Promise<FakeSmtp> {
  const commands: string[] = [];
  const messages: FakeSmtp['messages'] = [];
  let rejects = o.reject?.times ?? 0;
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    // The client may reset the connection after QUIT; that is not a test failure.
    sock.on('error', () => undefined);
    sock.setEncoding('utf8');
    let buf = '';
    let data: string[] | undefined;
    let from = '';
    let to: string[] = [];
    const say = (l: string): boolean => sock.write(`${l}\r\n`);
    say('220 fake.local ESMTP');
    sock.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') {
            const raw = data.join('\r\n');
            const [headers, ...rest] = raw.split('\r\n\r\n');
            const text = Buffer.from(rest.join('').replace(/\r\n/g, ''), 'base64').toString('utf8');
            messages.push({ headers: headers ?? '', text, from, to });
            data = undefined;
            say('250 queued');
          } else data.push(line.replace(/^\.\./, '.'));
          continue;
        }
        commands.push(line);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') say('250-fake.local\r\n250 AUTH PLAIN');
        else if (verb === 'AUTH') say('235 ok');
        else if (verb === 'MAIL') {
          if (rejects > 0) {
            rejects -= 1;
            say(`${o.reject!.code} try later`);
          } else {
            from = line.slice(10).replace(/[<>]/g, '');
            to = [];
            say('250 ok');
          }
        } else if (verb === 'RCPT') {
          to.push(line.slice(8).replace(/[<>]/g, ''));
          say('250 ok');
        } else if (verb === 'DATA') {
          data = [];
          say('354 go');
        } else if (verb === 'QUIT') {
          say('221 bye');
          sock.end();
        } else say('500 what');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    host: '127.0.0.1',
    port,
    commands,
    messages,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
