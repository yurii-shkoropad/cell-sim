import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../state/defaults';
import { buildRadioContext, peakRateMbps, rxLevel } from './cells';
import { antennaType, bestRank, muMimoGain, validAntennaFor } from './mimo';
import { makeStation, presetByKey } from './presets';

const radio = defaultScenario().settings.radio;
const link = (key: string) => antennaType(key);

describe('MIMO rank adaptation', () => {
  it('uses one layer at the cell edge and four near the site (4T4R, 4Rx)', () => {
    expect(bestRank(-2, link('4t4r'), 4, 4.4, radio).rank).toBe(1);
    const high = bestRank(35, link('4t4r'), 4, 4.4, radio);
    expect(high.rank).toBe(4);
    expect(high.se).toBeGreaterThan(3.5 * 4.4 * 0.8);
  });

  it('is limited by UE receive antennas and by the cell ports', () => {
    expect(bestRank(35, link('4t4r'), 2, 4.4, radio).rank).toBe(2);
    expect(bestRank(35, link('2t2r'), 4, 4.4, radio).rank).toBe(2);
    expect(bestRank(35, link('siso'), 4, 4.4, radio).rank).toBe(1);
  });

  it('4T4R beats 2T2R for a 2Rx UE at mid SINR thanks to precoding gain', () => {
    const a = bestRank(5, link('4t4r'), 2, 4.4, radio).se;
    const b = bestRank(5, link('2t2r'), 2, 4.4, radio).se;
    expect(a).toBeGreaterThan(b);
  });

  it('SISO with a 1Rx UE reduces to plain truncated Shannon', () => {
    const se = bestRank(10, link('siso'), 1, 4.4, radio).se;
    expect(se).toBeCloseTo(radio.shannonAlpha * Math.log2(1 + 10), 9);
  });

  it('MU-MIMO gain grows with users up to the antenna limit', () => {
    expect(muMimoGain(1, 10, 0.5)).toBe(1);
    expect(muMimoGain(8, 3, 0.5)).toBeCloseTo(2, 9);
    expect(muMimoGain(8, 50, 0.5)).toBeCloseTo(4.5, 9);
  });

  it('falls back to SISO for types the technology does not support', () => {
    expect(validAntennaFor('GSM', '4t4r')).toBe('siso');
    expect(validAntennaFor('LTE', '64t64r')).toBe('siso');
    expect(validAntennaFor('NR', '64t64r')).toBe('64t64r');
  });
});

describe('antenna type in the link budget', () => {
  it('beamforming gain adds to the received level and peak rate grows with layers', () => {
    const scn = defaultScenario();
    scn.settings.radio.shadowingEnabled = false;
    const p = presetByKey('nr3500');
    const a = makeStation(p, scn.center.lat, scn.center.lng, 'op1', 'A', { sectors: 1 });
    const b = { ...makeStation(p, scn.center.lat, scn.center.lng, 'op1', 'B', { sectors: 1 }), antennaType: 'siso' };
    scn.stations = [a, b];
    const ctx = buildRadioContext(scn);
    const [ca, cb] = ctx.cells;
    expect(rxLevel(ctx, ca, 0, 300) - rxLevel(ctx, cb, 0, 300)).toBeCloseTo(7.5, 9);
    expect(peakRateMbps(ca, 30, scn.settings.radio, 4)).toBeGreaterThan(3 * peakRateMbps(cb, 30, scn.settings.radio, 1));
  });
});
