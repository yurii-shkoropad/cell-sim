import { LocalProjection } from '../geo';
import type { BaseStation, RadioSettings, Scenario, Tech } from '../types';
import { antennaAttenuation } from './antenna';
import { antennaType, bestRank, validAntennaFor, type RankChoice } from './mimo';
import { modulation, modulationForSe, validModulationFor, type Modulation, type ModulationKey } from './modulation';
import { MIN_DISTANCE_KM, pathLossCoeffs } from './propagation';
import { PathCond, pathSampleIndex, type StationPaths } from './buildingPaths';
import { schedulerInfo, type SchedulerKey } from '../sim/scheduler';
import { gsmTrafficChannels, occupiedBandwidthMHz, powerUnits, rbBandwidthHz, resourceBlocks } from './presets';
import { seedFromString, shadowingDb } from './shadowing';

/**
 * Flattened, serialisable description of one cell (= one sector of a station),
 * with everything needed for the per-point link budget precomputed.
 */
export interface CellRF {
  idx: number;
  bsId: string;
  sectorId: string;
  name: string;
  siteSeed: number;
  x: number;
  y: number;
  lat: number;
  lng: number;
  hb: number;
  tech: Tech;
  operatorIdx: number;
  freqMHz: number;
  occBwMHz: number;
  fLo: number;
  fHi: number;
  /** Transmit power per power unit (RE / carrier) after cable loss, dBm. */
  refTxDbm: number;
  /** 10*log10(power units): adds to a per-RE level to get total carrier power. */
  unitsDb: number;
  gain: number;
  azimuth: number;
  hbw: number;
  vbw: number;
  tilt: number;
  ftb: number;
  plA: number;
  plB: number;
  /** Free-space constant 32.45 + 20 log10(f): FSPL = fsConst + 20 log10(d_km). */
  fsConst: number;
  noiseDbm: number;
  pci: number;
  rbs: number;
  rbBwHz: number;
  tch: number;
  maxUsers: number;
  color: string;
  /** Antenna / MIMO configuration. */
  ports: number;
  maxLayers: number;
  codebook: boolean;
  bfGainDb: number;
  maxMu: number;
  /** Highest modulation and its per-layer spectral-efficiency cap. */
  modulation: ModulationKey;
  seMax: number;
  /** Station's scheduler override, or null to use the global setting. */
  scheduler: SchedulerKey | null;
  /** Index into RadioContext.paths, or −1 (Hata). */
  pathMap: number;
}

export interface RadioContext {
  cells: CellRF[];
  /** overlap[i*C+j]: fraction of interferer j's power that falls into victim i's band. */
  overlap: Float32Array;
  hm: number;
  shadowing: boolean;
  sigma: number;
  decorr: number;
  lat0: number;
  lng0: number;
  /** Building-aware path maps (COST-231 WI on OSM buildings), indexed by CellRF.pathMap. */
  paths: { loss: Float32Array[]; cond: Uint8Array[]; version: number } | null;
}

/** Supplies a station's building path map, or null to use Hata for it. */
export type PathProvider = (bs: BaseStation, x: number, y: number) => StationPaths | null;

const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9a6324', '#800000', '#808000', '#000075', '#e6beff', '#ffd8b1', '#aaffc3', '#fabed4', '#dcbeff', '#ff6f00', '#00897b'];

export function cellColor(idx: number): string {
  if (idx < PALETTE.length) return PALETTE[idx];
  const h = (idx * 137.508) % 360;
  return `hsl(${h.toFixed(0)}, 70%, 50%)`;
}

