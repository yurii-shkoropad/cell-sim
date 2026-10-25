/// <reference lib="webworker" />
import { LocalProjection } from '../geo';
import { linkModulation, linkRank, pathCondition, rxLevel, sinrDb, type RadioContext } from '../radio/cells';
import { modulationIndex } from '../radio/modulation';
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
  /** UE receive antennas assumed for the throughput layer, per tech. */
  ueRx: Record<Tech, number>;
}

export interface HeatmapResult {
  gen: number;
  cols: number;
  rows: number;
  rsrp: Float32Array;
  server: Int16Array;
  sinr: Float32Array;
  thr: Float32Array;
  /** Index into MODULATIONS reached by a typical UE, -1 = none. */
  mod: Int8Array;
  /** Path condition to the best server (PathCond). */
  cond: Uint8Array;
  ms: number;
}

/**
 * Building path maps are large (~1 MB per station) and change rarely, so the main
 * thread sends them only when their version changes; otherwise it sends empty
 * arrays and the cached ones are used.
 */
let cachedPaths: RadioContext['paths'] = null;

self.onmessage = (e: MessageEvent<HeatmapRequest>) => {
  const t0 = performance.now();
  const { ctx, lats, lngs, op, tech, loads, radio, minRx, ueRx } = e.data;
  if (ctx.paths) {
    if (ctx.paths.loss.length) cachedPaths = ctx.paths;
    else if (cachedPaths && cachedPaths.version === ctx.paths.version) ctx.paths = cachedPaths;
    else ctx.paths = null;
  }
  const proj = new LocalProjection(ctx.lat0, ctx.lng0);
  const cols = lngs.length;
  const rows = lats.length;
  const C = ctx.cells.length;
  const n = cols * rows;
  const rsrp = new Float32Array(n).fill(-Infinity);
  const server = new Int16Array(n).fill(-1);
  const sinr = new Float32Array(n).fill(-Infinity);
  const thr = new Float32Array(n);
  const mod = new Int8Array(n).fill(-1);
  const cond = new Uint8Array(n);
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
      const cell = ctx.cells[best];
      const link = linkRank(cell, s, ueRx[cell.tech], radio);
      thr[k] = (link.se * cell.rbBwHz * (1 - radio.overhead) * cell.rbs) / 1e6;
      mod[k] = modulationIndex(linkModulation(cell, link));
      cond[k] = pathCondition(ctx, cell, x, y);
    }
  }
  const res: HeatmapResult = { gen: e.data.gen, cols, rows, rsrp, server, sinr, thr, mod, cond, ms: performance.now() - t0 };
  (self as unknown as Worker).postMessage(res, [rsrp.buffer, server.buffer, sinr.buffer, thr.buffer, mod.buffer, cond.buffer]);
};
