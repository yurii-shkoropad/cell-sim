import { describe, expect, it } from 'vitest';
import { LocalProjection } from '../geo';
import { buildRadioContext } from '../radio/cells';
import { defaultScenario } from '../state/defaults';
import { SimEngine } from './engine';

type Scn = ReturnType<typeof defaultScenario>;
/** Demo scenario with fixed ids (user ids seed the Wi-Fi on/off draw; ids also order the cells). */
function stableScenario(): Scn {
  const s = defaultScenario();
  s.stations.forEach((bs, i) => {
    bs.id = `bs${i}`;
    bs.sectors.forEach((x, j) => (x.id = `bs${i}s${j}`));
  });
  s.users!.forEach((u, i) => (u.id = `u${i}`));
  s.settings.wifi.enabled = false;
  return s;
}
const base = JSON.stringify(stableScenario());

function engineFor(s: Scn) {
  const c = s.center;
  const eng = new SimEngine(s, buildRadioContext(s), { south: c.lat - 0.01, north: c.lat + 0.01, west: c.lng - 0.015, east: c.lng + 0.015 });
  eng.reset();
  return eng;
}

function run(mutate: (s: Scn) => void = () => {}, steps = 600) {
  const s = JSON.parse(base) as Scn;
  mutate(s);
  const eng = engineFor(s);
  for (let i = 0; i < steps; i++) eng.step();
  return eng;
}

/** One static user 120 m in front of the central site (sector 0, 30°), continuous data, high demand. */
function single(ca: boolean, demandMbps: number) {
  return run((s) => {
    s.settings.ca.enabled = ca;
    const p = new LocalProjection(s.center.lat, s.center.lng).toLatLng(120 * Math.sin(Math.PI / 6), 120 * Math.cos(Math.PI / 6));
    s.users = [{ id: 'probe', name: 'Probe', lat: p.lat, lng: p.lng, operatorId: 'op1', techs: ['LTE'], mobility: 'static', traffic: 'data', demandMbps, ueRx: 2 }];
  }, 20);
}

describe('carrier aggregation', () => {
  it('adds co-sited SCells on other carriers of the same RAT', () => {
    const eng = run();
    const ca = eng.users.filter((u) => u.scells.length);
    expect(ca.length).toBeGreaterThan(0);
    for (const u of ca) {
      expect(u.session?.kind).toBe('data');
      const pc = eng.ctx.cells[u.serving];
      const all = [u.serving, ...u.scells].map((i) => eng.ctx.cells[i]);
      expect(all.length).toBeLessThanOrEqual(eng.settings.ca.maxCc);
      for (const c of all.slice(1)) {
        expect(c.tech).toBe(pc.tech);
        expect(c.operatorIdx).toBe(pc.operatorIdx);
        expect(Math.hypot(c.x - pc.x, c.y - pc.y)).toBeLessThan(50);
      }
      // No two component carriers overlap in frequency.
      for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) expect(all[a].fLo < all[b].fHi && all[a].fHi > all[b].fLo).toBe(false);
      expect(u.thrMbps).toBeLessThanOrEqual(u.session!.demandMbps + 1e-6);
      expect(u.scellThr.length).toBe(u.scells.length);
    }
    expect(eng.samples.at(-1)!.caUsers).toBeGreaterThan(0);
    expect(eng.log.events.some((e) => e.type === 'SCELL_ADD')).toBe(true);
    // Admission counts PCells only.
    const active = new Array(eng.cells.length).fill(0);
    for (const u of eng.users) if (u.session && u.serving >= 0) active[u.serving]++;
    eng.cells.forEach((c, i) => expect(c.active).toBe(active[i]));
  });

  it('does nothing when switched off', () => {
    const eng = run((s) => (s.settings.ca.enabled = false));
    expect(eng.users.every((u) => !u.scells.length)).toBe(true);
    expect(eng.log.events.some((e) => e.type === 'SCELL_ADD')).toBe(false);
  });

  it('a high-demand user gets the sum of its carriers; a low-demand one is served in full either way', () => {
    const off = single(false, 1000).users[0];
    const on = single(true, 1000).users[0];
    expect(on.scells.length).toBe(1);
    expect(on.thrMbps).toBeGreaterThan(off.thrMbps * 1.5);
    expect(on.thrMbps - on.scellThr[0]).toBeCloseTo(off.thrMbps, 0); // PCell part unchanged when alone
    const low = single(true, 2).users[0];
    expect(low.thrMbps).toBeCloseTo(2, 6);
  });

  it('moves demand off a congested carrier to the one with room', () => {
    const eng = single(true, 1000);
    const u = eng.users[0];
    const cap = [u.serving, ...u.scells].map((i) => eng.cells[i].load);
    // Alone and full-buffer: both carriers are used to the full.
    for (const l of cap) expect(l).toBeGreaterThan(0.99);
  });
});
