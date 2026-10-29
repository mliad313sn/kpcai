import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChannelSpecSchema,
  endpointAllowed,
  isLoopbackHost,
  isLocal,
  loadChannels,
  refusal,
  type ChannelsFile,
} from './config.js';

const file = (raw: unknown): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'kpai-ch-')), 'channels.json');
  writeFileSync(p, JSON.stringify(raw));
  return p;
};

describe('channel settings (Q-11)', () => {
  it('always has the local Markdown channel, with safe defaults and nothing third-party', () => {
    const f = loadChannels('/nonexistent/channels.json');
    expect(f).toMatchObject({
      allowThirdParty: false,
      locale: 'en',
      retry: { attempts: 3, baseMs: 1_000 },
    });
    expect(f.channels).toEqual([
      { id: 'markdown', type: 'markdown', summary: false, enabled: true },
    ]);
  });

  it('is strict: unknown keys, secret values in place of names and duplicate ids are errors', () => {
    expect(() => loadChannels(file({ channels: [], allowThirdparty: true }))).toThrow();
    expect(() =>
      loadChannels(
        file({ channels: [{ id: 's', type: 'slack', secretEnv: 'https://hooks.slack.com/x' }] }),
      ),
    ).toThrow(/environment variable name/);
    expect(() =>
      loadChannels(
        file({ channels: [{ id: 's', type: 'slack', secretEnv: 'A', url: 'https://x' }] }),
      ),
    ).toThrow();
    const dup = { id: 'a', type: 'slack', secretEnv: 'A' };
    expect(() => loadChannels(file({ channels: [dup, dup] }))).toThrow(/duplicate/);
    expect(() =>
      ChannelSpecSchema.parse({
        id: 'm',
        type: 'smtp',
        host: 'h',
        from: 'a@b',
        to: ['x\r\nBcc: y@z'],
      }),
    ).toThrow();
  });

  it('counts only the Markdown file and loopback SMTP as local', () => {
    const f = loadChannels(file({ channels: [] })) as ChannelsFile;
    const smtp = (host: string, secure = false) =>
      ChannelSpecSchema.parse({ id: 'm', type: 'smtp', host, secure, from: 'a@b', to: ['c@d'] });
    expect(isLocal(smtp('127.0.0.1'))).toBe(true);
    expect(refusal(smtp('localhost'), f)).toBeUndefined();
    expect(refusal(smtp('mail.example.com', true), f)).toMatch(/Q-11/);
    expect(refusal(smtp('mail.example.com'), { ...f, allowThirdParty: true })).toMatch(/TLS/);
    expect(
      refusal(smtp('mail.example.com', true), { ...f, allowThirdParty: true }),
    ).toBeUndefined();
    const slack = ChannelSpecSchema.parse({ id: 's', type: 'slack', secretEnv: 'X' });
    expect(refusal(slack, f)).toMatch(/third-party/);
    expect(refusal({ ...slack, enabled: false }, { ...f, allowThirdParty: true })).toBe('disabled');
  });

  it('allows plain HTTP only to this machine', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('127.10.0.1')).toBe(true);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
    expect(endpointAllowed('http://127.0.0.1:9/x')).toBe(true);
    expect(endpointAllowed('http://ntfy.example.com')).toBe(false);
    expect(endpointAllowed('https://ntfy.example.com')).toBe(true);
    expect(endpointAllowed('ftp://x')).toBe(false);
    expect(endpointAllowed('not a url')).toBe(false);
  });
});
