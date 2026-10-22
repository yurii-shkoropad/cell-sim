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

  it('static users never move; fixed users spawn at their position with continuous traffic', () => {
    const eng = makeEngine((s) => {
      s.settings.users.count = 60;
      s.settings.users.staticShare = 0.5;
    });
    const statics = eng.users.filter((u) => u.mode === 'static' && !u.fixedId).map((u) => ({ u, x: u.x, y: u.y }));
    expect(statics.length).toBeGreaterThan(10);
    const probe = eng.users.find((u) => u.fixedId === 'fu-main')!;
    expect(probe).toBeDefined();
    expect(probe.lat).toBeCloseTo(49.8352, 6);
    for (let i = 0; i < 600; i++) eng.step();
    for (const { u, x, y } of statics) expect([u.x, u.y]).toEqual([x, y]);
    // Continuous data: in session (or re-dialling after a drop) and never with a finite end.
    expect(probe.session?.kind).toBe('data');
    expect(probe.session?.end).toBe(Infinity);
    expect(probe.session?.demandMbps).toBe(10);
  });

  it('dragging moves a user and re-measures it without advancing time', () => {
    const eng = makeEngine();
    const u = eng.users.find((x) => x.mode === 'walk')!;
    const t = eng.t;
    eng.moveUserTo(u, 49.8356, 24.0142, false);
    expect(u.dragging).toBe(true);
    expect(u.lat).toBeCloseTo(49.8356, 6);
    expect(u.serving).toBeGreaterThanOrEqual(0);
    eng.step();
    expect(u.lat).toBeCloseTo(49.8356, 6); // frozen while dragged
    eng.moveUserTo(u, 49.8356, 24.0142, true);
    expect(u.dragging).toBe(false);
    expect(eng.t).toBeCloseTo(t + eng.settings.sim.stepMs / 1000, 9);
  });

  it('manual session control and removal keep occupancy consistent', () => {
    const eng = makeEngine();
    const u = eng.users.find((x) => x.serving >= 0 && !x.session)!;
    eng.startSessionNow(u, 'voice');
    expect(u.session?.kind).toBe('voice');
    expect(eng.cells[u.serving].active).toBeGreaterThan(0);
    eng.setTraffic(u, 'data');
    eng.step();
    eng.step();
    eng.removeUser(u.id);
    expect(eng.userById(u.id)).toBeUndefined();
    const active = new Array(eng.cells.length).fill(0);
    for (const x of eng.users) if (x.session && x.serving >= 0) active[x.serving]++;
    eng.cells.forEach((c, i) => expect(c.active).toBe(active[i]));
  });
});
