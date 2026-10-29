import { LocalProjection } from '../geo';
import { GSM_SLOT_MBPS, linkRank, ratePerRbMbps, rxLevel, sinrDb, type RadioContext } from '../radio/cells';
import { wifiRateMbps, wifiRssi, wifiSinrDb } from '../radio/wifi';
import { muMimoGain } from '../radio/mimo';
import { allocate, jainIndex, pfDiversityGainDb, schedulerInfo, type SchedulerKey } from './scheduler';
import type { Mobility, Scenario, Settings, Tech, TrafficMode, UserSpec } from '../types';
import { CELL_HISTORY_S, EventLog, emptyCounters, percentile, type CellSample, type KpiCounters, type KpiSample, type SimEventType } from './kpi';
import { route, type Bounds, type RoadGraph, type TravelMode } from './roads';

const TECH_BIT: Record<Tech, number> = { GSM: 1, LTE: 2, NR: 4 };
const TECH_LIST: Tech[] = ['GSM', 'LTE', 'NR'];
export const techMaskOf = (techs: Tech[]) => techs.reduce((m, t) => m | TECH_BIT[t], 0) || TECH_BIT.GSM;
export const techsOf = (mask: number) => TECH_LIST.filter((t) => mask & TECH_BIT[t]);
/** Retry delay for continuous-traffic users after a block / drop, s. */
const CONTINUOUS_RETRY_S = { block: 5, drop: 2 };
/** VoLTE/VoNR guaranteed bit rate incl. header overhead, Mbps. */
const VOICE_GBR_MBPS = 0.03;
/** Fraction of RBs available to GBR admission. */
const GBR_ADMISSION_LIMIT = 0.9;
/** Idle-mode reselection hysteresis, dB. */
const RESELECT_HYST_DB = 2;

export type SessionKind = 'voice' | 'data';

export interface Session {
  kind: SessionKind;
  start: number;
  end: number;
  demandMbps: number;
}

export interface SimUser {
  id: number;
  /** The scenario user entry this live user was created from. */
  specId: string | null;
  /** Speed set explicitly (not re-drawn on each trip). */
  speedFixed: boolean;
  name: string | null;
  opIdx: number;
  techMask: number;
  mode: Mobility;
  traffic: TrafficMode;
  /** Fixed data demand, Mbps; null = random per session. */
  demandMbps: number | null;
  /** Receive antennas set for this phone; null = default for its device type. */
  ueRxOverride: number | null;
  speed: number;
  /** Being dragged on the map: mobility is suspended. */
  dragging: boolean;
  x: number;
  y: number;
  lat: number;
  lng: number;
  path: number[] | null;
  pathIdx: number;
  dwellUntil: number;
  /** Random-waypoint target when no road graph is loaded (or the final leg to `target`). */
  wx: number;
  wy: number;
  /** Destination set for this user: it walks/drives there along the roads and stops. */
  target: { x: number; y: number; lat: number; lng: number } | null;
  /** Reached `target`: stands still until the target changes or it is moved. */
  arrived: boolean;
  serving: number;
  servingKey: string | null;
  rx: number;
  sinr: number;
  thrMbps: number;
  /** MIMO layers currently used on the downlink (0 when not served). */
  rank: number;
  hoCand: number;
  hoTimerMs: number;
  rlfTimerMs: number;
  session: Session | null;
  nextVoice: number;
  nextData: number;
  prevCellKey: string | null;
  lastHoT: number;
  /** Phone has Wi-Fi switched on. */
  wifiOn: boolean;
  /** Associated AP (index into ctx.wifi), −1 = not associated. */
  wifiAp: number;
  wifiApId: string | null;
  wifiRssi: number;
  wifiSinr: number;
  /** Candidate AP and how long the join condition has held, ms. */
  wifiCand: number;
  wifiTimerMs: number;
}

/** Live statistics of one Wi-Fi AP. */
export interface ApState {
  /** Associated users. */
  assoc: number;
  /** Associated users with a session carried over Wi-Fi. */
  active: number;
  /** Airtime in use, 0..1. */
  airtime: number;
  servedMbps: number;
  demandMbps: number;
  /** Throughput the AP could deliver now (mean user rate, capped by backhaul), Mbps. */
  capacityMbps: number;
  joins: number;
  leaves: number;
}

const emptyAp = (): ApState => ({ assoc: 0, active: 0, airtime: 0, servedMbps: 0, demandMbps: 0, capacityMbps: 0, joins: 0, leaves: 0 });

export interface CellState {
  /** Users with an active session on the cell. */
  active: number;
  /** Users camped (idle or active). */
  camped: number;
  usedRb: number;
  gbrRb: number;
  tchUsed: number;
  /** PRB / timeslot utilisation, 0..1. */
  load: number;
  /** Current MU-MIMO capacity multiplier (1 = no pairing). */
  muGain: number;
  /** Scheduler in effect on this cell. */
  scheduler: SchedulerKey;
  hoIn: number;
  hoOut: number;
  drops: number;
  blocks: number;
  /** DL throughput delivered to the cell's users now, Mbps. */
  servedMbps: number;
  /** What the cell's active users ask for (data demand + voice GBR), Mbps. */
  demandMbps: number;
  /**
   * Estimated cell capacity now: every RB (× MU-MIMO gain) at the mean rate per RB
   * of the cell's current users; with no users, at a typical 10 dB / 2Rx link. GSM:
   * all traffic channels as GPRS slots.
   */
  capacityMbps: number;
  /** Sessions admitted on this cell (new sessions, not handovers). */
  started: number;
}

/**
 * Scheduler fairness: Jain's index of data users' satisfaction (throughput / demand)
 * within each cell, averaged over cells with at least two data users. Cell-level,
 * because a scheduler only shares resources inside its own cell.
 */
function meanCellFairness(byCell: Map<number, number[]>): number {
  let sum = 0;
  let n = 0;
  for (const l of byCell.values()) {
    if (l.length < 2) continue;
    sum += jainIndex(l);
    n++;
  }
  return n ? sum / n : 1;
}

