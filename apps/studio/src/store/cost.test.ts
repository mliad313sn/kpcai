import { describe, expect, it } from 'vitest';
import { setLocale } from '../i18n/core';
import { GraphEstimateSchema } from '../rpc/schemas';
import { ESTIMATE } from '../test-helpers/fixtures';
import { costLine, costOf } from './cost';

const est = (o: Record<string, unknown>) => GraphEstimateSchema.parse({ ...ESTIMATE, ...o });

describe('D-021 cost figures', () => {
  it('uses the kernel figures: likely cost and the cap at the band top', () => {
    expect(costOf(est({}))).toMatchObject({ expected: 0.4, cap: 0.5 });
    expect(costLine(est({}))).toBe(
      'Estimate: likely $0.40 · at most $0.50 (hard cap) · partly calibrated',
    );
    setLocale('fr');
    expect(costLine(est({}))).toMatch(
      /^Estimation : probablement 0,40\s\$ · au plus 0,50\s\$ \(plafond strict\) · en partie calibrée$/,
    );
    setLocale('en');
  });

  it('derives them from an older kernel: node sum and the larger of band top and total', () => {
    const old = { expectedUsd: undefined, capUsd: undefined };
    const wide = costOf(est({ ...old, band: { lowUsd: 0.1, highUsd: 0.7, basis: 'mixed' } }));
    expect(wide.expected).toBeCloseTo(0.4);
    expect(wide.cap).toBe(0.7);
    expect(wide.band).toEqual({ lowUsd: 0.1, highUsd: 0.7, basis: 'mixed' });
    const noBand = costOf(est({ ...old, band: undefined }));
    expect(noBand.expected).toBeCloseTo(0.4);
    expect(noBand.cap).toBe(0.4);
    expect(noBand.band).toEqual({ lowUsd: 0.15, highUsd: 0.4, basis: 'heuristic' });
    expect(costOf(est({ ...old, nodes: [], totalUsd: 0.2 })).expected).toBe(0.2);
    // The likely figure never shows above the cap.
    expect(costOf(est({ expectedUsd: 0.9 })).expected).toBe(0.5);
  });
});
