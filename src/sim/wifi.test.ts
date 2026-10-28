import { describe, expect, it } from 'vitest';
import { buildRadioContext } from '../radio/cells';
import { alignedChannels, buildWifiRF, wifiOverlap, wifiRangeM, wifiRateMbps, wifiRssi } from '../radio/wifi';
import { defaultScenario } from '../state/defaults';
import { SimEngine } from './engine';

type Scn = ReturnType<typeof defaultScenario>;
const base = JSON.stringify(defaultScenario());

function run(mutate: (s: Scn) => void = () => {}, steps = 1500) {
  const s = JSON.parse(base) as Scn;
  mutate(s);
  const c = s.center;
  const eng = new SimEngine(s, buildRadioContext(s), { south: c.lat - 0.01, north: c.lat + 0.01, west: c.lng - 0.015, east: c.lng + 0.015 });
  eng.reset();
  for (let i = 0; i < steps; i++) eng.step();
  return eng;
}

function expectConsistentOccupancy(eng: SimEngine) {
  const active = new Array(eng.cells.length).fill(0);
  for (const u of eng.users) if (u.session && u.serving >= 0 && !eng.onWifi(u)) active[u.serving]++;
  eng.cells.forEach((c, i) => expect(c.active).toBe(active[i]));
  const assoc = new Array(eng.aps.length).fill(0);
  for (const u of eng.users) if (u.wifiAp >= 0) assoc[u.wifiAp]++;
  eng.aps.forEach((a, j) => expect(a.assoc).toBe(assoc[j]));
}

describe('Wi-Fi radio model', () => {
  const s = defaultScenario();
  const aps = buildWifiRF(s);
  const ws = { ...s.settings.wifi, shadowingSigmaDb: 0 };

  it('RSSI falls with distance and matches the range circle', () => {
    const ap = aps[0];
    const r10 = wifiRssi(ap, ap.x + 10, ap.y, ws);
    const r100 = wifiRssi(ap, ap.x + 100, ap.y, ws);
    expect(r10 - r100).toBeCloseTo(10 * ap.slope, 6);
    const d = wifiRangeM(ap, -75);
    expect(wifiRssi(ap, ap.x + d, ap.y, ws)).toBeCloseTo(-75, 6);
  });

  it('only overlapping channels interfere', () => {
    const ch36 = aps.find((a) => a.apId === 'ap-main1')!; // 5 GHz ch 36, 80 MHz
    const ch52 = aps.find((a) => a.apId === 'ap-main2')!; // ch 52: next 80 MHz block
    const park = aps.find((a) => a.apId === 'ap-park')!; // 2.4 GHz
    expect(wifiOverlap(ch36, ch52)).toBe(0);
    expect(wifiOverlap(ch36, park)).toBe(0);
    expect(wifiOverlap(ch36, ch36)).toBe(1);
  });

  it('rate grows with SINR up to the standard and stream cap', () => {
    const ap = aps[0];
    expect(wifiRateMbps(ap, -5, 2, 0.75)).toBe(0);
    const lo = wifiRateMbps(ap, 5, 2, 0.75);
    const hi = wifiRateMbps(ap, 40, 2, 0.75);
    expect(hi).toBeGreaterThan(lo);
    // 2 streams × 143.4/20 b/s/Hz × 80 MHz × MAC efficiency
    expect(wifiRateMbps(ap, 80, 2, 0.75)).toBeCloseTo(2 * (143.4 / 20) * 80 * ap.macEff, 6);
    expect(wifiRateMbps(ap, 80, 1, 0.75)).toBeCloseTo(hi / 2, 6);
  });
});

describe('Wi-Fi offload', () => {
  it('moves data sessions to Wi-Fi and keeps occupancy consistent', () => {
    const eng = run();
    expect(eng.counters.wifiOffloads + eng.samples.reduce((a, s) => a + s.wifiSessions, 0)).toBeGreaterThan(0);
    expect(eng.samples.some((s) => s.wifiServedMbps > 0)).toBe(true);
    expectConsistentOccupancy(eng);
    for (const a of eng.aps) expect(a.airtime).toBeLessThanOrEqual(1 + 1e-9);
    // Voice is not carried over Wi-Fi by default.
    for (const u of eng.users) if (u.session?.kind === 'voice') expect(eng.onWifi(u)).toBe(false);
  }, 30000);

  it('does nothing when disabled or when the cell-load policy is never met', () => {
    const off = run((s) => (s.settings.wifi.enabled = false), 600);
    expect(off.counters.wifiOffloads).toBe(0);
    expect(off.samples.every((x) => x.wifiUsers === 0)).toBe(true);
    const load = run((s) => {
      s.settings.wifi.policy = 'cell-load';
      s.settings.wifi.loadThreshold = 1.01;
    }, 600);
    // Only phones without cellular service may join; no cellular session is offloaded.
    expect(load.counters.wifiOffloads).toBe(0);
  }, 30000);

  it('a phone leaving AP coverage takes its session back to cellular', () => {
    const eng = run(() => {}, 0);
    const u = eng.users.find((x) => x.specId === 'fu-main')!;
    eng.setWifiOn(u, true);
    for (let i = 0; i < 30; i++) eng.step(); // > association delay
    expect(u.wifiAp).toBeGreaterThanOrEqual(0);
    expect(eng.onWifi(u)).toBe(true);
    expect(u.thrMbps).toBeCloseTo(10, 6);
    const before = eng.counters.wifiFallbacks;
    eng.moveUserTo(u, 49.8452, 24.0352, true); // ~1.8 km away
    eng.step();
    expect(u.wifiAp).toBe(-1);
    expect(eng.counters.wifiFallbacks).toBe(before + 1);
    expect(u.session).not.toBeNull();
    expect(eng.onWifi(u)).toBe(false);
    expectConsistentOccupancy(eng);
  });

  it('operator-only APs accept only that operator', () => {
    const eng = run();
    const ks = eng.ctx.wifi.findIndex((a) => a.apId === 'ap-ks');
    for (const u of eng.users) if (u.wifiAp === ks) expect(eng.scn.operators[u.opIdx].id).toBe('op1');
  }, 30000);
});

describe('Wi-Fi channel plan', () => {
  it('aligned channel blocks', () => {
    expect(alignedChannels('5', 80)).toEqual([36, 52, 100, 116, 132, 149]);
    expect(alignedChannels('5', 160)).toEqual([36, 100]);
    expect(alignedChannels('2.4', 20)).toEqual([1, 6, 11]);
  });
});
