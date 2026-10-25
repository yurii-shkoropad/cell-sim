import type { BuildingRaster } from './buildings';
import { buildingEntryLossDb, orientationLoss, type BuildingEntryType } from './walfisch';

/** Polar sampling of each station's map: rays × range bins. */
export const PATH_GRID = { rays: 720, stepM: 10, steps: 400 } as const; // 0.5°, 10 m, 4 km

/** Path condition stored per sample. */
export const PathCond = { Unknown: 0, Los: 1, Nlos: 2, Indoor: 3 } as const;
export const PATH_COND_LABEL = ['—', 'LOS', 'NLOS', 'Indoor'] as const;

export interface StationPaths {
  /** Path loss per sample, dB; NaN where no building data (caller falls back to Hata). */
  loss: Float32Array;
  cond: Uint8Array;
}

export interface PathParams {
  hb: number;
  hm: number;
  freqMHz: number;
  entry: BuildingEntryType;
  metropolitan: boolean;
}

/**
 * Cast PATH_GRID.rays rays from a station through the building raster and evaluate
 * COST-231 Walfisch–Ikegami at every range bin, with the path geometry measured
 * along the ray:
 *
 *  • LOS test (exact for the straight ray): the path to a UE at distance d is blocked
 *    iff some building sample at s < d has (hb − h)/s < (hb − hm)/d, so a running
 *    minimum of (hb − h)/s along the ray decides LOS for every d in O(1).
 *  • Mean roof height of buildings crossed (multi-screen term), roof height of the last
 *    building before the UE (rooftop-to-street term), building separation = d / crossings.
 *  • A UE inside a footprint is indoor: its own building is excluded from the path
 *    geometry and the ITU-R P.2109 building entry loss is added.
 */
export function castStationPaths(r: BuildingRaster, sx: number, sy: number, p: PathParams): StationPaths {
  const { rays, stepM, steps } = PATH_GRID;
  const loss = new Float32Array(rays * steps).fill(NaN);
  const cond = new Uint8Array(rays * steps);
  const micro = r.res; // march at raster resolution so thin buildings aren't skipped
  const bel = buildingEntryLossDb(p.freqMHz, p.entry);
  const losSlope = p.hb - p.hm;

  // Per-site tables over range bins (the hot loop below is the inlined walfischIkegami()).
  const lf = Math.log10(p.freqMHz);
  const logD = new Float64Array(steps);
  const losL = new Float64Array(steps);
  const l0 = new Float64Array(steps);
  for (let k = 0; k < steps; k++) {
    const dKm = Math.max(((k + 1) * stepM) / 1000, 0.02);
    logD[k] = Math.log10(dKm);
    l0[k] = 32.4 + 20 * logD[k] + 20 * lf;
    losL[k] = Math.max(42.6 + 26 * logD[k] + 20 * lf, l0[k]);
  }
  const lOri = orientationLoss(90);
  const kf = -4 + (p.metropolitan ? 1.5 : 0.7) * (p.freqMHz / 925 - 1);
  const rtsConst = -16.9 + 10 * lf + lOri;
  const msdConstF = kf * lf;

  for (let ray = 0; ray < rays; ray++) {
    const th = ((ray * 360) / rays) * (Math.PI / 180);
    const ux = Math.sin(th);
    const uy = Math.cos(th);
    // Committed (fully passed) buildings
    let minM = Infinity;
    let sumH = 0;
    let nObs = 0;
    let crossings = 0;
    let lastH = 0;
    // Building currently under the march point
    let curId = 0;
    let curMinM = Infinity;
    let curSumH = 0;
    let curN = 0;
    let curH = 0;
    let out = 0;
    const base = ray * steps;
    const gx0 = (sx - r.x0) / r.res;
    const gy0 = (sy - r.y0) / r.res;
    const dgx = (micro * ux) / r.res;
    const dgy = (micro * uy) / r.res;
    let i = 0;
    for (let s = micro; out < steps; s += micro) {
      i++;
      const gx = Math.floor(gx0 + i * dgx);
      const gy = Math.floor(gy0 + i * dgy);
      if (gx < 0 || gy < 0 || gx >= r.nx || gy >= r.ny) break; // left the data: remaining bins stay NaN
      const idx = gy * r.nx + gx;
      const id = r.id[idx];
      if (id !== curId) {
        if (curId !== 0) {
          if (curMinM < minM) minM = curMinM;
          sumH += curSumH;
          nObs += curN;
          crossings++;
          lastH = curH;
        }
        curId = id;
        curMinM = Infinity;
        curSumH = 0;
        curN = 0;
        curH = 0;
      }
      if (id !== 0) {
        const h = r.h[idx];
        const m = (p.hb - h) / s;
        if (m < curMinM) curMinM = m;
        curSumH += h;
        curN++;
        if (h > curH) curH = h;
      }
      // Emit every range bin we have reached.
      while (out < steps && (out + 1) * stepM <= s) {
        const d = (out + 1) * stepM;
        const indoor = curId !== 0;
        const los = !(minM < losSlope / d);
        let L: number;
        if (los) L = losL[out];
        else {
          // NLOS: L0 + max(0, L_rts + L_msd), see walfisch.ts
          const b = Math.min(100, Math.max(15, d / Math.max(crossings, 1)));
          const hRoof = nObs ? sumH / nObs : lastH;
          const rts = rtsConst - 10 * Math.log10(b / 2) + 20 * Math.log10(Math.max(lastH - p.hm, 0.5));
          const dhb = p.hb - hRoof;
          const dKm = d / 1000;
          let msd: number;
          if (dhb > 0) msd = -18 * Math.log10(1 + dhb) + 54 + 18 * logD[out];
          else msd = (dKm >= 0.5 ? 54 - 0.8 * dhb : 54 - (0.8 * dhb * dKm) / 0.5) + (18 - (15 * dhb) / Math.max(hRoof, 1)) * logD[out];
          msd += msdConstF - 9 * Math.log10(b);
          const extra = rts + msd;
          L = l0[out] + (extra > 0 ? extra : 0);
        }
        if (indoor) L += bel;
        loss[base + out] = L;
        cond[base + out] = indoor ? PathCond.Indoor : los ? PathCond.Los : PathCond.Nlos;
        out++;
      }
    }
  }
  return { loss, cond };
}

/** Index of the sample nearest to a point at ground distance d (m) and bearing (deg), or −1 if out of range. */
export function pathSampleIndex(dM: number, bearingDeg: number): number {
  const { rays, stepM, steps } = PATH_GRID;
  const k = Math.max(0, Math.round(dM / stepM) - 1);
  if (k >= steps) return -1;
  const ray = Math.round((bearingDeg * rays) / 360) % rays;
  return ray * steps + k;
}
