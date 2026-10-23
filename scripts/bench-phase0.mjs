#!/usr/bin/env node
// Micro-benchmarks quoted in docs/PHASE-0-REPORT.md. Run after `pnpm build`.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../packages/journal/dist/index.js';
import {
  BUILTIN_DESCRIPTOR_DIR,
  ProviderRegistry,
  loadDescriptors,
} from '../packages/providers/dist/index.js';

const pct = (xs, p) => xs.sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];
const fmt = (ms) => `${(ms * 1000).toFixed(0)} µs`;
async function time(n, fn) {
  const xs = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    await fn(i);
    xs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return { p50: pct(xs, 0.5), p95: pct(xs, 0.95) };
}

const j = Journal.open(join(mkdtempSync(join(tmpdir(), 'kpai-bench-')), 'j.db'));
const s = j.startSession('bench', '/');
const append = await time(2000, (i) =>
  j.append({ sessionId: s, type: 'call', payload: { i, text: 'x'.repeat(500) } }),
);
const verify = await time(5, () => j.verify());
j.close();

const load = await time(
  50,
  () => new ProviderRegistry(loadDescriptors([BUILTIN_DESCRIPTOR_DIR]), {}),
);
const reg = new ProviderRegistry(loadDescriptors([BUILTIN_DESCRIPTOR_DIR]), {});
const { adapter, model } = reg.resolve('mock/echo');
const req = { model, messages: [{ role: 'user', content: 'ping' }] };
const call = await time(500, async () => {
  for await (const ev of adapter.send(req)) void ev;
});
const estimate = await time(5000, () => adapter.estimate(req));

console.log(`journal append (500-byte payload) p50 ${fmt(append.p50)}  p95 ${fmt(append.p95)}`);
console.log(`journal verify (2000 events)      p50 ${verify.p50.toFixed(1)} ms`);
console.log(`registry load (3 YAML files)      p50 ${load.p50.toFixed(2)} ms`);
console.log(`cost estimate                     p50 ${fmt(estimate.p50)}`);
console.log(`adapter round-trip (mock, no I/O) p50 ${fmt(call.p50)}  p95 ${fmt(call.p95)}`);
