/** Where the kernel server is: flags, then `$KPAI_HOME/server.json` (written by `kpai studio`). */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { isLocalWsUrl, isValidToken } from '../../studio/src/rpc/token';

/** Same rule as `kpaiHome` in packages/kernel (not imported: it would load the journal). */
export function kpaiHome(env: Record<string, string | undefined>): string {
  return env['KPAI_HOME']?.trim() || join(homedir(), '.kernelpai');
}

/** The fields of packages/server's `server.json` this client needs. */
const ServerFileSchema = z.looseObject({ url: z.string(), token: z.string() });

export function readServerFile(home: string): { url: string; token: string } | undefined {
  try {
    const r = ServerFileSchema.safeParse(
      JSON.parse(readFileSync(join(home, 'server.json'), 'utf8')),
    );
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export interface Args {
  url?: string;
  token?: string;
  lang?: 'en' | 'fr';
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = argv[i + 1];
    if (v === '--help' || v === '-h') a.help = true;
    else if (v === '--url' && next) a.url = argv[++i];
    else if (v === '--token' && next) a.token = argv[++i];
    else if (v === '--lang' && (next === 'en' || next === 'fr')) a.lang = argv[++i] as 'en' | 'fr';
  }
  return a;
}

export type Located =
  { ok: true; url: string; token: string } | { ok: false; reason: 'noServer' | 'badUrl' };

/** http://127.0.0.1:PORT → ws://127.0.0.1:PORT/rpc */
export function wsUrlOf(httpUrl: string): string {
  return `${httpUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/rpc`;
}

export function locate(args: Args, env: Record<string, string | undefined>): Located {
  const token = args.token ?? env['KPAI_TOKEN'];
  if (args.url) {
    if (!isLocalWsUrl(args.url)) return { ok: false, reason: 'badUrl' };
    return token && isValidToken(token)
      ? { ok: true, url: args.url, token }
      : { ok: false, reason: 'noServer' };
  }
  const file = readServerFile(kpaiHome(env));
  if (file && !/^http:\/\/127\.0\.0\.1:\d+$/.test(file.url)) return { ok: false, reason: 'badUrl' };
  if (!file) return { ok: false, reason: 'noServer' };
  return { ok: true, url: wsUrlOf(file.url), token: token ?? file.token };
}
