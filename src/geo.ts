/**
 * Local equirectangular projection. Accurate to well under 1% over a city-sized
 * area, which is far below the error of any empirical path-loss model.
 */
export class LocalProjection {
  readonly lat0: number;
  readonly lng0: number;
  private readonly mPerDegLat: number;
  private readonly mPerDegLng: number;

  constructor(lat0: number, lng0: number) {
    this.lat0 = lat0;
    this.lng0 = lng0;
    const phi = (lat0 * Math.PI) / 180;
    // WGS84 series expansions for metres per degree.
    this.mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
    this.mPerDegLng = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  }

  toXY(lat: number, lng: number): { x: number; y: number } {
    return { x: (lng - this.lng0) * this.mPerDegLng, y: (lat - this.lat0) * this.mPerDegLat };
  }

  toLatLng(x: number, y: number): { lat: number; lng: number } {
    return { lat: this.lat0 + y / this.mPerDegLat, lng: this.lng0 + x / this.mPerDegLng };
  }
}

/** Bearing from (x1,y1) to (x2,y2) in degrees clockwise from north, in [0, 360). */
export function bearingDeg(x1: number, y1: number, x2: number, y2: number): number {
  const b = (Math.atan2(x2 - x1, y2 - y1) * 180) / Math.PI;
  return b < 0 ? b + 360 : b;
}

/** Wrap an angle to (-180, 180]. */
export function wrap180(a: number): number {
  let r = a % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return r;
}

export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Destination point given start, bearing (deg) and distance (m). */
export function destination(lat: number, lng: number, bearing: number, distM: number): { lat: number; lng: number } {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const d = distM / R;
  const b = bearing * toRad;
  const p1 = lat * toRad;
  const l1 = lng * toRad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / toRad, lng: l2 / toRad };
}
