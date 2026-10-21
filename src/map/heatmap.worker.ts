/// <reference lib="webworker" />
import { LocalProjection } from '../geo';
import { peakRateMbps, rxLevel, sinrDb, type RadioContext } from '../radio/cells';
import type { RadioSettings, Tech } from '../types';

export interface HeatmapRequest {
  gen: number;
  ctx: RadioContext;
  radio: RadioSettings;
  lats: Float64Array;
  lngs: Float64Array;
  /** Operator index filter, -1 = all. */
  op: number;
  tech: Tech | null;
  loads: Float32Array | null;
  /** Minimum level for a cell to count as serving, per tech. */
  minRx: Record<Tech, number>;
}

export interface HeatmapResult {
  gen: number;
  cols: number;
  rows: number;
  rsrp: Float32Array;
  server: Int16Array;
  sinr: Float32Array;
  thr: Float32Array;
  ms: number;
}

self.onmessage = (e: MessageEvent<HeatmapRequest>) => {
  const t0 = performance.now();
  const { ctx, lats, lngs, op, tech, loads, radio, minRx } = e.data;
  const proj = new LocalProjection(ctx.lat0, ctx.lng0);
  const cols = lngs.length;
  const rows = lats.length;
  const C = ctx.cells.length;
  const n = cols * rows;
  const rsrp = new Float32Array(n).fill(-Infinity);
  const server = new Int16Array(n).fill(-1);
  const sinr = new Float32Array(n).fill(-Infinity);
  const thr = new Float32Array(n);
  const levels = new Float64Array(C);
  const eligible = ctx.cells.map((c) => (op < 0 || c.operatorIdx === op) && (!tech || c.tech === tech));
  const xs = new Float64Array(cols);
  for (let i = 0; i < cols; i++) xs[i] = proj.toXY(ctx.lat0, lngs[i]).x;

  for (let r = 0; r < rows; r++) {
    const y = proj.toXY(lats[r], ctx.lng0).y;
    for (let col = 0; col < cols; col++) {
      const x = xs[col];
      let best = -1;
      let bestLvl = -Infinity;
      for (let i = 0; i < C; i++) {
        const l = rxLevel(ctx, ctx.cells[i], x, y);
        levels[i] = l;
        if (eligible[i] && l > bestLvl) {
          bestLvl = l;
          best = i;
        }
      }
      const k = r * cols + col;
      if (best < 0) continue;
      rsrp[k] = bestLvl;
      if (bestLvl < minRx[ctx.cells[best].tech]) continue;
      server[k] = best;
      const s = sinrDb(ctx, levels, best, loads);
      sinr[k] = s;
      thr[k] = peakRateMbps(ctx.cells[best], s, radio);
    }
  }
  const res: HeatmapResult = { gen: e.data.gen, cols, rows, rsrp, server, sinr, thr, ms: performance.now() - t0 };
  (self as unknown as Worker).postMessage(res, [rsrp.buffer, server.buffer, sinr.buffer, thr.buffer]);
};
