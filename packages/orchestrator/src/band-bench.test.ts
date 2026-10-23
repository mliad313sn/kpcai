import { describe, expect, it } from 'vitest';
import { runBandBench, summarise, type BenchRow } from './test-helpers/band-bench.js';

const x = (r: BenchRow): string =>
  `${r.hit ? 'hit ' : 'MISS'} ${r.scenario}#${r.round} ${r.basis} low ${r.lowUsd} exp ${r.expectedUsd} high ${r.highUsd} cost ${r.costUsd}`;
const by = (rows: BenchRow[], basis: BenchRow['basis']): BenchRow[] =>
  rows.filter((r) => r.basis === basis);

describe('band benchmark (S8 bug 2, D-021)', () => {
  it('the band contains the realised cost on a calibrated history, and at cold start', async () => {
    const rows = await runBandBench({ rounds: 10, seed: 7 });
    const calibrated = summarise(by(rows, 'calibrated'));
    const heuristic = summarise(by(rows, 'heuristic'));
    const all = summarise(rows);
    console.log(
      JSON.stringify({ calibrated, heuristic, mixed: summarise(by(rows, 'mixed')), all }),
    );
    for (const r of rows.filter((x) => !x.hit || x.round < 2)) console.log(x(r));
    expect(calibrated.n).toBeGreaterThanOrEqual(30);
    expect(calibrated.hitRate).toBeGreaterThanOrEqual(0.8);
    expect(heuristic.n).toBeGreaterThan(0);
    expect(heuristic.hitRate).toBe(1);
    expect(all.hitRate).toBeGreaterThanOrEqual(0.8);
    // D-021: the cap is the band top; on cold start it stays within ~3× the likely cost
    expect(heuristic.medianCapRatio).toBeLessThanOrEqual(3);
    expect(rows.flatMap((r) => r.breaches)).toEqual([]);
  }, 60_000);
});
