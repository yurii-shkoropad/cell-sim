import { LocalProjection } from '../geo';
import { makeStation, type StationPreset } from '../radio/presets';
import type { BaseStation } from '../types';

export interface HexGridOptions {
  centerLat: number;
  centerLng: number;
  /** Inter-site distance, m. */
  isdM: number;
  /** Number of rings around the centre site (0 = single site, 1 = 7 sites, 2 = 19...). */
  rings: number;
  sectors: number;
  azimuthOffset: number;
  operatorId: string;
  preset: StationPreset;
  namePrefix: string;
  pciStart?: number;
}

/** Axial hex coordinates for `rings` rings around the origin, centre first. */
export function hexAxial(rings: number): [number, number][] {
  const out: [number, number][] = [[0, 0]];
  const dirs: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  for (let k = 1; k <= rings; k++) {
    let q = -k;
    let r = k;
    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < k; step++) {
        out.push([q, r]);
        q += dirs[side][0];
        r += dirs[side][1];
      }
    }
  }
  return out;
}

export function hexGrid(o: HexGridOptions): BaseStation[] {
  const proj = new LocalProjection(o.centerLat, o.centerLng);
  const pciStart = o.pciStart ?? 0;
  return hexAxial(o.rings).map(([q, r], i) => {
    const x = o.isdM * (q + r / 2);
    const y = o.isdM * ((r * Math.sqrt(3)) / 2);
    const p = proj.toLatLng(x, y);
    return makeStation(o.preset, p.lat, p.lng, o.operatorId, `${o.namePrefix}${String(i + 1).padStart(2, '0')}`, {
      sectors: o.sectors,
      azimuthOffset: o.azimuthOffset,
      pciBase: (pciStart + 3 * i) % 504,
    });
  });
}

/** Sites uniformly at random inside a bounding box. */
export function randomSites(
  bounds: { south: number; west: number; north: number; east: number },
  count: number,
  preset: StationPreset,
  operatorId: string,
  namePrefix: string,
  sectors: number,
): BaseStation[] {
  return Array.from({ length: count }, (_, i) => {
    const lat = bounds.south + Math.random() * (bounds.north - bounds.south);
    const lng = bounds.west + Math.random() * (bounds.east - bounds.west);
    return makeStation(preset, lat, lng, operatorId, `${namePrefix}${String(i + 1).padStart(2, '0')}`, {
      sectors,
      azimuthOffset: Math.floor(Math.random() * 120),
      pciBase: (3 * i) % 504,
    });
  });
}
