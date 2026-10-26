import { describe, expect, it } from 'vitest';
import { buildRadioContext } from '../radio/cells';
import { defaultScenario } from '../state/defaults';
import { SimEngine } from './engine';
import { areaAround, generateUsers, mulberry32, templateFromSettings } from './population';

/** Replace the scenario's users with n generated ones (seeded). */
function withUsers(s: ReturnType<typeof defaultScenario>, n: number, staticShare?: number) {
  const tpl = { ...templateFromSettings(s), count: n, ...(staticShare !== undefined ? { staticShare } : {}) };
  s.users = generateUsers(s, tpl, areaAround(s.center.lat, s.center.lng), mulberry32(7));
}

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
    const eng = makeEngine((s) => withUsers(s, 120));
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
      withUsers(s, 400);
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

  it('static users never move; listed users spawn at their position with continuous traffic', () => {
    const eng = makeEngine();
    const statics = eng.users.filter((u) => u.mode === 'static' && u.specId !== 'fu-main').map((u) => ({ u, x: u.x, y: u.y }));
    expect(statics.length).toBeGreaterThan(10);
    const probe = eng.users.find((u) => u.specId === 'fu-main')!;
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

  it('per-phone Rx antennas override the device default and change the link rank', () => {
    const eng = makeEngine();
    eng.step();
    const u = eng.users.find((x) => x.techMask & 2 && !(x.techMask & 4) && x.specId !== 'fu-main')!; // LTE-only phone
    expect(eng.ueRx(u)).toBe(2);
    eng.moveUserTo(u, 49.8361, 24.0142, false); // close to the central site: high SINR
    eng.startSessionNow(u, 'data');
    const r2 = u.rank;
    eng.setUeRx(u, 4);
    expect(eng.ueRx(u)).toBe(4);
    expect(u.rank).toBeGreaterThanOrEqual(r2);
    eng.setUeRx(u, null);
    expect(eng.ueRx(u)).toBe(2);
  });

  it('removeAllUsers frees every cell and the simulation keeps running', () => {
    const eng = makeEngine();
    for (let i = 0; i < 300; i++) eng.step();
    expect(eng.cells.some((c) => c.active > 0)).toBe(true);
    eng.removeAllUsers();
    expect(eng.users).toHaveLength(0);
    for (const c of eng.cells) {
      expect(c.active).toBe(0);
      expect(c.camped).toBe(0);
      expect(c.load).toBe(0);
    }
    for (let i = 0; i < 20; i++) eng.step();
    expect(eng.samples.at(-1)!.coverage).toBe(0);
  });


  it('per-cell hysteresis reduces handovers; a positive CIO attracts them', () => {
    // Same seed and users in every run: mobility does not depend on handovers.
    const base = JSON.stringify(defaultScenario());
    /** Run 5 min; also return the mean number of active sessions on each cell. */
    const run = (mutate: (s: ReturnType<typeof defaultScenario>) => void) => {
      const s = JSON.parse(base) as ReturnType<typeof defaultScenario>;
      mutate(s);
      const c = s.center;
      const eng = new SimEngine(s, buildRadioContext(s), { south: c.lat - 0.01, north: c.lat + 0.01, west: c.lng - 0.015, east: c.lng + 0.015 });
      eng.reset();
      const served = new Float64Array(eng.ctx.cells.length);
      for (let i = 0; i < 1500; i++) {
        eng.step();
        eng.cells.forEach((cs, k) => (served[k] += cs.active / 1500));
      }
      return Object.assign(eng, { served });
    };
    const lteSectors = (s: ReturnType<typeof defaultScenario>) => s.stations.filter((b) => b.tech === 'LTE').flatMap((b) => b.sectors);
    const ref = run(() => {});
    const sticky = run((s) => lteSectors(s).forEach((x) => (x.ho = { hysteresisDb: 8 })));
    expect(sticky.counters.hoSuccess).toBeLessThan(ref.counters.hoSuccess * 0.7);

    // Give one busy LTE cell +10 dB CIO: it must carry more connected traffic
    // (CIO also applies while it serves, so users join earlier and stay longer).
    const target = ref.cells.map((c, i) => ({ i, n: c.hoIn })).filter((x) => ref.ctx.cells[x.i].tech === 'LTE').sort((a, b) => b.n - a.n)[0];
    const tc = ref.ctx.cells[target.i];
    const lured = run((s) => {
      const sec = s.stations.find((b) => b.id === tc.bsId)!.sectors.find((x) => x.id === tc.sectorId)!;
      sec.ho = { cioDb: 10 };
    });
    const li = lured.ctx.cells.findIndex((c) => c.sectorId === tc.sectorId);
    expect(lured.served[li]).toBeGreaterThan(ref.served[target.i] * 1.2);
    expect(lured.hoParams(li).cioDb).toBe(10);
  }, 60000);
});
