import { describe, expect, it } from 'vitest';
import { buildRadioContext } from '../radio/cells';
import { defaultScenario } from '../state/defaults';
import { SimEngine } from './engine';

function makeEngine(mutate?: (s: ReturnType<typeof defaultScenario>) => void) {
  const scn = defaultScenario();
  mutate?.(scn);
  const c = scn.center;
  const area = { south: c.lat - 0.01, north: c.lat + 0.01, west: c.lng - 0.015, east: c.lng + 0.015 };
  const eng = new SimEngine(scn, buildRadioContext(scn), area);
  eng.reset();
  return eng;
}

describe('SimEngine', () => {
  it('runs, serves users, and produces plausible KPIs', () => {
    const eng = makeEngine((s) => (s.settings.users.count = 120));
    for (let i = 0; i < 3000; i++) eng.step(); // 10 min of sim time
    const k = eng.counters;
    const last = eng.samples[eng.samples.length - 1];
    expect(eng.t).toBeCloseTo(600, 0);
    expect(last.coverage).toBeGreaterThan(0.8);
    expect(k.voiceStarted + k.dataStarted).toBeGreaterThan(100);
    expect(k.hoSuccess).toBeGreaterThan(0);
    expect(k.hoSuccess).toBeLessThanOrEqual(k.hoAttempts);
    // Occupancy bookkeeping must match the users' actual sessions.
    const active = new Array(eng.cells.length).fill(0);
    for (const u of eng.users) if (u.session && u.serving >= 0) active[u.serving]++;
    eng.cells.forEach((c, i) => expect(c.active).toBe(active[i]));
    for (const c of eng.cells) expect(c.load).toBeLessThanOrEqual(1 + 1e-9);
  }, 30000);

  it('blocks GSM calls when there are no free traffic channels', () => {
    const eng = makeEngine((s) => {
      s.stations = s.stations.filter((b) => b.tech === 'GSM');
      for (const b of s.stations) b.trxCount = 1; // 6 TCH per sector
      s.settings.users.count = 400;
      s.settings.users.voiceCallsPerHour = 60;
      s.settings.users.voiceMeanDurationS = 300;
    });
    for (let i = 0; i < 1500; i++) eng.step();
    expect(eng.counters.blockedCapacity).toBeGreaterThan(0);
    for (let i = 0; i < eng.cells.length; i++) expect(eng.cells[i].tchUsed).toBeLessThanOrEqual(eng.ctx.cells[i].tch);
  });

  it('keeps serving cells consistent after the network changes', () => {
    const scn = defaultScenario();
    const eng = makeEngine();
    for (let i = 0; i < 200; i++) eng.step();
    scn.stations = scn.stations.slice(0, 3);
    eng.setScenario(scn, buildRadioContext(scn));
    for (const u of eng.users) expect(u.serving).toBeLessThan(eng.ctx.cells.length);
    for (let i = 0; i < 200; i++) eng.step();
  });
});
