import { describe, expect, it } from 'vitest';
import { LocalProjection } from '../geo';
import { defaultScenario } from '../state/defaults';
import { castStationPaths, PATH_GRID, PathCond, pathSampleIndex } from './buildingPaths';
import { BuildingModel } from './buildingModel';
import { heightFromTags, rasterize, type BuildingSet } from './buildings';
import { buildRadioContext, pathCondition, rxLevel } from './cells';
import { buildingEntryLossDb, fsplDb, multiScreen, walfischIkegami } from './walfisch';

const base = { freqMHz: 1800, hb: 30, hm: 1.5, hRoofMean: 15, hRoofLast: 15, b: 40, w: 20, phiDeg: 90, metropolitan: false };

describe('COST-231 Walfisch–Ikegami', () => {
  it('LOS street-canyon formula: 42.6 + 26 log d + 20 log f, never below free space', () => {
    const L = walfischIkegami({ ...base, dKm: 0.1, los: true });
    expect(L).toBeCloseTo(42.6 + 26 * Math.log10(0.1) + 20 * Math.log10(1800), 6);
    expect(L).toBeGreaterThanOrEqual(fsplDb(0.1, 1800));
  });

  it('NLOS is lossier than LOS and grows with distance', () => {
    const los = walfischIkegami({ ...base, dKm: 0.5, los: true });
    const n5 = walfischIkegami({ ...base, dKm: 0.5, los: false });
    const n10 = walfischIkegami({ ...base, dKm: 1, los: false });
    expect(n5).toBeGreaterThan(los + 10);
    expect(n10).toBeGreaterThan(n5);
  });

  it('an antenna below the rooftops loses much more than one above them', () => {
    expect(multiScreen(1, 1800, 10, 15, 40, false)).toBeGreaterThan(multiScreen(1, 1800, 30, 15, 40, false) + 10);
  });

  it('taller buildings next to the UE add rooftop-to-street loss', () => {
    expect(walfischIkegami({ ...base, dKm: 0.5, los: false, hRoofLast: 25 })).toBeGreaterThan(walfischIkegami({ ...base, dKm: 0.5, los: false, hRoofLast: 9 }));
  });

  it('ITU-R P.2109 median building entry loss', () => {
    expect(buildingEntryLossDb(1800, 'traditional')).toBeCloseTo(13.65, 2);
    expect(buildingEntryLossDb(1800, 'thermal')).toBeGreaterThan(25);
    expect(buildingEntryLossDb(1800, 'none')).toBe(0);
  });
});

describe('building heights from OSM tags', () => {
  it('prefers height, then levels, then building type', () => {
    expect(heightFromTags({ building: 'yes', height: '21.5' })).toBe(21.5);
    expect(heightFromTags({ building: 'yes', 'building:levels': '5' })).toBe(15);
    expect(heightFromTags({ building: 'apartments' })).toBe(15);
    expect(heightFromTags({ building: 'yes' })).toBe(0); // unknown → default from settings
  });
});

/** One rectangular building of given height, x/y in metres around the projection origin. */
function setWithBox(proj: LocalProjection, x0: number, y0: number, x1: number, y1: number, h: number): BuildingSet {
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => proj.toLatLng(x, y));
  const sw = proj.toLatLng(-3000, -3000);
  const ne = proj.toLatLng(3000, 3000);
  return {
    bounds: { south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng },
    heights: Float32Array.of(h),
    offsets: Uint32Array.of(0, 4),
    coords: Float64Array.from(corners.flatMap((p) => [p.lat, p.lng])),
    count: 1,
  };
}

describe('path casting through buildings', () => {
  const proj = new LocalProjection(49.8356, 24.0142);
  // A 40 m tall block 200–240 m north of a 30 m mast at the origin.
  const raster = rasterize(setWithBox(proj, -50, 200, 50, 240, 40), proj, 12);
  const paths = castStationPaths(raster, 0, 0, { hb: 30, hm: 1.5, freqMHz: 1800, entry: 'traditional', metropolitan: false });
  const at = (d: number, brg: number) => pathSampleIndex(d, brg);

  it('is LOS in front of the building, indoor inside it, NLOS behind it', () => {
    expect(paths.cond[at(150, 0)]).toBe(PathCond.Los);
    expect(paths.cond[at(220, 0)]).toBe(PathCond.Indoor);
    expect(paths.cond[at(400, 0)]).toBe(PathCond.Nlos);
    expect(paths.cond[at(400, 90)]).toBe(PathCond.Los); // clear direction
  });

  it('the shadow behind the building costs well over free space; indoor adds entry loss', () => {
    const behind = paths.loss[at(400, 0)];
    const clear = paths.loss[at(400, 90)];
    expect(behind - clear).toBeGreaterThan(15);
    const indoor = paths.loss[at(220, 0)];
    const losAt220 = walfischIkegami({ ...base, dKm: 0.22, los: true });
    expect(indoor - losAt220).toBeCloseTo(buildingEntryLossDb(1800, 'traditional'), 3);
  });

  it('a low building does not block a high antenna path to nearby points beyond it', () => {
    const low = rasterize(setWithBox(proj, -50, 100, 50, 110, 6), proj, 12);
    const p = castStationPaths(low, 0, 0, { hb: 30, hm: 1.5, freqMHz: 1800, entry: 'traditional', metropolitan: false });
    // Ray from 30 m to 1.5 m at 120 m is at ~4.9 m over the building's far wall (110 m): blocked.
    expect(p.cond[pathSampleIndex(120, 0)]).toBe(PathCond.Nlos);
    // At 500 m the ray passes the roof at ~23.7 m → clear.
    expect(p.cond[pathSampleIndex(500, 0)]).toBe(PathCond.Los);
  });

  it('inlined NLOS evaluation matches the reference Walfisch–Ikegami formula', () => {
    // Behind the single 40 m block: one crossing, last = mean roof = 40 m, b = clamp(400/1) = 100 m.
    const expected = walfischIkegami({ ...base, dKm: 0.4, los: false, hRoofMean: 40, hRoofLast: 40, b: 100, w: 50 });
    expect(paths.loss[at(400, 0)]).toBeCloseTo(expected, 3);
  });

  it('grid covers 4 km in 0.5° steps', () => {
    expect(paths.loss.length).toBe(PATH_GRID.rays * PATH_GRID.steps);
  });
});

describe('building model in the radio context', () => {
  it('switches cells to building-aware path loss when the WI model is selected', () => {
    const scn = defaultScenario();
    scn.settings.radio.shadowingEnabled = false;
    const proj = new LocalProjection(scn.center.lat, scn.center.lng);
    const model = new BuildingModel();
    // A tall block right next to the central site, north of it.
    model.setBuildings(setWithBox(proj, -80, 60, 80, 120, 60), 'test');
    const hata = buildRadioContext(scn, model.provider(scn));
    expect(hata.paths).toBeNull(); // model not selected yet

    scn.settings.radio.model = 'cost231-wi';
    const ctx = buildRadioContext(scn, model.provider(scn));
    model.finish(ctx);
    expect(ctx.paths).not.toBeNull();
    const c = ctx.cells.find((x) => x.x === 0 && x.y === 0 && x.tech === 'LTE')!;
    expect(c.pathMap).toBeGreaterThanOrEqual(0);
    expect(pathCondition(ctx, c, 0, 300)).toBe(PathCond.Nlos);
    expect(pathCondition(ctx, c, 0, -300)).toBe(PathCond.Los);
    expect(rxLevel(ctx, c, 0, 300)).toBeLessThan(rxLevel(hata, c, 0, 300));
  });
});
