/**
 * `kpai extensions` (R-502, ADR-0033): the workspace's skills, named agents and hooks.
 * Names and descriptions only (repository text is untrusted and shown sanitized); a hook
 * not allow-listed in `$KPAI_HOME/hooks.json` is confirmed each time it runs.
 */
import { listExtensions } from '@kernelpai/kernel';
import { sanitizeForTerminal as clean } from '../sanitize.js';
import type { Io } from '../io.js';

export async function extensionsCommand(io: Io): Promise<number> {
  const e = await listExtensions(io.env, io.cwd);
  const lines: string[] = [];
  const who = (origin: string): string => (origin === 'repo' ? 'repo, untrusted' : 'home');
  for (const s of e.skills) {
    const tools = s.allowedTools ? ` · tools ${s.allowedTools.join(', ')}` : '';
    lines.push(`skill  ${s.name} (${who(s.origin)}): ${clean(s.description)}${tools}`);
  }
  for (const a of e.agents) {
    const tools = a.tools ? ` · tools ${a.tools.join(', ')}` : '';
    const model = a.model ? ` · model hint ${clean(a.model)}` : '';
    lines.push(`agent  ${a.name} (${who(a.origin)}): ${clean(a.description)}${tools}${model}`);
  }
  for (const h of e.hooks) {
    const how = h.allowListed ? 'allow-listed' : 'confirmed each time';
    lines.push(`hook   ${h.name} ${h.event} (${who(h.origin)}, ${how}): ${clean(h.command)}`);
  }
  io.out(lines.length ? `${lines.join('\n')}\n` : 'no skills, agents or hooks\n');
  for (const p of e.problems) io.err(`  – ${clean(p)}\n`);
  return 0;
}