export function buildRadioContext(scn: Scenario, paths?: PathProvider, pathsVersion = 0): RadioContext {
  const r = scn.settings.radio;
  const proj = new LocalProjection(scn.center.lat, scn.center.lng);
  const opIndex = new Map(scn.operators.map((o, i) => [o.id, i]));
  const cells: CellRF[] = [];
  const pathLoss: Float32Array[] = [];
  const pathCond: Uint8Array[] = [];

  for (const bs of scn.stations) {
    if (!bs.enabled) continue;
    const { x, y } = proj.toXY(bs.lat, bs.lng);
    const siteSeed = seedFromString(bs.id);
    const sp = paths && r.model === 'cost231-wi' ? paths(bs, x, y) : null;
    const pathMap = sp ? pathLoss.push(sp.loss) - 1 : -1;
    if (sp) pathCond.push(sp.cond);
    bs.sectors.forEach((s, si) => {
      if (!s.enabled) return;
      const bw = bs.tech === 'GSM' ? 0.2 : bs.bandwidthMHz;
      const occ = occupiedBandwidthMHz(bs.tech, bw, s.freqMHz);
      const units = powerUnits(bs.tech, bw, s.freqMHz);
      const pl = pathLossCoeffs(s.freqMHz, bs.heightM, r.ueHeightM, r.environment, r.model);
      cells.push({
        idx: cells.length,
        bsId: bs.id,
        sectorId: s.id,
        name: `${bs.name}-${si + 1}`,
        siteSeed,
        x,
        y,
        lat: bs.lat,
        lng: bs.lng,
        hb: bs.heightM,
        tech: bs.tech,
        operatorIdx: opIndex.get(bs.operatorId) ?? 0,
        freqMHz: s.freqMHz,
        occBwMHz: occ,
        fLo: s.freqMHz - occ / 2,
        fHi: s.freqMHz + occ / 2,
        refTxDbm: bs.txPowerDbm - bs.cableLossDb - 10 * Math.log10(units),
        unitsDb: 10 * Math.log10(units),
        gain: s.gain,
        azimuth: s.azimuth,
        hbw: s.hBeamwidth,
        vbw: s.vBeamwidth,
        tilt: s.tilt,
        ftb: s.frontToBack,
        plA: pl.A,
        plB: pl.B,
        fsConst: 32.45 + 20 * Math.log10(s.freqMHz),
        noiseDbm: -174 + 10 * Math.log10(occ * 1e6) + r.ueNoiseFigureDb,
        pci: s.pci,
        rbs: resourceBlocks(bs.tech, bw, s.freqMHz),
        rbBwHz: rbBandwidthHz(bs.tech, s.freqMHz),
        tch: bs.tech === 'GSM' ? gsmTrafficChannels(bs.trxCount) : 0,
        maxUsers: bs.maxUsers,
        color: cellColor(cells.length),
        ...(() => {
          const a = antennaType(validAntennaFor(bs.tech, bs.antennaType));
          return { ports: a.ports, maxLayers: a.maxLayers, codebook: a.codebook, bfGainDb: a.bfGainDb, maxMu: a.maxMu };
        })(),
        ...(() => {
          const m = modulation(validModulationFor(bs.tech, bs.maxModulation));
          return { modulation: m.key, seMax: m.seMax };
        })(),
        scheduler: schedulerInfo(bs.scheduler)?.key ?? null,
        pathMap,
      });
    });
  }

  return {
    cells,
    overlap: buildOverlap(cells, r),
    hm: r.ueHeightM,
    shadowing: r.shadowingEnabled,
    sigma: r.shadowingSigmaDb,
    decorr: r.shadowingDecorrM,
    lat0: scn.center.lat,
    lng0: scn.center.lng,
    paths: pathLoss.length ? { loss: pathLoss, cond: pathCond, version: pathsVersion } : null,
  };
}

export function buildOverlap(cells: CellRF[], r: RadioSettings): Float32Array {
  const C = cells.length;
  const out = new Float32Array(C * C);
  const adj = Math.pow(10, -r.gsmAdjacentRejectionDb / 10);
  for (let i = 0; i < C; i++) {
    const v = cells[i];
    for (let j = 0; j < C; j++) {
      if (i === j) continue;
      const a = cells[j];
      const ov = Math.min(v.fHi, a.fHi) - Math.max(v.fLo, a.fLo);
      let frac = ov > 1e-6 ? ov / a.occBwMHz : 0;
      // GSM adjacent-channel leakage (carriers 200 kHz apart touch but do not overlap).
      if (frac === 0 && v.tech === 'GSM' && a.tech === 'GSM' && Math.abs(Math.abs(v.freqMHz - a.freqMHz) - 0.2) < 1e-3) {
        frac = adj;
      }
      out[i * C + j] = frac;
    }
  }
  return out;
}

const DEG = 180 / Math.PI;

