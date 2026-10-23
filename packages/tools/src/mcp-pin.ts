/**
 * MCP pins (R-501, ADR-0032): what a person approved of each MCP server, kept in
 * `$KPAI_HOME/mcp-pins.json` apart from the user-authored allow-list (`mcp.json`).
 * A pin holds the server's version and a SHA-256 over its tool list (names, titles,
 * descriptions, input schemas, annotations). Any difference blocks the server.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { stripControls } from './text.js';

export const MCP_PINS_FILE = 'mcp-pins.json';

/** The parts of a tool that reach a model or decide its risk. */
export interface ToolSnapshot {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
}

const SnapshotSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.unknown(),
  annotations: z.unknown().optional(),
});

const PinSchema = z.object({
  version: z.string(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  approvedAt: z.string(),
  tools: z.array(SnapshotSchema).default([]),
});
export type McpPin = z.infer<typeof PinSchema>;

const PinsSchema = z.object({ servers: z.record(z.string(), PinSchema).default({}) });
export type McpPins = z.infer<typeof PinsSchema>;

/** JSON with object keys sorted at every depth, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function snapshotTools(tools: readonly Tool[]): ToolSnapshot[] {
  return tools
    .map((t) => {
      const s: ToolSnapshot = { name: t.name, inputSchema: t.inputSchema ?? null };
      if (t.title !== undefined) s.title = t.title;
      if (t.description !== undefined) s.description = t.description;
      if (t.annotations !== undefined) s.annotations = t.annotations;
      return s;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** SHA-256 (hex) of the canonical tool list. Order of tools and of keys does not matter. */
export function toolsHash(tools: readonly ToolSnapshot[]): string {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(canonicalJson(sorted)).digest('hex');
}

export async function loadPins(kpaiHome: string): Promise<McpPins> {
  let raw: string;
  try {
    raw = await readFile(path.join(kpaiHome, MCP_PINS_FILE), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { servers: {} };
    throw err;
  }
  return PinsSchema.parse(JSON.parse(raw));
}

/** Atomic write (temp file + rename), so a crash never leaves a half-written pin file. */
export async function savePins(kpaiHome: string, pins: McpPins): Promise<void> {
  await mkdir(kpaiHome, { recursive: true });
  const file = path.join(kpaiHome, MCP_PINS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(pins, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

/** What the server looks like now, against its pin. */
export interface PinCheck {
  status: 'approved' | 'unapproved' | 'changed';
  /** Why a server is not approved (human-readable, journal-safe). */
  reason?: string;
  /** Per-tool differences, for `kpai mcp approve` to show. */
  changes: string[];
}

const short = (h: string): string => h.slice(0, 12);

/**
 * A server-chosen name or version as it may appear in a block reason. The reason reaches
 * models as the refused call's result, so a blocked server must not speak through it
 * (WP7-F3): only a short run of name characters, anything else shown as `?`.
 */
export function safeToken(s: string): string {
  const t = s.replace(/[^A-Za-z0-9_.:@/+-]/g, '?');
  return t.length > 64 ? `${t.slice(0, 64)}…` : t;
}

/** Tool-level differences between the approved list and the current one. */
export function diffTools(before: readonly ToolSnapshot[], now: readonly ToolSnapshot[]): string[] {
  const old = new Map(before.map((t) => [t.name, t]));
  const out: string[] = [];
  for (const t of now) {
    const o = old.get(t.name);
    old.delete(t.name);
    if (!o) {
      out.push(`tool "${safeToken(t.name)}" was added`);
      continue;
    }
    for (const key of ['title', 'description', 'inputSchema', 'annotations'] as const) {
      if (canonicalJson(o[key] ?? null) !== canonicalJson(t[key] ?? null)) {
        const what = key === 'inputSchema' ? 'input schema' : key;
        out.push(`the ${what} of tool "${safeToken(t.name)}" changed`);
      }
    }
  }
  for (const name of old.keys()) out.push(`tool "${safeToken(name)}" was removed`);
  return out.map((s) => stripControls(s).slice(0, 200));
}

/** Compares a server's version and tool list with its pin. */
export function checkPin(
  server: string,
  pin: McpPin | undefined,
  version: string,
  tools: readonly ToolSnapshot[],
): PinCheck {
  const approve = `run \`kpai mcp approve ${server}\` after reviewing it`;
  if (!pin) {
    return {
      status: 'unapproved',
      reason: `MCP server "${server}" has not been approved yet; no call reaches it until a person approves it: ${approve}`,
      changes: [],
    };
  }
  const hash = toolsHash(tools);
  const changes = diffTools(pin.tools, tools);
  if (pin.version !== version) {
    changes.unshift(`version changed from ${safeToken(pin.version)} to ${safeToken(version)}`);
  }
  if (hash === pin.hash && pin.version === version) return { status: 'approved', changes: [] };
  const first = changes[0] ?? 'its tool list changed';
  return {
    status: 'changed',
    reason: stripControls(
      `MCP server "${server}" is blocked: ${first} since it was approved (pinned ${short(pin.hash)}, now ${short(hash)}). Every call is refused until a person re-approves it: ${approve}`,
    ).slice(0, 600),
    changes,
  };
}

export function makePin(version: string, tools: readonly ToolSnapshot[], now = new Date()): McpPin {
  return { version, hash: toolsHash(tools), approvedAt: now.toISOString(), tools: [...tools] };
}
