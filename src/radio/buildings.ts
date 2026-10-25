import type { LocalProjection } from '../geo';

/**
 * Building footprints with heights. A building has one or more rings of [lat, lng]
 * (OSM multipolygons: outer outlines and inner courtyards). Filling uses the
 * even-odd rule over all of a building's rings, so courtyards stay open.
 */
export interface BuildingSet {
  bounds: { south: number; west: number; north: number; east: number };
  /** Height in metres, or 0 when OSM has no height / levels / type hint (the default applies). */
  heights: Float32Array;
  /** First ring of each building in `ringOffsets`, length = count + 1. */
  ringStart: Uint32Array;
  /** Start of each ring in `coords` (pairs), length = rings + 1. */
  ringOffsets: Uint32Array;
  /** Flat [lat, lng, lat, lng, …]. */
  coords: Float64Array;
  count: number;
}

/** Typical heights for building types without height/levels tags, m. */
const TYPE_HEIGHT: Record<string, number> = {
  house: 7, detached: 7, semidetached_house: 7, bungalow: 4, terrace: 9, farm: 7,
  garage: 3, garages: 3, shed: 3, hut: 3, kiosk: 3, carport: 3, roof: 4, service: 3, cabin: 3, toilets: 3,
  apartments: 15, residential: 12, dormitory: 15, hotel: 18,
  commercial: 12, retail: 8, office: 18, supermarket: 7, industrial: 10, warehouse: 10,
  church: 20, cathedral: 30, chapel: 8, mosque: 15, synagogue: 15, temple: 12,
  school: 12, university: 18, college: 15, kindergarten: 7, hospital: 18, public: 15, civic: 15, government: 15,
  train_station: 12, transportation: 8, stadium: 20, sports_hall: 10, parking: 10,
};

export const LEVEL_HEIGHT_M = 3;

/** Height from OSM tags: height > building:levels (+ roof:levels) > building type; 0 = unknown. */
export function heightFromTags(t: Record<string, string>): number {
  const h = parseFloat((t.height ?? '').replace(',', '.'));
  if (Number.isFinite(h) && h > 0 && h < 400) return h;
  const lv = parseFloat(t['building:levels'] ?? '');
  if (Number.isFinite(lv) && lv > 0 && lv < 150) {
    const roof = parseFloat(t['roof:levels'] ?? '');
    return lv * LEVEL_HEIGHT_M + (Number.isFinite(roof) && roof > 0 ? roof * LEVEL_HEIGHT_M * 0.5 : 0);
  }
  return TYPE_HEIGHT[t.building] ?? 0;
}

/** Accumulates buildings ring by ring into a BuildingSet. */
class SetBuilder {
  heights: number[] = [];
  ringStart: number[] = [0];
  ringOffsets: number[] = [0];
  coords: number[] = [];

  add(height: number, rings: [number, number][][]) {
    rings = rings.filter((r) => r.length >= 3);
    if (!rings.length) return;
    for (const ring of rings) {
      for (const [la, ln] of ring) this.coords.push(la, ln);
      this.ringOffsets.push(this.coords.length / 2);
    }
    this.heights.push(height);
    this.ringStart.push(this.ringOffsets.length - 1);
  }

  build(bounds: BuildingSet['bounds']): BuildingSet {
    return {
      bounds,
      heights: Float32Array.from(this.heights),
      ringStart: Uint32Array.from(this.ringStart),
      ringOffsets: Uint32Array.from(this.ringOffsets),
      coords: Float64Array.from(this.coords),
      count: this.heights.length,
    };
  }
}

/** Join open ways into closed rings by matching endpoints (OSM multipolygon members). */
export function stitchRings(lines: number[][]): number[][] {
  const rings: number[][] = [];
  const pool = lines.filter((l) => l.length >= 2).map((l) => [...l]);
  while (pool.length) {
    const ring = pool.pop()!;
    let grown = true;
    while (ring[0] !== ring[ring.length - 1] && grown) {
      grown = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < pool.length; i++) {
        const l = pool[i];
        if (l[0] === end) ring.push(...l.slice(1));
        else if (l[l.length - 1] === end) ring.push(...l.slice(0, -1).reverse());
        else continue;
        pool.splice(i, 1);
        grown = true;
        break;
      }
    }
    // An unclosed leftover still contributes its edges; the fill closes it implicitly.
    rings.push(ring);
  }
  return rings;
}

interface OsmEl {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: { type: string; ref: number; role: string }[];
  tags?: Record<string, string>;
}

const isBuilding = (t: Record<string, string> | undefined) => !!t?.building && t.building !== 'no' && t.building !== 'roof' && t.location !== 'underground';

/**
 * Buildings from an Overpass response with building ways and multipolygon
 * relations (`… out body; >; out skel;`). Relation member ways are stitched into
 * rings; outer and inner rings are kept together so courtyards stay holes.
 */
