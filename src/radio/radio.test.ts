import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../state/defaults';
import { antennaAttenuation } from './antenna';
import { buildRadioContext, rxLevel, sinrDb } from './cells';
import { channelNumber, makeStation, powerUnits, presetByKey, resourceBlocks } from './presets';
import { fspl, pathLoss, pathLossCoeffs } from './propagation';
import { shadowingDb } from './shadowing';

describe('propagation', () => {
  it('Okumura-Hata urban medium city, 900 MHz, hb 30 m, hm 1.5 m, 1 km ≈ 126.4 dB', () => {
    const c = pathLossCoeffs(900, 30, 1.5, 'urban-medium', 'auto');
    expect(c.model).toBe('okumura-hata');
    expect(pathLoss(c, 1)).toBeCloseTo(126.4, 1);
    // Slope: 44.9 - 6.55 log10(30) = 35.22 dB/decade
    expect(pathLoss(c, 10) - pathLoss(c, 1)).toBeCloseTo(35.22, 2);
  });

  it('COST-231 Hata 1800 MHz, hb 30 m, hm 1.5 m, 1 km ≈ 136.2 dB; metropolitan +3 dB', () => {
    const med = pathLossCoeffs(1800, 30, 1.5, 'urban-medium', 'auto');
    expect(med.model).toBe('cost231-hata');
    expect(pathLoss(med, 1)).toBeCloseTo(136.2, 1);
    const large = pathLossCoeffs(1800, 30, 1.5, 'urban-large', 'auto');
    // Large-city a(hm) differs slightly from the medium-city one at hm = 1.5 m.
    expect(pathLoss(large, 1) - pathLoss(med, 1)).toBeCloseTo(3 - (-0.0009 - 0.043), 1);
  });

  it('suburban and rural are less lossy than urban', () => {
    const u = pathLoss(pathLossCoeffs(900, 30, 1.5, 'urban-medium', 'auto'), 2);
    const s = pathLoss(pathLossCoeffs(900, 30, 1.5, 'suburban', 'auto'), 2);
    const r = pathLoss(pathLossCoeffs(900, 30, 1.5, 'rural', 'auto'), 2);
    expect(u - s).toBeCloseTo(2 * Math.log10(900 / 28) ** 2 + 5.4, 6);
    expect(r).toBeLessThan(s);
  });

  it('never returns less than free-space loss close to the mast', () => {
    const c = pathLossCoeffs(1800, 30, 1.5, 'urban-medium', 'auto');
    expect(pathLoss(c, 0.02)).toBeGreaterThanOrEqual(fspl(1800, 0.02) - 1e-9);
  });
});

describe('antenna pattern', () => {
  it('is 0 dB at boresight and -3 dB at half beamwidth', () => {
    expect(antennaAttenuation(0, 5, 65, 7, 5, 25)).toBeCloseTo(0, 9);
    expect(antennaAttenuation(32.5, 5, 65, 7, 5, 25)).toBeCloseTo(-3, 9);
    expect(antennaAttenuation(0, 5 + 3.5, 65, 7, 5, 25)).toBeCloseTo(-3, 9);
  });
  it('is limited by front-to-back ratio behind the antenna', () => {
    expect(antennaAttenuation(180, 5, 65, 7, 5, 25)).toBeCloseTo(-25, 9);
  });
  it('omni ignores azimuth', () => {
    expect(antennaAttenuation(137, 5, 360, 7, 5, 25)).toBeCloseTo(0, 9);
  });
});

describe('shadowing', () => {
  it('has roughly the configured standard deviation and is deterministic', () => {
    const vals: number[] = [];
    for (let i = 0; i < 4000; i++) vals.push(shadowingDb(42, i * 37.3, i * 11.7, 8, 50));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    expect(Math.abs(mean)).toBeLessThan(0.6);
    expect(sd).toBeGreaterThan(7);
    expect(sd).toBeLessThan(9);
    expect(shadowingDb(42, 10, 20, 8, 50)).toBe(shadowingDb(42, 10, 20, 8, 50));
  });
});

describe('carrier tables', () => {
  it('maps bandwidth to resource blocks', () => {
    expect(resourceBlocks('LTE', 20, 1815)).toBe(100);
    expect(resourceBlocks('NR', 100, 3550)).toBe(273);
    expect(powerUnits('LTE', 20, 1815)).toBe(1200);
    expect(powerUnits('GSM', 0.2, 947)).toBe(1);
  });
  it('computes channel numbers', () => {
    expect(channelNumber('GSM', 947.4)).toEqual({ label: 'ARFCN', value: 62 });
    expect(channelNumber('LTE', 1815)).toEqual({ label: 'EARFCN', value: 1300 });
    expect(channelNumber('NR', 3550)?.value).toBe(636667);
  });
});

describe('link budget', () => {
  it('RSRP = P - cable - 10log10(12·NPRB) + G - PL at boresight', () => {
    const scn = defaultScenario();
    const p = presetByKey('lte1800');
    const bs = makeStation(p, scn.center.lat, scn.center.lng, 'op1', 'T', { sectors: 1 });
    bs.sectors[0].hBeamwidth = 360;
    scn.stations = [bs];
    scn.settings.radio.shadowingEnabled = false;
    const ctx = buildRadioContext(scn);
    const c = ctx.cells[0];
    const d = 1000;
    // Put the UE where the vertical pattern is at its peak so attenuation is 0.
    const elev = (Math.atan2(c.hb - ctx.hm, d) * 180) / Math.PI;
    c.tilt = elev;
    const pl = pathLoss(pathLossCoeffs(c.freqMHz, c.hb, ctx.hm, 'urban-medium', 'auto'), d / 1000);
    const expected = p.txPowerDbm - bs.cableLossDb - 10 * Math.log10(1200) + c.gain - pl;
    expect(rxLevel(ctx, c, 0, d)).toBeCloseTo(expected, 6);
  });

  it('SINR of a lone cell equals SNR; a co-channel twin at equal level gives ~0 dB', () => {
    const scn = defaultScenario();
    const p = presetByKey('lte1800');
    scn.stations = [makeStation(p, scn.center.lat, scn.center.lng, 'op1', 'A', { sectors: 1 }), makeStation(p, scn.center.lat, scn.center.lng, 'op2', 'B', { sectors: 1 })];
    scn.settings.radio.shadowingEnabled = false;
    const ctx = buildRadioContext(scn);
    const lv = new Float64Array([-90, -90]);
    expect(sinrDb(ctx, lv, 0, null)).toBeCloseTo(0, 1);
    const alone = new Float64Array([-90, -Infinity]);
    const snr = -90 + ctx.cells[0].unitsDb - ctx.cells[0].noiseDbm;
    expect(sinrDb(ctx, alone, 0, null)).toBeCloseTo(snr, 6);
  });
});
