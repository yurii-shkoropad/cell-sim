import { describe, expect, it } from 'vitest';
import { LocalProjection } from '../geo';
import { buildRadioContext } from '../radio/cells';
import { defaultScenario } from '../state/defaults';
import type { UserSpec } from '../types';
import { SimEngine } from './engine';
import { buildRoadGraph } from './roads';

/** Demo scenario with a single pedestrian; `roads` adds an L-shaped street: A → B (300 m east) → C (300 m north of B). */
function setup(roads: boolean) {
  const s = defaultScenario();
  const c = s.center;
  const proj = new LocalProjection(c.lat, c.lng);
  const at = (x: number, y: number) => proj.toLatLng(x, y);
  const user: UserSpec = { id: 'walker', name: 'Walker', lat: c.lat, lng: c.lng, operatorId: s.operators[0].id, techs: ['LTE'], mobility: 'walk', traffic: 'idle', demandMbps: null, speedKmh: 18, wifi: false };
  s.users = [user];
  const area = { south: c.lat - 0.01, north: c.lat + 0.01, west: c.lng - 0.015, east: c.lng + 0.015 };
  const eng = new SimEngine(s, buildRadioContext(s), area);
  if (roads) {
    const pts = [at(0, 0), at(300, 0), at(300, 300)];
    const elements = [
      ...pts.map((p, i) => ({ type: 'node' as const, id: i + 1, lat: p.lat, lon: p.lng })),
      { type: 'way' as const, id: 10, nodes: [1, 2, 3], tags: { highway: 'footway' } },
    ];
    eng.setGraph(buildRoadGraph(elements, area, proj));
  }
  eng.reset();
  return { eng, u: eng.users[0], at };
}

describe('user target', () => {
  it('walks along the roads to the target and stops there', () => {
    const { eng, u, at } = setup(true);
    const t = at(310, 305); // a little off the road: the last metres are straight
    eng.setTarget(u, t.lat, t.lng);
    expect(eng.distanceToTarget(u)).toBeGreaterThan(600);
    let maxXBeforeTurn = 0;
    for (let i = 0; i < 2000 && !u.arrived; i++) {
      eng.step();
      if (u.y < 5) maxXBeforeTurn = Math.max(maxXBeforeTurn, u.x);
    }
    expect(u.arrived).toBe(true);
    expect(maxXBeforeTurn).toBeGreaterThan(295); // went round the corner, not diagonally
    expect(u.x).toBeCloseTo(310, 3);
    expect(u.y).toBeCloseTo(305, 3);
    for (let i = 0; i < 50; i++) eng.step();
    expect(u.x).toBeCloseTo(310, 3); // stays put
    expect(eng.distanceToTarget(u)).toBe(0);
  });

  it('goes in a straight line without roads, and clearing the target resumes random trips', () => {
    const { eng, u, at } = setup(false);
    const t = at(-200, 100);
    eng.setTarget(u, t.lat, t.lng);
    for (let i = 0; i < 2000 && !u.arrived; i++) eng.step();
    expect(u.arrived).toBe(true);
    expect(Math.hypot(u.x + 200, u.y - 100)).toBeLessThan(1e-6);
    eng.setTarget(u, null);
    expect(u.target).toBeNull();
    const x0 = u.x;
    for (let i = 0; i < 400; i++) eng.step();
    expect(u.x).not.toBeCloseTo(x0, 1);
  });

  it('a target saved in the scenario is followed after reset', () => {
    const s = defaultScenario();
    const c = s.center;
    s.users = [{ id: 'w', name: 'W', lat: c.lat, lng: c.lng, operatorId: s.operators[0].id, techs: ['LTE'], mobility: 'walk', traffic: 'idle', demandMbps: null, speedKmh: 36, target: { lat: c.lat + 0.001, lng: c.lng } }];
    const eng = new SimEngine(s, buildRadioContext(s), { south: c.lat - 0.01, north: c.lat + 0.01, west: c.lng - 0.015, east: c.lng + 0.015 });
    eng.reset();
    for (let i = 0; i < 1000 && !eng.users[0].arrived; i++) eng.step();
    expect(eng.users[0].arrived).toBe(true);
    expect(eng.users[0].lat).toBeCloseTo(c.lat + 0.001, 6);
  });
});