/** Received per-unit level (RSRP for LTE/NR, RxLev for GSM), dBm, at local (x,y). */
export function rxLevel(ctx: RadioContext, c: CellRF, x: number, y: number): number {
  const dx = x - c.x;
  const dy = y - c.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  let brg = Math.atan2(dx, dy) * DEG;
  if (brg < 0) brg += 360;
  const elev = Math.atan2(c.hb - ctx.hm, Math.max(d, 1)) * DEG;
  const att = antennaAttenuation(brg - c.azimuth, elev, c.hbw, c.vbw, c.tilt, c.ftb);
  let pl = NaN;
  if (c.pathMap >= 0 && ctx.paths) {
    // Building-aware path loss from the station's precomputed polar map.
    const k = pathSampleIndex(d, brg);
    if (k >= 0) pl = ctx.paths.loss[c.pathMap][k];
  }
  if (pl !== pl) {
    // Inlined pathLoss() (hot loop): Hata median, floored at free space.
    const ld = Math.log10(Math.max(d / 1000, MIN_DISTANCE_KM));
    const hata = c.plA + c.plB * ld;
    const fs = c.fsConst + 20 * ld;
    pl = hata > fs ? hata : fs;
  }
  const sh = ctx.shadowing ? shadowingDb(c.siteSeed, x, y, ctx.sigma, ctx.decorr) : 0;
  return c.refTxDbm + c.gain + c.bfGainDb + att - pl - sh;
}

/** LOS / NLOS / indoor for the path from cell c to (x,y), or Unknown when Hata is used there. */
export function pathCondition(ctx: RadioContext, c: CellRF, x: number, y: number): number {
  if (c.pathMap < 0 || !ctx.paths) return PathCond.Unknown;
  const dx = x - c.x;
  const dy = y - c.y;
  let brg = Math.atan2(dx, dy) * DEG;
  if (brg < 0) brg += 360;
  const k = pathSampleIndex(Math.sqrt(dx * dx + dy * dy), brg);
  return k >= 0 ? ctx.paths.cond[c.pathMap][k] : PathCond.Unknown;
}

export const dbmToMw = (dbm: number) => Math.pow(10, dbm / 10);
export const mwToDbm = (mw: number) => 10 * Math.log10(mw);

/**
 * Wideband SINR (C/(I+N) for GSM) of victim cell `i` given per-unit levels of
 * all cells at the point, and per-cell interferer load factors.
 */
export function sinrDb(ctx: RadioContext, levels: Float64Array | Float32Array, i: number, loads: Float32Array | null): number {
  const C = ctx.cells.length;
  const v = ctx.cells[i];
  const sMw = dbmToMw(levels[i] + v.unitsDb);
  let iMw = 0;
  const row = i * C;
  for (let j = 0; j < C; j++) {
    const f = ctx.overlap[row + j];
    if (f === 0) continue;
    const l = levels[j];
    if (l === -Infinity) continue;
    iMw += dbmToMw(l + ctx.cells[j].unitsDb) * f * (loads ? loads[j] : 1);
  }
  return 10 * Math.log10(sMw / (iMw + dbmToMw(v.noiseDbm)));
}

/**
 * Rank-adapted MIMO link to a UE with `ueRx` receive antennas. Per-layer spectral
 * efficiency is truncated Shannon (TR 36.942), capped by the cell's max modulation.
 */
export function linkRank(c: CellRF, sinr: number, ueRx: number, r: RadioSettings): RankChoice {
  if (c.tech === 'GSM') return { rank: 1, se: 0, layerSinrDb: sinr };
  return bestRank(sinr, c, ueRx, c.seMax, r);
}

/** Modulation the UE's layers run at, or null when the link carries nothing. */
export function linkModulation(c: CellRF, link: RankChoice): Modulation | null {
  if (c.tech === 'GSM') return modulation('gmsk');
  return modulationForSe(link.se / link.rank, c.modulation);
}

/** Achievable rate on one resource block (all layers), Mbps. */
export function ratePerRbMbps(c: CellRF, sinr: number, r: RadioSettings, ueRx = 1): number {
  return (linkRank(c, sinr, ueRx, r).se * c.rbBwHz * (1 - r.overhead)) / 1e6;
}

/** Peak single-user throughput at a given SINR (all RBs to one UE, no MU-MIMO), Mbps. */
export function peakRateMbps(c: CellRF, sinr: number, r: RadioSettings, ueRx = 1): number {
  return ratePerRbMbps(c, sinr, r, ueRx) * c.rbs;
}

/** GSM data (GPRS CS-2) per timeslot, Mbps. */
export const GSM_SLOT_MBPS = 0.0134;
