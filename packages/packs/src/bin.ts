#!/usr/bin/env node
import { checkPackFiles } from './check.js';

/** `kpai-pack-check <pack.yaml>...` — validates pack files; exit 1 when any is invalid. */
const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('usage: kpai-pack-check <pack.yaml> [more.yaml...]\n');
  process.exit(2);
}
const reports = await checkPackFiles(files);
for (const r of reports) process.stdout.write(`${r.lines.join('\n')}\n`);
process.exit(reports.every((r) => r.ok) ? 0 : 1);
