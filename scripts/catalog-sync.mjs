#!/usr/bin/env node
// Compares provider YAML descriptors with the models.dev catalog (MIT) and prints
// a price/limit diff. It NEVER writes: YAML stays the human-edited source of truth.
//
// Usage: node scripts/catalog-sync.mjs [source] [--dir <descriptors>]... [--map id=key]... [--check]
//   source   models.dev api.json as a URL or a file path (default https://models.dev/api.json)
//   --dir    extra descriptor directory (e.g. $KPAI_HOME/providers); later ids override
//   --map    descriptor id -> models.dev provider key, when they differ
//   --check  exit 1 when there is at least one difference (for CI)
// Needs a build first (pnpm build): it reuses @kernelpai/providers from dist/.
import { readFile } from 'node:fs/promises';

const DEFAULT_SOURCE = 'https://models.dev/api.json';
const providers = new URL('../packages/providers/dist/index.js', import.meta.url);

function parseArgs(argv) {
  const opts = { source: DEFAULT_SOURCE, dirs: [], map: {}, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--dir') opts.dirs.push(argv[++i]);
    else if (a === '--map') {
      const [id, key] = String(argv[++i]).split('=');
      if (!id || !key) throw new Error('--map expects id=key');
      opts.map[id] = key;
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else opts.source = a;
  }
  return opts;
}

async function loadCatalog(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${source}`);
    return res.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { BUILTIN_DESCRIPTOR_DIR, loadDescriptors, catalogDiff, formatCatalogDiff } = await import(
    providers.href
  );
  const descriptors = loadDescriptors([BUILTIN_DESCRIPTOR_DIR, ...opts.dirs]);
  const diff = catalogDiff(descriptors, await loadCatalog(opts.source), opts.map);
  console.log(`catalog: ${opts.source}`);
  console.log(formatCatalogDiff(diff));
  if (opts.check && diff.changes.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`catalog-sync: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
