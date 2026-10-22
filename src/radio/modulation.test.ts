import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../state/defaults';
import { buildRadioContext, linkModulation, linkRank, peakRateMbps } from './cells';
import { modulationForSe, validModulationFor } from './modulation';
import { makeStation, presetByKey } from './presets';

describe('modulation', () => {
  it('maps per-layer efficiency to the lowest modulation that covers it, capped by the cell max', () => {
    expect(modulationForSe(0, '256qam')).toBeNull();
    expect(modulationForSe(1.0, '256qam')?.key).toBe('qpsk');
    expect(modulationForSe(2.0, '256qam')?.key).toBe('16qam');
    expect(modulationForSe(5.0, '256qam')?.key).toBe('64qam');
    expect(modulationForSe(7.0, '256qam')?.key).toBe('256qam');
    expect(modulationForSe(2.0, 'qpsk')?.key).toBe('qpsk');
  });

  it('defaults and RAT restrictions', () => {
    expect(validModulationFor('LTE', undefined)).toBe('64qam');
    expect(validModulationFor('NR', undefined)).toBe('256qam');
    expect(validModulationFor('LTE', '1024qam')).toBe('64qam');
    expect(validModulationFor('NR', '1024qam')).toBe('1024qam');
    expect(validModulationFor('GSM', '256qam')).toBe('gmsk');
  });

  it('a higher max modulation raises throughput only at high SINR', () => {
    const scn = defaultScenario();
    const p = presetByKey('lte1800');
    const a = { ...makeStation(p, scn.center.lat, scn.center.lng, 'op1', 'A', { sectors: 1 }), maxModulation: '64qam' };
    const b = { ...makeStation(p, scn.center.lat, scn.center.lng, 'op1', 'B', { sectors: 1 }), maxModulation: '256qam' };
    scn.stations = [a, b];
    const [ca, cb] = buildRadioContext(scn).cells;
    const r = scn.settings.radio;
    expect(peakRateMbps(cb, 50, r, 2) / peakRateMbps(ca, 50, r, 2)).toBeCloseTo(7.4063 / 5.5547, 3);
    expect(peakRateMbps(cb, 2, r, 2)).toBeCloseTo(peakRateMbps(ca, 2, r, 2), 9);
    expect(linkModulation(cb, linkRank(cb, 35, 2, r))?.key).toBe('256qam');
    expect(linkModulation(cb, linkRank(cb, -6, 2, r))?.key).toBe('qpsk');
  });
});
