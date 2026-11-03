import { describe, expect, it } from 'vitest';
import { makeStation, presetByKey } from '../radio/presets';
import { carrierLabel, siteName, sitesOf } from './sites';

describe('sites', () => {
  const at = (key: string, name: string, lat: number, op = 'op1') => makeStation(presetByKey(key), lat, 24.01, op, name);

  it('groups co-located stations of one operator, keeps others apart', () => {
    const list = [at('lte1800', '140847-L4x', 49.835), at('lte2100', '140847-L3x', 49.835), at('lte1800', 'Other', 49.836), at('lte1800', 'VF-1', 49.835, 'op2')];
    const sites = sitesOf(list);
    expect(sites.map((s) => s.stations.length)).toEqual([2, 1, 1]);
    expect(sites[0].name).toBe('140847');
    expect(carrierLabel(list[1], '140847')).toBe('L3x');
  });

  it('prefers an explicit site name and falls back to the first station name', () => {
    const a = at('lte1800', 'Alpha', 49.835);
    const b = at('lte800', 'Beta', 49.835);
    expect(siteName([a, b])).toBe('Alpha');
    b.siteName = 'Main campus';
    expect(siteName([a, b])).toBe('Main campus');
  });
});

describe('sector colour slots', () => {
  it('swaps colours so no two sectors of a station share one', async () => {
    const { setSectorSlot, slotOf } = await import('./sectorColors');
    const bs = makeStation(presetByKey('lte1800'), 49.835, 24.01, 'op1', 'X', { sectors: 3 });
    setSectorSlot(bs, 0, 1); // S1 → blue: S2 takes red
    expect([0, 1, 2].map((i) => slotOf(bs, i))).toEqual([1, 0, 2]);
    setSectorSlot(bs, 2, 1); // S3 → blue: S1 takes green
    expect([0, 1, 2].map((i) => slotOf(bs, i))).toEqual([2, 0, 1]);
    setSectorSlot(bs, 0, 0); // S1 → red: S2 takes green
    expect([0, 1, 2].map((i) => slotOf(bs, i))).toEqual([0, 2, 1]);
  });
});