export function buildingsFromOverpass(els: OsmEl[], bounds: BuildingSet['bounds']): BuildingSet {
  const nodes = new Map<number, [number, number]>();
  const ways = new Map<number, number[]>();
  for (const e of els) {
    if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) nodes.set(e.id, [e.lat, e.lon]);
    else if (e.type === 'way' && e.nodes) ways.set(e.id, e.nodes);
  }
  const toLatLng = (ring: number[]) => ring.map((n) => nodes.get(n)).filter((p): p is [number, number] => !!p);
  const out = new SetBuilder();
  const seen = new Set<string>();
  for (const e of els) {
    if (!isBuilding(e.tags)) continue;
    const key = `${e.type}/${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.type === 'way' && e.nodes && e.nodes.length >= 4) out.add(heightFromTags(e.tags!), [toLatLng(e.nodes)]);
    else if (e.type === 'relation' && e.members && e.tags?.type === 'multipolygon') {
      const lines = e.members
        .filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === 'inner' || m.role === ''))
        .map((m) => ways.get(m.ref))
        .filter((w): w is number[] => !!w);
      out.add(heightFromTags(e.tags), stitchRings(lines).map(toLatLng));
    }
  }
  return out.build(bounds);
}

/**
 * Compact extract shipped with the app. Per building:
 * [height_dm, n1, lat0·1e6, lng0·1e6, Δlat, Δlng, … (n1 points), n2, lat0, lng0, …] — one group per ring.
 */
export interface BundledBuildings {
  bounds: BuildingSet['bounds'];
  b: number[][];
}

export function buildingsFromBundle(j: BundledBuildings): BuildingSet {
  const out = new SetBuilder();
  for (const row of j.b) {
    const rings: [number, number][][] = [];
    let k = 1;
    while (k < row.length) {
      const n = row[k++];
      let la = row[k++];
      let ln = row[k++];
      const ring: [number, number][] = [[la / 1e6, ln / 1e6]];
      for (let i = 1; i < n; i++) {
        la += row[k++];
        ln += row[k++];
        ring.push([la / 1e6, ln / 1e6]);
      }
      rings.push(ring);
    }
    out.add(row[0] / 10, rings);
  }
  return out.build(j.bounds);
}

/** Buildings rasterised on a regular grid in local metres: building id (+1, 0 = none) and height. */
export interface BuildingRaster {
  x0: number;
  y0: number;
  res: number;
  nx: number;
  ny: number;
  id: Int32Array;
  h: Float32Array;
  /** Changes whenever the raster is rebuilt (buildings or default height changed). */
  version: number;
}

let rasterVersion = 0;

/**
 * Scanline-fill every building into the grid using the even-odd rule over all its
 * rings (inner courtyards stay empty); overlapping buildings keep the taller one.
 */
export function rasterize(set: BuildingSet, proj: LocalProjection, defaultHeightM: number, res = 3): BuildingRaster {
  const sw = proj.toXY(set.bounds.south, set.bounds.west);
  const ne = proj.toXY(set.bounds.north, set.bounds.east);
  const nx = Math.ceil((ne.x - sw.x) / res);
  const ny = Math.ceil((ne.y - sw.y) / res);
  const id = new Int32Array(nx * ny);
  const h = new Float32Array(nx * ny);
  const xs: number[] = [];
  const ys: number[] = [];
  const ringEnd: number[] = [];
  const cross: number[] = [];
  for (let b = 0; b < set.count; b++) {
    const height = set.heights[b] > 0 ? set.heights[b] : defaultHeightM;
    // All rings' vertices in grid coords; ringEnd[r] marks where ring r stops.
    xs.length = 0;
    ys.length = 0;
    ringEnd.length = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let ri = set.ringStart[b]; ri < set.ringStart[b + 1]; ri++) {
      for (let k = set.ringOffsets[ri]; k < set.ringOffsets[ri + 1]; k++) {
        const p = proj.toXY(set.coords[2 * k], set.coords[2 * k + 1]);
        const gy = (p.y - sw.y) / res;
        xs.push((p.x - sw.x) / res);
        ys.push(gy);
        if (gy < minY) minY = gy;
        if (gy > maxY) maxY = gy;
      }
      ringEnd.push(xs.length);
    }
    const r0 = Math.max(0, Math.floor(minY));
    const r1 = Math.min(ny - 1, Math.ceil(maxY));
    for (let row = r0; row <= r1; row++) {
      const yc = row + 0.5;
      cross.length = 0;
      // Even-odd crossings over every ring's edges: inner rings punch holes.
      let start = 0;
      for (const end of ringEnd) {
        for (let i = start, j = end - 1; i < end; j = i++) {
          const yi = ys[i];
          const yj = ys[j];
          if (yi > yc !== yj > yc) cross.push(xs[i] + ((yc - yi) / (yj - yi)) * (xs[j] - xs[i]));
        }
        start = end;
      }
      if (cross.length < 2) continue;
      cross.sort((a, c) => a - c);
      for (let k = 0; k + 1 < cross.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(cross[k] - 0.5));
        const c1 = Math.min(nx - 1, Math.floor(cross[k + 1] - 0.5));
        for (let col = c0; col <= c1; col++) {
          const idx = row * nx + col;
          if (height > h[idx]) {
            h[idx] = height;
            id[idx] = b + 1;
          }
        }
      }
    }
  }
  return { x0: sw.x, y0: sw.y, res, nx, ny, id, h, version: ++rasterVersion };
}