/** Small, fast, seedable PRNG. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable pseudo-random number in [0,1) from a string (FNV-1a), e.g. "does this phone have Wi-Fi on". */
export function stableShare(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/** APs farther than this are not measured (far below any useful RSSI). */
const WIFI_MAX_RANGE_M = 600;
/** Minimum airtime activity assumed for an AP (beacons, management frames). */
const WIFI_MIN_ACTIVITY = 0.05;

const cellKey = (ctx: RadioContext, i: number) => `${ctx.cells[i].bsId}/${ctx.cells[i].sectorId}`;

export class SimEngine {
  ctx!: RadioContext;
  settings!: Settings;
  scn!: Scenario;
  proj!: LocalProjection;
  graph: RoadGraph | null = null;
  area: Bounds;
  users: SimUser[] = [];
  cells: CellState[] = [];
  aps: ApState[] = [];
  /** Airtime activity per AP, used as the interference weight of co-channel APs. */
  private apActivity = new Float32Array(0);
  private apRssi = new Float64Array(0);
  /** Interference load factor per cell, consumed by SINR computation. */
  loads = new Float32Array(0);
  t = 0;
  counters: KpiCounters = emptyCounters();
  samples: KpiSample[] = [];
  /** Per-cell history, keyed by sector id (stable across network edits). */
  cellHistory = new Map<string, CellSample[]>();
  log = new EventLog(5000);
  private rng = mulberry32(1);
  private levels = new Float64Array(0);
  private stamp = new Uint32Array(0);
  private stepId = 0;
  /** Cells each (operator, device-capability) combination can camp on. */
  private candidates = new Map<string, number[]>();
  /** For each cell, the cells whose spectrum overlaps it (interferers). */
  private interferers: number[][] = [];
  private nextSampleT = 0;

  constructor(scn: Scenario, ctx: RadioContext, area: Bounds) {
    this.area = area;
    this.setScenario(scn, ctx);
  }

  /** Apply new network/settings; keeps users and remaps their serving cells by id. */
  setScenario(scn: Scenario, ctx: RadioContext) {
    const old = this.ctx;
    this.settings = scn.settings;
    this.scn = scn;
    this.proj = new LocalProjection(ctx.lat0, ctx.lng0);
    this.ctx = ctx;
    const C = ctx.cells.length;
    this.levels = new Float64Array(C);
    this.stamp = new Uint32Array(C);
    this.candidates.clear();
    this.interferers = ctx.cells.map((_, i) => {
      const out: number[] = [];
      for (let j = 0; j < C; j++) if (ctx.overlap[i * C + j] > 0) out.push(j);
      return out;
    });
    const prevLoads = this.loads;
    const prevCells = this.cells;
    const keyToNew = new Map(ctx.cells.map((_, i) => [cellKey(ctx, i), i]));
    this.cells = ctx.cells.map(() => ({ active: 0, camped: 0, usedRb: 0, gbrRb: 0, tchUsed: 0, load: 0, muGain: 1, scheduler: 'rr' as SchedulerKey, hoIn: 0, hoOut: 0, drops: 0, blocks: 0, servedMbps: 0, demandMbps: 0, capacityMbps: 0, started: 0 }));
    this.loads = new Float32Array(C).fill(this.initialLoad());
    if (old) {
      old.cells.forEach((_, i) => {
        const ni = keyToNew.get(cellKey(old, i));
        if (ni === undefined) return;
        if (prevLoads[i] !== undefined) this.loads[ni] = prevLoads[i];
        const pc = prevCells[i];
        if (pc) Object.assign(this.cells[ni], { hoIn: pc.hoIn, hoOut: pc.hoOut, drops: pc.drops, blocks: pc.blocks, started: pc.started });
      });
    }
    // Wi-Fi APs: keep statistics and associations by AP id.
    const prevAps = this.aps;
    const oldWifi = old?.wifi ?? [];
    const apToNew = new Map(ctx.wifi.map((a, i) => [a.apId, i]));
    this.aps = ctx.wifi.map(() => emptyAp());
    oldWifi.forEach((a, i) => {
      const ni = apToNew.get(a.apId);
      if (ni !== undefined && prevAps[i]) Object.assign(this.aps[ni], { joins: prevAps[i].joins, leaves: prevAps[i].leaves });
    });
    this.apActivity = new Float32Array(ctx.wifi.length).fill(0.05);
    this.apRssi = new Float64Array(ctx.wifi.length);
    for (const u of this.users) {
      const ni = u.servingKey ? keyToNew.get(u.servingKey) : undefined;
      u.serving = ni ?? -1;
      if (ni === undefined) u.servingKey = null;
      u.hoCand = -1;
      u.hoTimerMs = 0;
      const na = u.wifiApId ? apToNew.get(u.wifiApId) : undefined;
      u.wifiAp = na ?? -1;
      if (na === undefined) u.wifiApId = null;
      u.wifiCand = -1;
      u.wifiTimerMs = 0;
    }
    // Users without their own Wi-Fi setting follow the (possibly changed) device share.
    const specs = new Map((scn.users ?? []).map((f) => [f.id, f]));
    for (const u of this.users) {
      const f = u.specId ? specs.get(u.specId) : undefined;
      if (f && f.wifi == null) u.wifiOn = this.wifiDefault(f.id);
    }
    this.recountOccupancy();

  }

  setGraph(g: RoadGraph | null) {
    this.graph = g;
    if (g) this.area = g.bounds;
  }

  private initialLoad() {
    return this.settings.radio.interferenceLoad === 'full' ? 1 : Math.max(this.settings.radio.minInterfererLoad, 0.5);
  }

  reset() {
    this.t = 0;
    this.counters = emptyCounters();
    this.samples = [];
    this.cellHistory.clear();
    this.log.clear();
    this.nextSampleT = 0;
    this.rng = mulberry32(this.settings.sim.seed);
    for (const c of this.cells) Object.assign(c, { active: 0, camped: 0, usedRb: 0, gbrRb: 0, tchUsed: 0, load: 0, muGain: 1, scheduler: 'rr' as SchedulerKey, hoIn: 0, hoOut: 0, drops: 0, blocks: 0, servedMbps: 0, demandMbps: 0, capacityMbps: 0, started: 0 });
    this.aps = this.ctx.wifi.map(() => emptyAp());
    this.apActivity.fill(0.05);
    this.loads.fill(this.initialLoad());
    this.spawnUsers();
  }

  // ---------------------------------------------------------------- users

  private nextUserId = 0;

  /** (Re)create the live users from the scenario's user list, at their start positions. */
  spawnUsers() {
    this.users = [];
    this.nextUserId = 0;
    for (const spec of this.scn.users ?? []) this.addUser(spec);
    this.recountOccupancy();
  }

  private newUser(opIdx: number, techMask: number, mode: Mobility): SimUser {
    const us = this.settings.users;
    return {
        id: this.nextUserId++,
        specId: null,
        speedFixed: false,
        name: null,
        opIdx,
        techMask,
        mode,
        traffic: 'random',
        demandMbps: null,
        ueRxOverride: null,
        speed: this.randSpeed(mode),
        dragging: false,
        x: 0,
        y: 0,
        lat: 0,
        lng: 0,
        path: null,
        pathIdx: 0,
        dwellUntil: 0,
        wx: 0,
        wy: 0,
        target: null,
        arrived: false,
        serving: -1,
        servingKey: null,
        rx: -Infinity,
        sinr: -Infinity,
        thrMbps: 0,
        rank: 0,
        hoCand: -1,
        hoTimerMs: 0,
        rlfTimerMs: 0,
        session: null,
        nextVoice: this.expo(3600 / Math.max(us.voiceCallsPerHour, 1e-6)),
        nextData: this.expo(3600 / Math.max(us.dataSessionsPerHour, 1e-6)),
        prevCellKey: null,
        lastHoT: -1e9,
        wifiOn: stableShare(`u${this.nextUserId}`) < this.settings.wifi.deviceShare,
        wifiAp: -1,
        wifiApId: null,
        wifiRssi: -Infinity,
        wifiSinr: -Infinity,
        wifiCand: -1,
        wifiTimerMs: 0,
      };
  }

  private randSpeed(mode: Mobility) {
    const us = this.settings.users;
    if (mode === 'static') return 0;
    return mode === 'walk' ? us.pedSpeedMin + this.rng() * (us.pedSpeedMax - us.pedSpeedMin) : us.vehSpeedMin + this.rng() * (us.vehSpeedMax - us.vehSpeedMin);
  }

  private expo(mean: number) {
    return -Math.log(1 - this.rng()) * mean;
  }

  private effectiveMode(u: SimUser): TravelMode {
    return u.mode === 'drive' && this.graph && this.graph.drive.pool.length > 0 ? 'drive' : 'walk';
  }

  private placeAtRandom(u: SimUser) {
    const g = this.graph;
    // Static users can be anywhere (indoors); moving ones start on the road network.
    if (g && u.mode !== 'static') {
      const pool = (this.effectiveMode(u) === 'walk' ? g.walk : g.drive).pool;
      if (pool.length) {
        const n = pool[Math.floor(this.rng() * pool.length)];
        u.x = g.x[n];
        u.y = g.y[n];
        u.path = [n];
        u.pathIdx = 1;
        this.syncLatLng(u);
        return;
      }
    }
    const p = this.randomPointInArea();
    u.x = p.x;
    u.y = p.y;
    const w = this.randomPointInArea();
    u.wx = w.x;
    u.wy = w.y;
    this.syncLatLng(u);
  }

  private randomPointInArea() {
    const a = this.area;
    const lat = a.south + this.rng() * (a.north - a.south);
    const lng = a.west + this.rng() * (a.east - a.west);
    return this.proj.toXY(lat, lng);
  }

  private syncLatLng(u: SimUser) {
    const p = this.proj.toLatLng(u.x, u.y);
    u.lat = p.lat;
    u.lng = p.lng;
  }

  private newTrip(u: SimUser) {
    const g = this.graph!;
    const mode = this.effectiveMode(u);
    const pool = (mode === 'walk' ? g.walk : g.drive).pool;
    const from = u.path ? u.path[u.path.length - 1] : pool[0];
    for (let attempt = 0; attempt < 4; attempt++) {
      const to = pool[Math.floor(this.rng() * pool.length)];
      if (to === from) continue;
      const p = route(g, mode, from, to);
      if (p && p.length > 1) {
        u.path = p;
        u.pathIdx = 1;
        // Users with a set speed keep it; others draw a new one per trip.
        if (!u.speedFixed) u.speed = this.randSpeed(u.mode);
        return;
      }
    }
    // Stuck (e.g. one-way dead end): teleport to a fresh node.
    this.placeAtRandom(u);
  }

  private move(u: SimUser, dt: number) {
    if (u.mode === 'static' || u.dragging || u.arrived || this.t < u.dwellUntil) return;
    let dist = u.speed * dt;
    const g = this.graph;
    if (g && u.path) {
      while (dist > 0) {
        if (u.pathIdx >= u.path.length) {
          if (u.target) {
            // Off the road graph for the last metres: straight to the exact target point.
            u.path = null;
            u.wx = u.target.x;
            u.wy = u.target.y;
            break;
          }
          u.dwellUntil = this.t + (u.mode === 'walk' ? this.rng() * 30 : this.rng() * 5);
          this.newTrip(u);
          break;
        }
        const n = u.path[u.pathIdx];
        const dx = g.x[n] - u.x;
        const dy = g.y[n] - u.y;
        const d = Math.hypot(dx, dy);
        if (d <= dist) {
          u.x = g.x[n];
          u.y = g.y[n];
          dist -= d;
          u.pathIdx++;
        } else {
          u.x += (dx / d) * dist;
          u.y += (dy / d) * dist;
          dist = 0;
        }
      }
    } else {
      const dx = u.wx - u.x;
      const dy = u.wy - u.y;
      const d = Math.hypot(dx, dy);
      if (d <= dist) {
        u.x = u.wx;
        u.y = u.wy;
        if (u.target) {
          u.arrived = true;
          this.syncLatLng(u);
          return;
        }
        const w = this.randomPointInArea();
        u.wx = w.x;
        u.wy = w.y;
        u.dwellUntil = this.t + this.rng() * 20;
      } else {
        u.x += (dx / d) * dist;
        u.y += (dy / d) * dist;
      }
    }
    this.syncLatLng(u);
  }

  // ---------------------------------------------------------------- radio

  private candidateCells(u: SimUser): number[] {
    const key = `${u.opIdx}:${u.techMask}`;
    let list = this.candidates.get(key);
    if (!list) {
      list = [];
      this.ctx.cells.forEach((c, i) => {
        if (c.operatorIdx === u.opIdx && TECH_BIT[c.tech] & u.techMask) list!.push(i);
      });
      this.candidates.set(key, list);
    }
    return list;
  }

  private level(i: number, x: number, y: number): number {
    if (this.stamp[i] !== this.stepId) {
      this.stamp[i] = this.stepId;
      this.levels[i] = rxLevel(this.ctx, this.ctx.cells[i], x, y);
    }
    return this.levels[i];
  }

  /** Make sure every interferer of cell i has a level at (x,y), then compute SINR. */
  private sinrAt(i: number, x: number, y: number): number {
    for (const j of this.interferers[i]) this.level(j, x, y);
    // Cells without a fresh stamp hold stale values; mask them out.
    const C = this.ctx.cells.length;
    const lv = this.levels;
    for (let j = 0; j < C; j++) if (this.stamp[j] !== this.stepId) lv[j] = -Infinity;
    this.level(i, x, y);
    return sinrDb(this.ctx, lv, i, this.loads);
  }

  /** Best cell per technology among the user's candidates. */
  private bestPerTech(u: SimUser) {
    const best: Record<Tech, number> = { GSM: -1, LTE: -1, NR: -1 };
    const lvl: Record<Tech, number> = { GSM: -Infinity, LTE: -Infinity, NR: -Infinity };
    for (const i of this.candidateCells(u)) {
      const l = this.level(i, u.x, u.y);
      const t = this.ctx.cells[i].tech;
      if (l > lvl[t]) {
        lvl[t] = l;
        best[t] = i;
      }
    }
    return { best, lvl };
  }

  /** Highest-priority technology whose best cell is above its camping threshold. */
  private selectCell(best: Record<Tech, number>, lvl: Record<Tech, number>, exclude?: Tech): number {
    const th = this.settings.thresholds;
    let pick = -1;
    let pickPrio = -Infinity;
    for (const t of TECH_LIST) {
      if (t === exclude || best[t] < 0 || lvl[t] < th[t].minRxDbm) continue;
      if (th[t].priority > pickPrio) {
        pickPrio = th[t].priority;
        pick = best[t];
      }
    }
    return pick;
  }

  // ---------------------------------------------------------------- capacity

  /** Handover parameters for UEs served by cell i: the cell's overrides, else the RAT defaults. */
  hoParams(i: number): { hysteresisDb: number; a3OffsetDb: number; tttMs: number; cioDb: number } {
    const c = this.ctx.cells[i];
    const t = this.settings.thresholds[c.tech];
    return { hysteresisDb: c.hoHystDb ?? t.hysteresisDb, a3OffsetDb: c.hoA3OffsetDb ?? t.a3OffsetDb, tttMs: c.hoTttMs ?? t.tttMs, cioDb: c.cioDb };
  }

  /** Scheduler used by cell i: the station's override, else the global setting. */
  cellScheduler(i: number): SchedulerKey {
    return this.ctx.cells[i].scheduler ?? schedulerInfo(this.settings.radio.scheduler)?.key ?? 'rr';
  }

  /** Default receive antennas for the device type (its best supported RAT). */
  defaultUeRx(u: SimUser): number {
    const us = this.settings.users;
    return u.techMask & TECH_BIT.NR ? us.ueRxNr : u.techMask & TECH_BIT.LTE ? us.ueRxLte : 1;
  }

  /** UE receive antennas: the per-phone setting, else the device-type default. */
  ueRx(u: SimUser): number {
    return u.ueRxOverride ?? this.defaultUeRx(u);
  }

  setUeRx(u: SimUser, n: number | null) {
    u.ueRxOverride = n === null ? null : Math.max(1, Math.round(n));
    this.refreshUser(u);
  }

  private canAdmit(i: number, kind: SessionKind, u: SimUser): boolean {
    const c = this.ctx.cells[i];
    const s = this.cells[i];
    if (s.active >= c.maxUsers) return false;
    if (c.tech === 'GSM') return s.tchUsed < c.tch;
    if (kind === 'voice') {
      const r = ratePerRbMbps(c, u.sinr, this.settings.radio, this.ueRx(u));
      if (r <= 0) return false;
      return s.gbrRb + VOICE_GBR_MBPS / r <= c.rbs * GBR_ADMISSION_LIMIT;
    }
    return true;
  }

  private attach(i: number) {
    const s = this.cells[i];
    s.active++;
    if (this.ctx.cells[i].tech === 'GSM') s.tchUsed++;
  }

  private detach(u: SimUser) {
    if (u.serving < 0 || !u.session || this.onWifi(u)) return;
    const s = this.cells[u.serving];
    s.active = Math.max(0, s.active - 1);
    if (this.ctx.cells[u.serving].tech === 'GSM') s.tchUsed = Math.max(0, s.tchUsed - 1);
  }

  // ---------------------------------------------------------------- Wi-Fi offload

  /** Wi-Fi can carry this kind of session (voice only with voice over Wi-Fi). */
  private wifiCarries(kind: SessionKind): boolean {
    return kind === 'data' || this.settings.wifi.voiceOverWifi;
  }

  /** The user's current session is carried by its Wi-Fi AP, not by the cellular network. */
  onWifi(u: SimUser): boolean {
    return u.wifiAp >= 0 && !!u.session && this.wifiCarries(u.session.kind);
  }

  private apAllowed(u: SimUser, j: number): boolean {
    const ap = this.ctx.wifi[j];
    return ap.opIdx < 0 || ap.opIdx === u.opIdx;
  }

  private moving(u: SimUser): boolean {
    return u.mode !== 'static' && !u.dragging && !u.arrived && this.t >= u.dwellUntil;
  }

  /**
   * Measure all nearby APs into apRssi; returns the best AP the user may associate with
   * (−1 if none). Also updates the user's Wi-Fi RSSI/SINR for its AP (or the best one).
   */
  private wifiMeasure(u: SimUser): number {
    const ws = this.settings.wifi;
    const aps = this.ctx.wifi;
    const rssi = this.apRssi;
    let best = -1;
    for (let j = 0; j < aps.length; j++) {
      const ap = aps[j];
      if (Math.abs(u.x - ap.x) > WIFI_MAX_RANGE_M || Math.abs(u.y - ap.y) > WIFI_MAX_RANGE_M) {
        rssi[j] = -Infinity;
        continue;
      }
      rssi[j] = wifiRssi(ap, u.x, u.y, ws);
      if (!this.apAllowed(u, j)) continue;
      const full = j !== u.wifiAp && this.aps[j].assoc >= ap.maxUsers;
      if (!full && (best < 0 || rssi[j] > rssi[best])) best = j;
    }
    const k = u.wifiAp >= 0 ? u.wifiAp : best;
    u.wifiRssi = k >= 0 ? rssi[k] : -Infinity;
    u.wifiSinr = k >= 0 && rssi[k] > -Infinity ? wifiSinrDb(aps, rssi, k, this.apActivity) : -Infinity;
    return best;
  }

  /** Throughput the user would get on AP j if it joined now, Mbps (equal airtime share). */
  private wifiEstimate(u: SimUser, j: number): number {
    const ws = this.settings.wifi;
    const ap = this.ctx.wifi[j];
    const sinr = wifiSinrDb(this.ctx.wifi, this.apRssi, j, this.apActivity);
    const n = this.aps[j].active + (j === u.wifiAp ? 0 : 1);
    return Math.min(wifiRateMbps(ap, sinr, ws.ueStreams, ws.alpha), ap.backhaulMbps) / Math.max(n, 1);
  }

  /** Throughput the user gets (or would get) on its cellular cell, Mbps. */
  private cellularEstimate(u: SimUser): number {
    if (u.serving < 0) return 0;
    if (u.session && !this.onWifi(u)) return u.thrMbps;
    const c = this.ctx.cells[u.serving];
    if (c.tech === 'GSM') return GSM_SLOT_MBPS;
    const free = Math.max(0, 1 - this.cells[u.serving].load);
    const n = this.cells[u.serving].active + 1;
    return ratePerRbMbps(c, u.sinr, this.settings.radio, this.ueRx(u)) * c.rbs * Math.max(free, 1 / n);
  }

  /** The offload policy allows moving this user from cellular to AP j. */
  private policyAllows(u: SimUser, j: number): boolean {
    const ws = this.settings.wifi;
    if (u.serving < 0) return true; // no cellular service: anything is better
    switch (ws.policy) {
      case 'prefer-wifi':
        return true;
      case 'cell-load':
        return this.cells[u.serving].load >= ws.loadThreshold;
      case 'better-throughput':
        return this.wifiEstimate(u, j) > this.cellularEstimate(u) * ws.throughputMargin;
    }
  }

  private wifiJoin(u: SimUser, j: number) {
    const from = u.wifiAp;
    const name = this.ctx.wifi[j].name;
    if (from >= 0) {
      // Roaming between APs: the session stays on Wi-Fi.
      this.aps[from].assoc = Math.max(0, this.aps[from].assoc - 1);
      this.aps[from].leaves++;
      u.wifiAp = j;
      u.wifiApId = this.ctx.wifi[j].apId;
      this.aps[j].assoc++;
      this.aps[j].joins++;
      this.emit('WIFI_JOIN', u, `roamed ${this.ctx.wifi[from].name} → ${name}`, undefined, undefined, j);
      return;
    }
    const moved = !!u.session && this.wifiCarries(u.session.kind);
    if (moved) {
      this.detach(u); // leave the cell before onWifi() becomes true
      this.counters.wifiOffloads++;
    }
    u.wifiAp = j;
    u.wifiApId = this.ctx.wifi[j].apId;
    u.hoCand = -1;
    u.hoTimerMs = 0;
    u.rlfTimerMs = 0;
    this.aps[j].assoc++;
    this.aps[j].joins++;
    this.emit('WIFI_JOIN', u, `associated to ${name}, RSSI ${u.wifiRssi.toFixed(0)} dBm${moved ? `, ${u.session!.kind} session offloaded` : ''}`, moved ? u.serving : undefined, undefined, j);
  }

  /** Leave the AP; a session it carried goes back to cellular, or drops if the cell can't take it. */
  private wifiLeave(u: SimUser, reason: string) {
    const j = u.wifiAp;
    if (j < 0) return;
    const carried = this.onWifi(u);
    const name = this.ctx.wifi[j]?.name ?? u.wifiApId ?? 'AP';
    if (this.aps[j]) {
      this.aps[j].assoc = Math.max(0, this.aps[j].assoc - 1);
      this.aps[j].leaves++;
    }
    u.wifiAp = -1;
    u.wifiApId = null;
    u.wifiCand = -1;
    u.wifiTimerMs = 0;
    if (!carried) {
      this.emit('WIFI_LEAVE', u, `left ${name}: ${reason}`, undefined, undefined, j);
      return;
    }
    const kind = u.session!.kind;
    this.counters.wifiFallbacks++;
    if (u.serving >= 0) u.sinr = this.sinrAt(u.serving, u.x, u.y);
    if (u.serving >= 0 && this.canAdmit(u.serving, kind, u)) {
      this.attach(u.serving);
      this.emit('WIFI_LEAVE', u, `left ${name}: ${reason}; ${kind} session back on cellular`, undefined, u.serving, j);
      return;
    }
    // Not attached to a cell, so no detach (dropSession would detach).
    if (u.serving >= 0) this.cells[u.serving].drops++;
    this.counters.dropped++;
    this.emit('WIFI_LEAVE', u, `left ${name}: ${reason}`, undefined, undefined, j);
    this.emit('DROP', u, `${kind} dropped: Wi-Fi lost, ${u.serving < 0 ? 'no cellular coverage' : 'no cellular capacity'}`, u.serving);
    this.endSession(u, CONTINUOUS_RETRY_S.drop);
  }

  /** Association management for one user: leave, roam or join with hysteresis and delay. */
  private wifiStep(u: SimUser, dtMs: number) {
    const ws = this.settings.wifi;
    if (!ws.enabled || !u.wifiOn || !this.ctx.wifi.length) {
      if (u.wifiAp >= 0) this.wifiLeave(u, ws.enabled ? 'Wi-Fi switched off' : 'Wi-Fi offload disabled');
      u.wifiRssi = -Infinity;
      u.wifiSinr = -Infinity;
      return;
    }
    const best = this.wifiMeasure(u);
    const tooFast = this.moving(u) && u.speed * 3.6 > ws.maxSpeedKmh;
    const cur = u.wifiAp;
    if (cur >= 0) {
      const r = this.apRssi[cur];
      const reason =
        !this.apAllowed(u, cur) ? 'not allowed for this operator'
        : r < ws.minRssiDbm ? `RSSI ${r === -Infinity ? 'none' : r.toFixed(0) + ' dBm'}`
        : tooFast ? `speed ${(u.speed * 3.6).toFixed(0)} km/h`
        : null;
      if (reason) {
        this.wifiLeave(u, reason);
        this.wifiMeasure(u);
        return;
      }
    }
    // Candidate: a better AP to roam to, or any acceptable AP to join.
    let cand = -1;
    if (best >= 0 && best !== cur && !tooFast) {
      const r = this.apRssi[best];
      if (cur >= 0) {
        if (r > this.apRssi[cur] + ws.hysteresisDb) cand = best;
      } else if (r >= ws.minRssiDbm + ws.hysteresisDb && this.policyAllows(u, best)) cand = best;
    }
    if (cand < 0) {
      u.wifiCand = -1;
      u.wifiTimerMs = 0;
      return;
    }
    if (cand === u.wifiCand) u.wifiTimerMs += dtMs;
    else {
      u.wifiCand = cand;
      u.wifiTimerMs = dtMs;
    }
    if (u.wifiTimerMs >= ws.assocDelayMs) {
      u.wifiCand = -1;
      u.wifiTimerMs = 0;
      this.wifiJoin(u, cand);
      this.wifiMeasure(u);
    }
  }

  /** Wi-Fi on/off for a user without an explicit setting: stable per user, by the device share. */
  wifiDefault(specId: string): boolean {
    return stableShare(specId) < this.settings.wifi.deviceShare;
  }

  /** Switch the phone's Wi-Fi on or off. */
  setWifiOn(u: SimUser, on: boolean) {
    u.wifiOn = on;
    if (!on) this.wifiLeave(u, 'Wi-Fi switched off');
    this.refreshUser(u);
  }

  /**
   * Airtime scheduling on each AP: voice first (when carried), then data with
   * equal throughput (802.11 DCF gives stations equal transmit opportunities, so
   * slow stations drag everyone down: the "performance anomaly"), capped by backhaul.
   */
  private scheduleWifi() {
    const ws = this.settings.wifi;
    const aps = this.ctx.wifi;
    const per: SimUser[][] = aps.map(() => []);
    for (const st of this.aps) Object.assign(st, { assoc: 0, active: 0, airtime: 0, servedMbps: 0, demandMbps: 0, capacityMbps: 0 });
    for (const u of this.users) {
      if (u.wifiAp < 0) continue;
      this.aps[u.wifiAp].assoc++;
      if (this.onWifi(u)) per[u.wifiAp].push(u);
    }
    aps.forEach((ap, j) => {
      const st = this.aps[j];
      const list = per[j];
      const rate = list.map((u) => wifiRateMbps(ap, u.wifiSinr, ws.ueStreams, ws.alpha));
      const air = new Array<number>(list.length).fill(0);
      let pool = 1;
      list.forEach((u, k) => {
        if (u.session!.kind !== 'voice' || rate[k] <= 0) return;
        air[k] = Math.min(VOICE_GBR_MBPS / rate[k], pool);
        pool -= air[k];
      });
      const data = list.map((_, k) => k).filter((k) => list[k].session!.kind === 'data' && rate[k] > 0);
      const a = allocate('maxmin', data.map((k) => ({ rate: rate[k], need: list[k].session!.demandMbps / rate[k] })), pool);
      data.forEach((k, n) => (air[k] = a[n]));
      let served = list.reduce((s, _, k) => s + air[k] * rate[k], 0);
      const scale = served > ap.backhaulMbps ? ap.backhaulMbps / served : 1;
      list.forEach((u, k) => {
        u.thrMbps = air[k] * rate[k] * scale;
        u.rank = rate[k] > 0 ? Math.min(ap.streams, ws.ueStreams) : 0;
      });
      served *= scale;
      st.active = list.length;
      st.airtime = air.reduce((s, x) => s + x * scale, 0);
      st.servedMbps = served;
      st.demandMbps = list.reduce((s, u) => s + (u.session!.kind === 'data' ? u.session!.demandMbps : VOICE_GBR_MBPS), 0);
      const served1 = rate.filter((x) => x > 0);
      const mean = served1.length ? served1.reduce((s, x) => s + x, 0) / served1.length : wifiRateMbps(ap, 25, ws.ueStreams, ws.alpha);
      st.capacityMbps = Math.min(mean, ap.backhaulMbps);
      this.apActivity[j] = Math.max(WIFI_MIN_ACTIVITY, st.airtime);
    });
  }

  private recountOccupancy() {
    for (const s of this.cells) {
      s.active = 0;
      s.tchUsed = 0;
      s.camped = 0;
    }
    for (const u of this.users) {
      if (u.serving < 0) continue;
      this.cells[u.serving].camped++;
      if (u.session && !this.onWifi(u)) this.attach(u.serving);
    }
  }

  // ---------------------------------------------------------------- events

  private emit(type: SimEventType, u: SimUser, detail: string, from?: number, to?: number, ap?: number) {
    this.log.push({
      t: this.t,
      type,
      userId: u.id,
      ap: ap !== undefined && ap >= 0 ? this.ctx.wifi[ap]?.apId : undefined,
      from: from !== undefined && from >= 0 ? this.ctx.cells[from].name : undefined,
      to: to !== undefined && to >= 0 ? this.ctx.cells[to].name : undefined,
      lat: u.lat,
      lng: u.lng,
      detail,
    });
  }

  private setServing(u: SimUser, i: number) {
    u.serving = i;
    u.servingKey = i >= 0 ? cellKey(this.ctx, i) : null;
  }

  private dropSession(u: SimUser, reason: string) {
    this.detach(u);
    if (u.serving >= 0) this.cells[u.serving].drops++;
    this.counters.dropped++;
    this.emit('DROP', u, `${u.session!.kind} dropped: ${reason}`, u.serving);
    this.endSession(u, CONTINUOUS_RETRY_S.drop);
  }

  /** Clear the session and schedule the next arrival (continuous users retry after `retryS`). */
  private endSession(u: SimUser, retryS = 0) {
    const us = this.settings.users;
    u.session = null;
    u.thrMbps = 0;
    u.rank = 0;
    u.rlfTimerMs = 0;
    u.hoCand = -1;
    u.hoTimerMs = 0;
    u.nextVoice = u.traffic === 'voice' ? this.t + retryS : this.t + this.expo(3600 / Math.max(us.voiceCallsPerHour, 1e-6));
    u.nextData = u.traffic === 'data' ? this.t + retryS : this.t + this.expo(3600 / Math.max(us.dataSessionsPerHour, 1e-6));
  }

  private tryHandover(u: SimUser, target: number, irat: boolean) {
    const from = u.serving;
    this.counters.hoAttempts++;
    // Evaluate admission with the SINR the UE would see on the target.
    const curSinr = u.sinr;
    u.sinr = this.sinrAt(target, u.x, u.y);
    const ok = this.canAdmit(target, u.session!.kind, u);
    if (!ok) {
      u.sinr = curSinr;
      this.counters.hoFail++;
      this.emit('HO_FAIL', u, `target full (${u.session!.kind})`, from, target);
      u.hoTimerMs = -2000; // back-off before re-trying
      return;
    }
    this.detach(u);
    this.cells[from].hoOut++;
    this.cells[target].hoIn++;
    const fromKey = u.servingKey;
    this.setServing(u, target);
    this.attach(target);
    this.counters.hoSuccess++;
    if (irat) this.counters.hoIrat++;
    const fc = this.ctx.cells[from];
    const tc = this.ctx.cells[target];
    this.emit(irat ? 'HO_IRAT' : 'HO', u, irat ? `${fc.tech} → ${tc.tech}` : `${tc.tech} intra-frequency${fc.freqMHz === tc.freqMHz ? '' : '/inter-frequency'}`, from, target);
    if (u.prevCellKey === u.servingKey && this.t - u.lastHoT < this.settings.sim.pingPongWindowS) {
      this.counters.pingPong++;
      this.emit('PING_PONG', u, `returned within ${(this.t - u.lastHoT).toFixed(1)} s`, from, target);
    }
    u.prevCellKey = fromKey;
    u.lastHoT = this.t;
    u.hoCand = -1;
    u.hoTimerMs = 0;
    u.rlfTimerMs = 0;
  }

  // ---------------------------------------------------------------- step

  /** Advance the simulation by one fixed step. */
  step() {
    const dtMs = this.settings.sim.stepMs;
    const dt = dtMs / 1000;
    const th = this.settings.thresholds;
    this.t += dt;

    for (const u of this.users) {
      this.move(u, dt);
      this.stepId = (this.stepId + 1) >>> 0 || 1;

      const { best, lvl } = this.bestPerTech(u);
      const servLvl = u.serving >= 0 ? this.level(u.serving, u.x, u.y) : -Infinity;
      this.wifiStep(u, dtMs);

      if (!u.session) {
        this.idleSelect(u, best, lvl, servLvl);

        // ---- session arrivals
        const tr = u.traffic;
        const kind: SessionKind | null =
          tr === 'idle' ? null
          : (tr === 'random' || tr === 'voice') && this.t >= u.nextVoice ? 'voice'
          : (tr === 'random' || tr === 'data') && this.t >= u.nextData ? 'data'
          : null;
        if (kind) this.startSession(u, kind);
        continue;
      }

      // ---- connected mode
      if (this.t >= u.session.end) {
        this.emit('CALL_END', u, `${u.session.kind} completed${this.onWifi(u) ? ' (Wi-Fi)' : ''}`, u.serving);
        this.detach(u);
        this.endSession(u);
        continue;
      }
      if (this.onWifi(u)) {
        // Session carried over Wi-Fi: the phone just stays camped on cellular.
        this.idleSelect(u, best, lvl, servLvl);
        continue;
      }
      if (u.serving < 0) {
        this.dropSession(u, 'no serving cell');
        continue;
      }
      const sc = this.ctx.cells[u.serving];
      const tth = th[sc.tech];
      u.rx = servLvl;
      u.sinr = this.sinrAt(u.serving, u.x, u.y);

      // Radio link failure (T310-like)
      if (u.sinr < tth.qOutSinrDb || servLvl < tth.minRxDbm) {
        u.rlfTimerMs += dtMs;
        if (u.rlfTimerMs >= tth.rlfTimerMs) {
          this.dropSession(u, u.sinr < tth.qOutSinrDb ? `RLF, SINR ${u.sinr.toFixed(1)} dB` : `RLF, level ${servLvl.toFixed(0)} dBm`);
          continue;
        }
      } else {
        u.rlfTimerMs = 0;
      }

      // A3 (3GPP TS 36.331): Mn + CIOn > Ms + CIOs + Off + Hys for TTT, with the
      // serving cell's offset / hysteresis / TTT and each cell's individual offset.
      const hp = this.hoParams(u.serving);
      let cand = -1;
      let irat = false;
      let bestN = -1;
      let bestScore = -Infinity;
      for (const i of this.candidateCells(u)) {
        const nc = this.ctx.cells[i];
        if (i === u.serving || nc.tech !== sc.tech) continue;
        const score = this.level(i, u.x, u.y) + nc.cioDb;
        if (score > bestScore) {
          bestScore = score;
          bestN = i;
        }
      }
      if (bestN >= 0 && bestScore > servLvl + sc.cioDb + hp.a3OffsetDb + hp.hysteresisDb) {
        cand = bestN;
      } else if (servLvl < tth.b2ServingDbm) {
        // B2: serving weak, other RAT good enough
        const other = this.selectCell(best, lvl, sc.tech);
        if (other >= 0 && lvl[this.ctx.cells[other].tech] >= th[this.ctx.cells[other].tech].minRxDbm + 3) {
          cand = other;
          irat = true;
        }
      }
      if (cand >= 0) {
        if (cand === u.hoCand) u.hoTimerMs += dtMs;
        else {
          u.hoCand = cand;
          u.hoTimerMs = Math.min(u.hoTimerMs, 0) + dtMs; // keep back-off if any
        }
        if (u.hoTimerMs >= hp.tttMs) this.tryHandover(u, cand, irat);
      } else {
        u.hoCand = -1;
        u.hoTimerMs = Math.min(u.hoTimerMs + dtMs, 0);
      }
    }

    this.schedule();
    if (this.t >= this.nextSampleT) {
      this.sample();
      // Fixed 1 s cadence (t + 1 would drift with the step size).
      this.nextSampleT += 1;
      if (this.nextSampleT <= this.t) this.nextSampleT = this.t + 1;
    }
  }

  /** Idle-mode cell (re)selection, then refresh the UE's level and SINR. */
  private idleSelect(u: SimUser, best: Record<Tech, number>, lvl: Record<Tech, number>, servLvl: number) {
    const th = this.settings.thresholds;
    const pick = this.selectCell(best, lvl);
    if (pick < 0) {
      this.setServing(u, -1);
    } else if (u.serving < 0 || servLvl < th[this.ctx.cells[u.serving].tech].minRxDbm) {
      this.setServing(u, pick);
    } else if (pick !== u.serving) {
      const st = this.ctx.cells[u.serving].tech;
      const pt = this.ctx.cells[pick].tech;
      if (th[pt].priority > th[st].priority || lvl[pt] > servLvl + RESELECT_HYST_DB) this.setServing(u, pick);
    }
    u.rx = u.serving >= 0 ? this.level(u.serving, u.x, u.y) : -Infinity;
    u.sinr = u.serving >= 0 ? this.sinrAt(u.serving, u.x, u.y) : -Infinity;
  }

  private startSession(u: SimUser, kind: SessionKind) {
    const us = this.settings.users;
    const continuous = u.traffic === kind;
    const dur = continuous ? Infinity : this.expo(kind === 'voice' ? us.voiceMeanDurationS : us.dataMeanDurationS);
    const demand = kind === 'voice' ? VOICE_GBR_MBPS : (u.demandMbps ?? this.expo(us.dataMeanDemandMbps));
    if (kind === 'voice') this.counters.voiceStarted++;
    else this.counters.dataStarted++;
    if (u.wifiAp >= 0 && this.wifiCarries(kind)) {
      // Associated to Wi-Fi: the session goes over the AP (association already passed its admission).
      u.session = { kind, start: this.t, end: this.t + Math.max(dur, 2), demandMbps: demand };
      u.rlfTimerMs = 0;
      this.emit('CALL_START', u, `${kind === 'voice' ? 'voice call' : `data, demand ${demand.toFixed(2)} Mbps`} via Wi-Fi ${this.ctx.wifi[u.wifiAp].name}`);
      return;
    }
    if (u.serving < 0) {
      this.counters.blockedCoverage++;
      this.emit('BLOCK', u, `${kind} blocked: no coverage`);
      this.endSession(u, CONTINUOUS_RETRY_S.block);
      return;
    }
    if (!this.canAdmit(u.serving, kind, u)) {
      this.counters.blockedCapacity++;
      this.cells[u.serving].blocks++;
      this.emit('BLOCK', u, `${kind} blocked: ${this.ctx.cells[u.serving].tech === 'GSM' ? 'no free TCH' : 'admission control'}`, u.serving);
      this.endSession(u, CONTINUOUS_RETRY_S.block);
      return;
    }
    u.session = { kind, start: this.t, end: this.t + Math.max(dur, 2), demandMbps: demand };
    u.rlfTimerMs = 0;
    this.attach(u.serving);
    this.cells[u.serving].started++;
    this.emit('CALL_START', u, kind === 'voice' ? 'voice call' : `data, demand ${demand.toFixed(2)} Mbps`, u.serving);
  }

  // ---------------------------------------------------------------- manual control (inspector / drag)

  userById(id: number): SimUser | undefined {
    return this.users.find((u) => u.id === id);
  }

  opIndex(operatorId: string): number {
    return Math.max(0, this.scn.operators.findIndex((o) => o.id === operatorId));
  }

  /** Add a live user for a scenario user entry. */
  addUser(f: UserSpec): SimUser {
    const u = this.newUser(this.opIndex(f.operatorId), techMaskOf(f.techs), f.mobility);
    u.specId = f.id;
    u.name = f.name;
    u.wifiOn = f.wifi ?? this.wifiDefault(f.id);
    if (f.speedKmh != null && f.mobility !== 'static') {
      u.speed = f.speedKmh / 3.6;
      u.speedFixed = true;
    }
    u.traffic = f.traffic;
    u.demandMbps = f.demandMbps;
    u.ueRxOverride = f.ueRx ?? null;
    if (f.traffic === 'voice') u.nextVoice = this.t;
    if (f.traffic === 'data') u.nextData = this.t;
    this.users.push(u);
    this.moveUserTo(u, f.lat, f.lng, true);
    if (f.target) this.setTarget(u, f.target.lat, f.target.lng);
    return u;
  }

  userBySpec(specId: string): SimUser | undefined {
    return this.users.find((u) => u.specId === specId);
  }

  /** Remove the live users of these scenario entries. */
  removeUsersBySpec(ids: Set<string>) {
    this.users = this.users.filter((u) => !u.specId || !ids.has(u.specId));
    this.recountOccupancy();
    this.schedule();
  }

  /** Remove every user (sessions end, cells free up); KPI history is kept. */
  removeAllUsers() {
    this.users = [];
    this.recountOccupancy();
    this.schedule();
  }

  removeUser(id: number) {
    const u = this.userById(id);
    if (!u) return;
    this.detach(u);
    this.users = this.users.filter((x) => x !== u);
    this.recountOccupancy();
  }

  /**
   * Move a user to a position. While dragging (`final` false) it stays exactly under
   * the cursor; on drop, walking/driving users snap to the nearest road node and start
   * a new trip from there, static users stay where they were dropped.
   */
  moveUserTo(u: SimUser, lat: number, lng: number, final: boolean) {
    const p = this.proj.toXY(lat, lng);
    u.x = p.x;
    u.y = p.y;
    u.dragging = !final;
    if (final && u.mode !== 'static' && u.target) {
      // Moved by hand: head for the target again from here.
      this.routeToTarget(u);
    } else if (final && u.mode !== 'static') {
      const best = this.nearestNode(u, p.x, p.y);
      const g = this.graph;
      if (g && best >= 0) {
        u.x = g.x[best];
        u.y = g.y[best];
        u.path = [best];
        u.pathIdx = 1;
        u.dwellUntil = 0;
        this.newTrip(u);
      } else {
        const w = this.randomPointInArea();
        u.wx = w.x;
        u.wy = w.y;
      }
    }
    this.syncLatLng(u);
    this.refreshUser(u);
  }

  /** Nearest road node for this user's travel mode, −1 without a road graph. */
  private nearestNode(u: SimUser, x: number, y: number): number {
    const g = this.graph;
    const pool = g ? (this.effectiveMode(u) === 'walk' ? g.walk : g.drive).pool : null;
    if (!g || !pool || !pool.length) return -1;
    let best = pool[0];
    let bd = Infinity;
    for (const n of pool) {
      const d = (g.x[n] - x) ** 2 + (g.y[n] - y) ** 2;
      if (d < bd) [bd, best] = [d, n];
    }
    return best;
  }

  /**
   * Give a user a destination (null clears it and it goes back to random trips).
   * It walks/drives there along the roads, then stops until the target changes.
   */
  setTarget(u: SimUser, lat: number | null, lng = 0) {
    u.arrived = false;
    if (lat === null) {
      u.target = null;
      u.path = null;
      if (u.mode !== 'static') this.moveUserTo(u, u.lat, u.lng, true);
      return;
    }
    const p = this.proj.toXY(lat, lng);
    u.target = { x: p.x, y: p.y, lat, lng };
    this.routeToTarget(u);
  }

  /**
   * Route from the current position to the target: straight to the nearest road node,
   * along the shortest road path, then straight to the target point. Without roads
   * (or no road path) the user goes in a straight line.
   */
  private routeToTarget(u: SimUser) {
    const t = u.target!;
    u.arrived = false;
    u.dwellUntil = 0;
    u.path = null;
    u.wx = t.x;
    u.wy = t.y;
    const g = this.graph;
    const from = this.nearestNode(u, u.x, u.y);
    const to = this.nearestNode(u, t.x, t.y);
    if (g && from >= 0 && to >= 0) {
      const p = from === to ? [from] : route(g, this.effectiveMode(u), from, to);
      if (p && p.length) {
        u.path = p;
        u.pathIdx = 0;
      }
    }
  }

  /** Remaining distance to the target along the planned route, m (0 when arrived). */
  distanceToTarget(u: SimUser): number {
    if (!u.target || u.arrived) return 0;
    return this.remainingRoute(u).reduce((sum, p, i, a) => (i ? sum + Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) : 0), 0);
  }

  /** Planned route to the target from the current position, as lat/lng points. */
  targetRoute(u: SimUser): [number, number][] {
    if (!u.target || u.arrived) return [];
    return this.remainingRoute(u).map(([x, y]) => {
      const p = this.proj.toLatLng(x, y);
      return [p.lat, p.lng];
    });
  }

  private remainingRoute(u: SimUser): [number, number][] {
    const pts: [number, number][] = [[u.x, u.y]];
    const g = this.graph;
    if (g && u.path) for (let i = u.pathIdx; i < u.path.length; i++) pts.push([g.x[u.path[i]], g.y[u.path[i]]]);
    pts.push([u.target!.x, u.target!.y]);
    return pts;
  }

  setMobility(u: SimUser, mode: Mobility) {
    if (u.mode === mode) return;
    u.mode = mode;
    u.speed = this.randSpeed(mode);
    u.path = null;
    if (mode !== 'static') this.moveUserTo(u, u.lat, u.lng, true);
  }

  setTraffic(u: SimUser, traffic: TrafficMode) {
    u.traffic = traffic;
    if (u.session) {
      // A continuous session of another kind (or switching to random/idle) ends normally.
      const us = this.settings.users;
      if (traffic !== u.session.kind && u.session.end === Infinity) {
        u.session.end = traffic === 'random' ? this.t + this.expo(u.session.kind === 'voice' ? us.voiceMeanDurationS : us.dataMeanDurationS) : this.t;
      }
      if (traffic === u.session.kind) u.session.end = Infinity;
    }
    if (traffic === 'voice') u.nextVoice = this.t;
    if (traffic === 'data') u.nextData = this.t;
  }

  setOperator(u: SimUser, opIdx: number) {
    if (u.opIdx === opIdx) return;
    this.endSessionNow(u, 'operator changed', true);
    u.opIdx = opIdx;
    this.setServing(u, -1);
    this.refreshUser(u);
  }

  setTechMask(u: SimUser, mask: number) {
    u.techMask = mask || TECH_BIT.GSM;
    if (u.serving >= 0 && !(TECH_BIT[this.ctx.cells[u.serving].tech] & u.techMask)) {
      this.endSessionNow(u, 'RAT not supported', true);
      this.setServing(u, -1);
    }
    this.refreshUser(u);
  }

  startSessionNow(u: SimUser, kind: SessionKind) {
    if (u.session) this.endSessionNow(u, 'replaced', true);
    this.refreshUser(u);
    this.startSession(u, kind);
    this.schedule();
  }

  /**
   * End the UE's session now. Ending a continuous session by hand switches the UE to
   * random traffic (otherwise it would re-dial at once); `keepTraffic` keeps it continuous.
   */
  endSessionNow(u: SimUser, reason = 'ended manually', keepTraffic = false) {
    if (!u.session) return;
    this.emit('CALL_END', u, `${u.session.kind} ${reason}`, u.serving);
    this.detach(u);
    if (!keepTraffic && (u.traffic === 'voice' || u.traffic === 'data')) u.traffic = 'random';
    this.endSession(u, CONTINUOUS_RETRY_S.drop);
  }

  /** Re-measure one UE at its current position without advancing time (for drag / inspector). */
  refreshUser(u: SimUser) {
    this.stepId = (this.stepId + 1) >>> 0 || 1;
    const { best, lvl } = this.bestPerTech(u);
    const servLvl = u.serving >= 0 ? this.level(u.serving, u.x, u.y) : -Infinity;
    if (!u.session) this.idleSelect(u, best, lvl, servLvl);
    else if (u.serving >= 0) {
      u.rx = servLvl;
      u.sinr = this.sinrAt(u.serving, u.x, u.y);
    }
    if (this.settings.wifi.enabled && u.wifiOn && this.ctx.wifi.length) this.wifiMeasure(u);
    this.schedule();
  }

  /** The UE's measurements of every cell it may use, strongest first. */
  measurements(u: SimUser): { cell: number; level: number }[] {
    this.stepId = (this.stepId + 1) >>> 0 || 1;
    return this.candidateCells(u)
      .map((i) => ({ cell: i, level: this.level(i, u.x, u.y) }))
      .filter((m) => m.level > -Infinity)
      .sort((a, b) => b.level - a.level);
  }

  /**
   * Allocate one LTE/NR cell's RBs among its active users with scheduler `sched`.
   * Pure: reads the users' current SINR and demand, changes nothing, so it also
   * serves what-if comparisons on the same snapshot.
   */
  private allocateCell(i: number, sched: SchedulerKey, list: SimUser[], demandOverrideMbps?: number) {
    const r = this.settings.radio;
    const c = this.ctx.cells[i];
    const thr = new Float64Array(list.length);
    const rank = new Int8Array(list.length);
    let free = c.rbs;
    let gbr = 0;
    const data: { k: number; rate: number; need: number }[] = [];
    const voiceRates: number[] = [];
    const rbMbps = (c.rbBwHz * (1 - r.overhead)) / 1e6;
    list.forEach((u, k) => {
      const link = linkRank(c, u.sinr, this.ueRx(u), r);
      const rate = link.se * rbMbps;
      rank[k] = rate > 0 ? link.rank : 0;
      if (rate <= 0) return;
      if (u.session!.kind === 'voice') {
        const need = Math.min(VOICE_GBR_MBPS / rate, free);
        free -= need;
        gbr += need;
        thr[k] = need * rate;
        voiceRates.push(rate);
      } else data.push({ k, rate, need: (demandOverrideMbps ?? u.session!.demandMbps) / rate });
    });
    // Channel-aware schedulers (PF, Max C/I) serve users near their fading peaks,
    // raising the rate during their share (multi-user diversity, grows with users).
    if ((sched === 'pf' || sched === 'maxci') && data.length > 1) {
      const g = pfDiversityGainDb(data.length, r.pfDiversityEfficiency);
      for (const d of data) {
        const u = list[d.k];
        const boosted = linkRank(c, u.sinr + g, this.ueRx(u), r);
        d.rate = boosted.se * rbMbps;
        rank[d.k] = boosted.rank;
        d.need = (demandOverrideMbps ?? u.session!.demandMbps) / d.rate;
      }
    }
    // MU-MIMO: co-scheduled data users reuse the same RBs, so the data pool grows
    // by the pairing gain (in RB-equivalents); physical RB use is divided back.
    const mu = muMimoGain(c.maxMu, data.length, r.muMimoEfficiency);
    const pool = free * mu;
    const alloc = allocate(sched, data, pool);
    let remaining = pool;
    data.forEach((d, j) => {
      thr[d.k] = alloc[j] * d.rate;
      remaining -= alloc[j];
    });
    // Mean rate per RB over the users that can be served (after the PF/Max C/I boost).
    let rateSum = 0;
    let rateN = 0;
    for (const d of data) {
      rateSum += d.rate;
      rateN++;
    }
    for (const r0 of voiceRates) {
      rateSum += r0;
      rateN++;
    }
    return { thr, rank, usedRb: gbr + (pool - remaining) / mu, gbrRb: gbr, mu, meanRate: rateN ? rateSum / rateN : 0 };
  }

  /**
   * What-if on the current snapshot: the DL throughput every active LTE/NR data user
   * would get if all LTE/NR cells used each scheduler, with demand and per-cell
   * fairness. Same users, positions, SINR and demands for every scheduler. GSM users
   * are left out: they get a fixed GPRS timeslot whatever the scheduler.
   *
   * `fullBuffer`: every data user wants as much as it can get (standard scheduler
   * comparison). Otherwise uncongested cells serve every demand in full and all
   * schedulers coincide. Fairness is then Jain over throughput instead of satisfaction.
   */
  compareSchedulers(scheds: SchedulerKey[], fullBuffer = false, cells?: Set<number>): Record<string, { thr: number[]; fairness: number }> & { demand: number[] } {
    const C = this.ctx.cells.length;
    const perCell: SimUser[][] = Array.from({ length: C }, () => []);
    const demand: number[] = [];
    for (const u of this.users) {
      if (u.serving < 0 || !u.session || this.onWifi(u) || this.ctx.cells[u.serving].tech === 'GSM' || (cells && !cells.has(u.serving))) continue;
      perCell[u.serving].push(u);
      if (u.session.kind === 'data') demand.push(u.session.demandMbps);
    }
    const out: Record<string, { thr: number[]; fairness: number }> = {};
    for (const sched of scheds) {
      const thr: number[] = [];
      const satByCell = new Map<number, number[]>();
      for (let i = 0; i < C; i++) {
        const list = perCell[i];
        if (!list.length) continue;
        const a = this.allocateCell(i, sched, list, fullBuffer ? Infinity : undefined);
        list.forEach((u, k) => {
          if (u.session!.kind !== 'data') return;
          const t = a.thr[k];
          thr.push(t);
          const l = satByCell.get(i) ?? [];
          l.push(fullBuffer ? t : Math.min(1, t / Math.max(u.session!.demandMbps, 1e-9)));
          satByCell.set(i, l);
        });
      }
      out[sched] = { thr, fairness: meanCellFairness(satByCell) };
    }
    return Object.assign(out, { demand: fullBuffer ? [] : demand });
  }

  /** Resource allocation: GBR voice first, then max-min fair water-filling for data. */
  private schedule() {
    const r = this.settings.radio;
    const C = this.ctx.cells.length;
    const perCell: SimUser[][] = Array.from({ length: C }, () => []);
    for (const s of this.cells) s.camped = 0;
    for (const u of this.users) {
      if (u.serving < 0) continue;
      this.cells[u.serving].camped++;
      if (u.session && !this.onWifi(u)) perCell[u.serving].push(u);
    }
    for (let i = 0; i < C; i++) {
      const c = this.ctx.cells[i];
      const st = this.cells[i];
      const list = perCell[i];
      if (c.tech === 'GSM') {
        for (const u of list) {
          u.thrMbps = u.session!.kind === 'data' ? GSM_SLOT_MBPS : 0;
          u.rank = 1;
        }
        st.load = c.tch > 0 ? Math.min(1, list.length / c.tch) : 0;
        st.usedRb = 0;
        st.gbrRb = 0;
        st.servedMbps = list.reduce((a, u) => a + u.thrMbps, 0);
        st.demandMbps = list.reduce((a, u) => a + (u.session!.kind === 'data' ? u.session!.demandMbps : 0), 0);
        st.capacityMbps = c.tch * GSM_SLOT_MBPS;
        // BCCH carrier always radiates at full power.
        this.loads[i] = 1;
        continue;
      }
      const sched = this.cellScheduler(i);
      st.scheduler = sched;
      const a = this.allocateCell(i, sched, list);
      list.forEach((u, k) => {
        u.thrMbps = a.thr[k];
        u.rank = a.rank[k];
      });
      st.muGain = a.mu;
      st.usedRb = a.usedRb;
      st.gbrRb = a.gbrRb;
      st.load = c.rbs > 0 ? st.usedRb / c.rbs : 0;
      st.servedMbps = a.thr.reduce((x, y) => x + y, 0);
      st.demandMbps = list.reduce((x, u) => x + (u.session!.kind === 'data' ? u.session!.demandMbps : VOICE_GBR_MBPS), 0);
      const rate = a.meanRate > 0 ? a.meanRate : ratePerRbMbps(c, 10, r, 2);
      st.capacityMbps = c.rbs * rate * a.mu;
      this.loads[i] = r.interferenceLoad === 'full' ? 1 : Math.max(r.minInterfererLoad, st.load);
    }
    this.scheduleWifi();
  }

  /** Append one CellSample per cell to its history. */
  private sampleCells() {
    const C = this.ctx.cells.length;
    const sinrSum = new Float64Array(C);
    const sinrN = new Uint32Array(C);
    const voice = new Uint32Array(C);
    const data = new Uint32Array(C);
    const thr: number[][] = Array.from({ length: C }, () => []);
    for (const u of this.users) {
      const i = u.serving;
      if (i < 0) continue;
      if (Number.isFinite(u.sinr)) {
        sinrSum[i] += u.sinr;
        sinrN[i]++;
      }
      if (this.onWifi(u)) continue;
      if (u.session?.kind === 'voice') voice[i]++;
      else if (u.session?.kind === 'data') {
        data[i]++;
        thr[i].push(u.thrMbps);
      }
    }
    for (let i = 0; i < C; i++) {
      const c = this.ctx.cells[i];
      const st = this.cells[i];
      const t = thr[i].sort((a, b) => a - b);
      let h = this.cellHistory.get(c.sectorId);
      if (!h) this.cellHistory.set(c.sectorId, (h = []));
      h.push({
        t: this.t,
        voice: voice[i],
        data: data[i],
        camped: st.camped,
        servedMbps: st.servedMbps,
        demandMbps: st.demandMbps,
        capacityMbps: st.capacityMbps,
        load: st.load,
        resources: c.tech === 'GSM' ? c.tch : c.rbs,
        meanSinrDb: sinrN[i] ? sinrSum[i] / sinrN[i] : NaN,
        meanThrMbps: t.length ? t.reduce((a, b) => a + b, 0) / t.length : 0,
        p5ThrMbps: percentile(t, 0.05),
      });
      if (h.length > CELL_HISTORY_S) h.shift();
    }
  }

  private sample() {
    let voice = 0;
    let data = 0;
    let covered = 0;
    let sinrSum = 0;
    let sinrN = 0;
    const thr: number[] = [];
    const satByCell = new Map<number, number[]>();
    const byTech = { GSM: 0, LTE: 0, NR: 0 };
    for (const u of this.users) {
      if (u.serving >= 0) {
        covered++;
        byTech[this.ctx.cells[u.serving].tech]++;
        if (Number.isFinite(u.sinr)) {
          sinrSum += u.sinr;
          sinrN++;
        }
      }
      if (u.session?.kind === 'voice') voice++;
      if (u.session?.kind === 'data') {
        data++;
        thr.push(u.thrMbps);
        if (u.serving >= 0 && !this.onWifi(u)) {
          const l = satByCell.get(u.serving) ?? [];
          l.push(Math.min(1, u.thrMbps / Math.max(u.session.demandMbps, 1e-9)));
          satByCell.set(u.serving, l);
        }
      }
    }
    thr.sort((a, b) => a - b);
    let served = 0;
    let demand = 0;
    let capacity = 0;
    let usedRb = 0;
    let rbs = 0;
    this.cells.forEach((st, i) => {
      served += st.servedMbps;
      demand += st.demandMbps;
      capacity += st.capacityMbps;
      if (this.ctx.cells[i].tech !== 'GSM') {
        usedRb += st.usedRb;
        rbs += this.ctx.cells[i].rbs;
      }
    });
    let wifiUsers = 0;
    let wifiSessions = 0;
    for (const u of this.users) {
      if (u.wifiAp < 0) continue;
      wifiUsers++;
      if (this.onWifi(u)) wifiSessions++;
    }
    this.sampleCells();
    this.samples.push({
      t: this.t,
      activeVoice: voice,
      activeData: data,
      coverage: this.users.length ? covered / this.users.length : 0,
      meanThrMbps: thr.length ? thr.reduce((a, b) => a + b, 0) / thr.length : 0,
      p5ThrMbps: percentile(thr, 0.05),
      meanSinrDb: sinrN ? sinrSum / sinrN : 0,
      fairness: meanCellFairness(satByCell),
      byTech,
      servedMbps: served,
      demandMbps: demand,
      capacityMbps: capacity,
      prbUtil: rbs ? usedRb / rbs : 0,
      wifiUsers,
      wifiSessions,
      wifiServedMbps: this.aps.reduce((a, s) => a + s.servedMbps, 0),
      wifiCapacityMbps: this.aps.reduce((a, s) => a + s.capacityMbps, 0),
    });
    if (this.samples.length > 3600) this.samples.shift();
  }
}
