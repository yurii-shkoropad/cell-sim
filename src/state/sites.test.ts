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
