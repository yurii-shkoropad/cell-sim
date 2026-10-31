import { describe, expect, it } from 'vitest';
import { buildRadioContext } from '../radio/cells';
import { defaultScenario } from '../state/defaults';
import { SimEngine } from './engine';
import { areaAround, generateUsers, mulberry32, templateFromSettings } from './population';
import { allocate, jainIndex, pfDiversityGainDb, type SchedulerKey } from './scheduler';

// Two users wanting plenty: a good one (10 Mbps/RB) and a cell-edge one (1 Mbps/RB).
const flows = [
  { rate: 10, need: 100 },
  { rate: 1, need: 100 },
];
const thr = (alloc: number[]) => alloc.map((a, i) => a * flows[i].rate);

describe('scheduler allocation', () => {
  it('Round Robin gives equal RBs', () => {
    expect(allocate('rr', flows, 50)).toEqual([25, 25]);
  });

  it('Round Robin redistributes RBs a user does not need', () => {
    expect(allocate('rr', [{ rate: 5, need: 10 }, { rate: 5, need: 100 }], 50)).toEqual([10, 40]);
  });

  it('Max C/I serves the best channel first', () => {
    expect(allocate('maxci', flows, 50)).toEqual([50, 0]);
    expect(allocate('maxci', [{ rate: 10, need: 20 }, { rate: 1, need: 100 }], 50)).toEqual([20, 30]);
  });

  it('Equal throughput gives both users the same Mbps', () => {
    const t = thr(allocate('maxmin', flows, 55));
    expect(t[0]).toBeCloseTo(t[1], 9);
    expect(t[0]).toBeCloseTo(50, 9); // 55 RBs = 5 + 50
  });

  it('Equal throughput caps satisfied users and gives the rest to others', () => {
    const a = allocate('maxmin', [{ rate: 10, need: 1 }, { rate: 1, need: 100 }], 50);
    expect(a[0]).toBeCloseTo(1, 9);
    expect(a[1]).toBeCloseTo(49, 9);
  });

  it('never allocates more than the pool or a user needs', () => {
    for (const k of ['rr', 'pf', 'maxci', 'maxmin'] as SchedulerKey[]) {
      const a = allocate(k, flows, 30);
      expect(a.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(30 + 1e-9);
      a.forEach((x, i) => expect(x).toBeLessThanOrEqual(flows[i].need + 1e-9));
    }
  });

  it('PF diversity gain grows with users and Jain index bounds', () => {
    expect(pfDiversityGainDb(1, 1)).toBe(0);
    expect(pfDiversityGainDb(2, 1)).toBeCloseTo(10 * Math.log10(1.5), 9);
    expect(pfDiversityGainDb(10, 0.5)).toBeGreaterThan(pfDiversityGainDb(5, 0.5));
    expect(jainIndex([1, 1, 1])).toBeCloseTo(1, 9);
    expect(jainIndex([1, 0, 0, 0])).toBeCloseTo(0.25, 9);
  });
});

describe('schedulers in the simulation', () => {
  /**
   * Full-buffer comparison: static users with continuous 100 Mbps data, so the
   * scheduler is the only difference between runs (same positions, same sessions).
   */
  // One scenario for all runs: a fresh defaultScenario() has new random ids,
  // so its users (Wi-Fi draw) would differ between schedulers.
  const base = JSON.stringify(defaultScenario());
  function run(sched: SchedulerKey) {
    const scn = JSON.parse(base) as ReturnType<typeof defaultScenario>;
    scn.settings.radio.scheduler = sched;
    scn.settings.ca.enabled = false; // per-cell scheduler behaviour, one carrier per user
    scn.users = generateUsers(scn, { ...templateFromSettings(scn), count: 120, staticShare: 1 }, areaAround(scn.center.lat, scn.center.lng), mulberry32(3));
    const c = scn.center;
    const eng = new SimEngine(scn, buildRadioContext(scn), { south: c.lat - 0.005, north: c.lat + 0.005, west: c.lng - 0.007, east: c.lng + 0.007 });
    eng.reset();
    for (const u of eng.users) {
      u.demandMbps = 100;
      eng.setTraffic(u, 'data');
    }
    for (let i = 0; i < 60; i++) eng.step();
    const served = eng.users.filter((u) => u.session?.kind === 'data' && eng.ctx.cells[u.serving]?.tech !== 'GSM');
    const byCell = new Map<number, number[]>();
    for (const u of served) byCell.set(u.serving, [...(byCell.get(u.serving) ?? []), u.thrMbps]);
    const cellFair = [...byCell.values()].filter((l) => l.length >= 2).map(jainIndex);
    return { sum: served.reduce((a, u) => a + u.thrMbps, 0), fair: cellFair.reduce((a, b) => a + b, 0) / cellFair.length, n: served.length };
  }

  it('show the expected throughput / fairness trade-off', () => {
    const rr = run('rr');
    const pf = run('pf');
    const ci = run('maxci');
    const mm = run('maxmin');
    expect(rr.n).toBeGreaterThan(50);
    expect(pf.sum).toBeGreaterThan(rr.sum); // multi-user diversity gain
    expect(ci.sum).toBeGreaterThan(pf.sum); // max throughput
    expect(ci.fair).toBeLessThan(rr.fair); // ...at the expense of fairness
    expect(pf.fair).toBeCloseTo(rr.fair, 1); // PF keeps RR's equal time shares
    expect(mm.fair).toBeGreaterThan(0.99); // equal throughput inside every cell
    expect(mm.sum).toBeLessThan(rr.sum); // ...and costs capacity
  }, 60000);
});

describe('compareSchedulers what-if', () => {
  it('matches the live allocation for the scheduler in use and ranks the others as expected', () => {
    const scn = defaultScenario();
    scn.settings.ca.enabled = false; // the what-if counts PCells only
    scn.users = generateUsers(scn, { ...templateFromSettings(scn), count: 200, staticShare: 1 }, areaAround(scn.center.lat, scn.center.lng), mulberry32(5));
    const c = scn.center;
    const eng = new SimEngine(scn, buildRadioContext(scn), { south: c.lat - 0.005, north: c.lat + 0.005, west: c.lng - 0.007, east: c.lng + 0.007 });
    eng.reset();
    for (const u of eng.users) {
      u.demandMbps = 60;
      eng.setTraffic(u, 'data');
    }
    for (let i = 0; i < 20; i++) eng.step();
    const res = eng.compareSchedulers(['rr', 'pf', 'maxci', 'maxmin']);
    // Live scheduler is Round Robin: the what-if must reproduce it exactly.
    const live = eng.users.filter((u) => u.session?.kind === 'data' && eng.ctx.cells[u.serving]?.tech !== 'GSM').map((u) => u.thrMbps).sort((a, b) => a - b);
    expect([...res.rr.thr].sort((a, b) => a - b)).toEqual(live);
    expect(res.demand).toHaveLength(live.length);
    const sum = (k: string) => res[k].thr.reduce((a, b) => a + b, 0);
    expect(sum('pf')).toBeGreaterThan(sum('rr'));
    expect(sum('maxci')).toBeGreaterThan(sum('pf'));
    expect(sum('maxmin')).toBeLessThan(sum('rr'));
    expect(res.maxmin.fairness).toBeGreaterThan(res.rr.fairness);
    expect(res.maxci.fairness).toBeLessThan(res.rr.fairness);
  }, 60000);

  it('full buffer separates the schedulers even in a lightly loaded network', () => {
    const scn = defaultScenario(); // demo load: cells are not congested
    const c = scn.center;
    const eng = new SimEngine(scn, buildRadioContext(scn), { south: c.lat - 0.005, north: c.lat + 0.005, west: c.lng - 0.007, east: c.lng + 0.007 });
    eng.reset();
    for (let i = 0; i < 600; i++) eng.step();
    const sum = (r: { thr: number[] }) => r.thr.reduce((a, b) => a + b, 0);
    const fb = eng.compareSchedulers(['rr', 'pf', 'maxci', 'maxmin'], true);
    expect(fb.rr.thr.length).toBeGreaterThan(5);
    expect(sum(fb.maxci)).toBeGreaterThan(sum(fb.rr));
    expect(sum(fb.maxmin)).toBeLessThan(sum(fb.rr));
    expect(fb.maxmin.fairness).toBeGreaterThan(fb.maxci.fairness);
    expect(fb.demand).toHaveLength(0);
  }, 60000);
});
