import { describe, expect, it } from 'vitest';
import { makeStation, presetByKey } from '../radio/presets';
import { defaultScenario } from '../state/defaults';
import { autoAssignGsm, autoAssignPci, checkPlan } from './check';
import { hexAxial, hexGrid } from './patterns';

function scenarioWith(stations: ReturnType<typeof makeStation>[]) {
  const s = defaultScenario();
  s.stations = stations;
  return s;
}

describe('planning checks', () => {
  it('flags a PCI collision between nearby co-channel cells', () => {
    const p = presetByKey('lte1800');
    const a = makeStation(p, 49.835, 24.014, 'op1', 'A', { pciBase: 0 });
    const b = makeStation(p, 49.838, 24.014, 'op1', 'B', { pciBase: 0 });
    const issues = checkPlan(scenarioWith([a, b]));
    expect(issues.some((i) => i.kind === 'PCI collision')).toBe(true);
  });

  it('does not flag PCI reuse on non-overlapping carriers', () => {
    const p = presetByKey('lte1800');
    const a = makeStation(p, 49.835, 24.014, 'op1', 'A', { pciBase: 0 });
    const b = makeStation({ ...p, freqMHz: 1860 }, 49.838, 24.014, 'op1', 'B', { pciBase: 0 });
    expect(checkPlan(scenarioWith([a, b])).some((i) => i.kind === 'PCI collision')).toBe(false);
  });

  it('auto PCI resolves collisions on a hex grid', () => {
    const s = defaultScenario();
    s.stations = hexGrid({ centerLat: 49.835, centerLng: 24.014, isdM: 500, rings: 2, sectors: 3, azimuthOffset: 0, operatorId: 'op1', preset: presetByKey('lte1800'), namePrefix: 'H' });
    for (const bs of s.stations) bs.sectors.forEach((x, i) => (x.pci = i)); // every site identical
    expect(checkPlan(s).some((i) => i.kind === 'PCI collision')).toBe(true);
    autoAssignPci(s, 'all');
    expect(checkPlan(s).some((i) => i.kind === 'PCI collision' || i.kind === 'PCI confusion')).toBe(false);
  });

  it('auto GSM plan avoids co-channel and adjacent channels on a site', () => {
    const s = defaultScenario();
    s.stations = hexGrid({ centerLat: 49.835, centerLng: 24.014, isdM: 800, rings: 1, sectors: 3, azimuthOffset: 0, operatorId: 'op1', preset: presetByKey('gsm900'), namePrefix: 'G' });
    autoAssignGsm(s, 'all', 947.4, 12);
    for (const bs of s.stations) {
      const f = bs.sectors.map((x) => x.freqMHz).sort((a, b) => a - b);
      for (let i = 1; i < f.length; i++) expect(f[i] - f[i - 1]).toBeGreaterThan(0.2 + 1e-6);
    }
  });

  it('hex rings produce 1, 7, 19 sites', () => {
    expect(hexAxial(0)).toHaveLength(1);
    expect(hexAxial(1)).toHaveLength(7);
    expect(hexAxial(2)).toHaveLength(19);
  });
});
