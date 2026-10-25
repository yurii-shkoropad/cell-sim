import type { LocalProjection } from '../geo';

/** Building footprints with heights. Polygons are rings of [lat, lng]. */
export interface BuildingSet {
  bounds: { south: number; west: number; north: number; east: number };
  /** Height in metres, or 0 when OSM has no height / levels / type hint (the default applies). */
  heights: Float32Array;
  /** Start of each polygon in `coords` (pairs), length = count + 1. */
  offsets: Uint32Array;
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

interface OsmEl {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

/** Building ways from an Overpass `way["building"]…; >; out skel` response. */
export function buildingsFromOverpass(els: OsmEl[], bounds: BuildingSet['bounds']): BuildingSet {
  const nodes = new Map<number, [number, number]>();
  for (const e of els) if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) nodes.set(e.id, [e.lat, e.lon]);
  const heights: number[] = [];
  const offsets: number[] = [0];
  const coords: number[] = [];
  for (const e of els) {
    if (e.type !== 'way' || !e.tags?.building || !e.nodes || e.nodes.length < 4) continue;
    if (e.tags.building === 'no' || e.tags.building === 'roof' || e.tags.location === 'underground') continue;
    const pts = e.nodes.map((n) => nodes.get(n)).filter((p): p is [number, number] => !!p);
    if (pts.length < 3) continue;
    for (const [la, ln] of pts) coords.push(la, ln);
    heights.push(heightFromTags(e.tags));
    offsets.push(coords.length / 2);
  }
  return { bounds, heights: Float32Array.from(heights), offsets: Uint32Array.from(offsets), coords: Float64Array.from(coords), count: heights.length };
}

/** Compact extract shipped with the app: per building [height_dm, lat0·1e6, lng0·1e6, Δlat, Δlng, …]. */
export interface BundledBuildings {
  bounds: BuildingSet['bounds'];
  b: number[][];
}

export function buildingsFromBundle(j: BundledBuildings): BuildingSet {
  const heights: number[] = [];
  const offsets: number[] = [0];
  const coords: number[] = [];
  for (const row of j.b) {
    heights.push(row[0] / 10);
    let la = row[1];
    let ln = row[2];
    coords.push(la / 1e6, ln / 1e6);
    for (let k = 3; k + 1 < row.length; k += 2) {
      la += row[k];
      ln += row[k + 1];
      coords.push(la / 1e6, ln / 1e6);
    }
    offsets.push(coords.length / 2);
  }
  return { bounds: j.bounds, heights: Float32Array.from(heights), offsets: Uint32Array.from(offsets), coords: Float64Array.from(coords), count: heights.length };
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

/** Scanline-fill every footprint into the grid; overlapping parts keep the taller building. */
export function rasterize(set: BuildingSet, proj: LocalProjection, defaultHeightM: number, res = 3): BuildingRaster {
  const sw = proj.toXY(set.bounds.south, set.bounds.west);
  const ne = proj.toXY(set.bounds.north, set.bounds.east);
  const nx = Math.ceil((ne.x - sw.x) / res);
  const ny = Math.ceil((ne.y - sw.y) / res);
  const id = new Int32Array(nx * ny);
  const h = new Float32Array(nx * ny);
  const xs: number[] = [];
  const ys: number[] = [];
  const cross: number[] = [];
  for (let b = 0; b < set.count; b++) {
    const height = set.heights[b] > 0 ? set.heights[b] : defaultHeightM;
    xs.length = 0;
    ys.length = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let k = set.offsets[b]; k < set.offsets[b + 1]; k++) {
      const p = proj.toXY(set.coords[2 * k], set.coords[2 * k + 1]);
      const gx = (p.x - sw.x) / res;
      const gy = (p.y - sw.y) / res;
      xs.push(gx);
      ys.push(gy);
      if (gy < minY) minY = gy;
      if (gy > maxY) maxY = gy;
    }
    const n = xs.length;
    const r0 = Math.max(0, Math.floor(minY));
    const r1 = Math.min(ny - 1, Math.ceil(maxY));
    for (let row = r0; row <= r1; row++) {
      const yc = row + 0.5;
      cross.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ys[i];
        const yj = ys[j];
        if (yi > yc !== yj > yc) cross.push(xs[i] + ((yc - yi) / (yj - yi)) * (xs[j] - xs[i]));
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
