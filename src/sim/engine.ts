import { LocalProjection } from '../geo';
import { GSM_SLOT_MBPS, ratePerRbMbps, rxLevel, sinrDb, type RadioContext } from '../radio/cells';
import type { FixedUser, Mobility, Scenario, Settings, Tech, TrafficMode } from '../types';
import { EventLog, emptyCounters, percentile, type KpiCounters, type KpiSample, type SimEventType } from './kpi';
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
  /** Set for users placed manually and persisted in the scenario. */
  fixedId: string | null;
  name: string | null;
  opIdx: number;
  techMask: number;
  mode: Mobility;
  traffic: TrafficMode;
  /** Fixed data demand, Mbps; null = random per session. */
  demandMbps: number | null;
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
  /** Random-waypoint target when no road graph is loaded. */
  wx: number;
  wy: number;
  serving: number;
  servingKey: string | null;
  rx: number;
  sinr: number;
  thrMbps: number;
  hoCand: number;
  hoTimerMs: number;
  rlfTimerMs: number;
  session: Session | null;
  nextVoice: number;
  nextData: number;
  prevCellKey: string | null;
  lastHoT: number;
}

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
  hoIn: number;
  hoOut: number;
  drops: number;
  blocks: number;
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
  /** Interference load factor per cell, consumed by SINR computation. */
  loads = new Float32Array(0);
  t = 0;
  counters: KpiCounters = emptyCounters();
  samples: KpiSample[] = [];
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
    this.opShares = scn.operators.map((o) => Math.max(0, o.marketShare));
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
    this.cells = ctx.cells.map(() => ({ active: 0, camped: 0, usedRb: 0, gbrRb: 0, tchUsed: 0, load: 0, hoIn: 0, hoOut: 0, drops: 0, blocks: 0 }));
    this.loads = new Float32Array(C).fill(this.initialLoad());
    if (old) {
      old.cells.forEach((_, i) => {
        const ni = keyToNew.get(cellKey(old, i));
        if (ni === undefined) return;
        if (prevLoads[i] !== undefined) this.loads[ni] = prevLoads[i];
        const pc = prevCells[i];
        if (pc) Object.assign(this.cells[ni], { hoIn: pc.hoIn, hoOut: pc.hoOut, drops: pc.drops, blocks: pc.blocks });
      });
    }
    for (const u of this.users) {
      const ni = u.servingKey ? keyToNew.get(u.servingKey) : undefined;
      u.serving = ni ?? -1;
      if (ni === undefined) u.servingKey = null;
      u.hoCand = -1;
      u.hoTimerMs = 0;
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
    this.log.clear();
    this.nextSampleT = 0;
    this.rng = mulberry32(this.settings.sim.seed);
    for (const c of this.cells) Object.assign(c, { active: 0, camped: 0, usedRb: 0, gbrRb: 0, tchUsed: 0, load: 0, hoIn: 0, hoOut: 0, drops: 0, blocks: 0 });
    this.loads.fill(this.initialLoad());
    this.spawnUsers();
  }

  // ---------------------------------------------------------------- users

  private pickOperator(): number {
    const ops = this.opShares;
    const total = ops.reduce((a, b) => a + b, 0) || 1;
    let r = this.rng() * total;
    for (let i = 0; i < ops.length; i++) if ((r -= ops[i]) < 0) return i;
    return 0;
  }

  opShares: number[] = [1];

  private nextUserId = 0;

  spawnUsers() {
    const us = this.settings.users;
    this.users = [];
    this.nextUserId = 0;
    for (let k = 0; k < us.count; k++) {
      const mode: Mobility = this.rng() < us.staticShare ? 'static' : this.rng() < us.pedestrianShare ? 'walk' : 'drive';
      let techMask = TECH_BIT.GSM;
      const r = this.rng();
      if (r < us.lteCapableShare) techMask |= TECH_BIT.LTE;
      if (r < us.nrCapableShare) techMask |= TECH_BIT.NR;
      const u = this.newUser(this.pickOperator(), techMask, mode);
      this.placeAtRandom(u);
      this.users.push(u);
    }
    for (const f of this.scn.fixedUsers ?? []) this.addFixedUser(f);
    this.recountOccupancy();
  }

  private newUser(opIdx: number, techMask: number, mode: Mobility): SimUser {
    const us = this.settings.users;
    return {
        id: this.nextUserId++,
        fixedId: null,
        name: null,
        opIdx,
        techMask,
        mode,
        traffic: 'random',
        demandMbps: null,
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
        serving: -1,
        servingKey: null,
        rx: -Infinity,
        sinr: -Infinity,
        thrMbps: 0,
        hoCand: -1,
        hoTimerMs: 0,
        rlfTimerMs: 0,
        session: null,
        nextVoice: this.expo(3600 / Math.max(us.voiceCallsPerHour, 1e-6)),
        nextData: this.expo(3600 / Math.max(us.dataSessionsPerHour, 1e-6)),
        prevCellKey: null,
        lastHoT: -1e9,
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
        // Fixed users keep the speed they were given.
        if (!u.fixedId) u.speed = this.randSpeed(u.mode);
        return;
      }
    }
    // Stuck (e.g. one-way dead end): teleport to a fresh node.
    this.placeAtRandom(u);
  }

  private move(u: SimUser, dt: number) {
    if (u.mode === 'static' || u.dragging || this.t < u.dwellUntil) return;
    let dist = u.speed * dt;
    const g = this.graph;
    if (g && u.path) {
      while (dist > 0) {
        if (u.pathIdx >= u.path.length) {
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

  private canAdmit(i: number, kind: SessionKind, u: SimUser): boolean {
    const c = this.ctx.cells[i];
    const s = this.cells[i];
    if (s.active >= c.maxUsers) return false;
    if (c.tech === 'GSM') return s.tchUsed < c.tch;
    if (kind === 'voice') {
      const r = ratePerRbMbps(c, u.sinr, this.settings.radio);
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
    if (u.serving < 0 || !u.session) return;
    const s = this.cells[u.serving];
    s.active = Math.max(0, s.active - 1);
    if (this.ctx.cells[u.serving].tech === 'GSM') s.tchUsed = Math.max(0, s.tchUsed - 1);
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
      if (u.session) this.attach(u.serving);
    }
  }

  // ---------------------------------------------------------------- events

  private emit(type: SimEventType, u: SimUser, detail: string, from?: number, to?: number) {
    this.log.push({
      t: this.t,
      type,
      userId: u.id,
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
        this.emit('CALL_END', u, `${u.session.kind} completed`, u.serving);
        this.detach(u);
        this.endSession(u);
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

      // A3: neighbour (same RAT) better than serving + offset + hysteresis for TTT
      let cand = -1;
      let irat = false;
      const b = best[sc.tech];
      if (b >= 0 && b !== u.serving && lvl[sc.tech] > servLvl + tth.a3OffsetDb + tth.hysteresisDb) {
        cand = b;
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
        if (u.hoTimerMs >= tth.tttMs) this.tryHandover(u, cand, irat);
      } else {
        u.hoCand = -1;
        u.hoTimerMs = Math.min(u.hoTimerMs + dtMs, 0);
      }
    }

    this.schedule();
    if (this.t >= this.nextSampleT) {
      this.sample();
      this.nextSampleT = this.t + 1;
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
    this.emit('CALL_START', u, kind === 'voice' ? 'voice call' : `data, demand ${demand.toFixed(2)} Mbps`, u.serving);
  }

  // ---------------------------------------------------------------- manual control (inspector / drag)

  userById(id: number): SimUser | undefined {
    return this.users.find((u) => u.id === id);
  }

  opIndex(operatorId: string): number {
    return Math.max(0, this.scn.operators.findIndex((o) => o.id === operatorId));
  }

  /** Add a manually placed user (from the scenario's fixed users). */
  addFixedUser(f: FixedUser): SimUser {
    const u = this.newUser(this.opIndex(f.operatorId), techMaskOf(f.techs), f.mobility);
    u.fixedId = f.id;
    u.name = f.name;
    u.traffic = f.traffic;
    u.demandMbps = f.demandMbps;
    if (f.traffic === 'voice') u.nextVoice = this.t;
    if (f.traffic === 'data') u.nextData = this.t;
    this.users.push(u);
    this.moveUserTo(u, f.lat, f.lng, true);
    return u;
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
    if (final && u.mode !== 'static') {
      const g = this.graph;
      const pool = g ? (this.effectiveMode(u) === 'walk' ? g.walk : g.drive).pool : null;
      if (g && pool && pool.length) {
        let best = pool[0];
        let bd = Infinity;
        for (const n of pool) {
          const d = (g.x[n] - p.x) ** 2 + (g.y[n] - p.y) ** 2;
          if (d < bd) [bd, best] = [d, n];
        }
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

  /** Resource allocation: GBR voice first, then max-min fair water-filling for data. */
  private schedule() {
    const r = this.settings.radio;
    const C = this.ctx.cells.length;
    const perCell: SimUser[][] = Array.from({ length: C }, () => []);
    for (const s of this.cells) s.camped = 0;
    for (const u of this.users) {
      if (u.serving < 0) continue;
      this.cells[u.serving].camped++;
      if (u.session) perCell[u.serving].push(u);
    }
    for (let i = 0; i < C; i++) {
      const c = this.ctx.cells[i];
      const st = this.cells[i];
      const list = perCell[i];
      if (c.tech === 'GSM') {
        for (const u of list) u.thrMbps = u.session!.kind === 'data' ? GSM_SLOT_MBPS : 0;
        st.load = c.tch > 0 ? Math.min(1, list.length / c.tch) : 0;
        st.usedRb = 0;
        st.gbrRb = 0;
        // BCCH carrier always radiates at full power.
        this.loads[i] = 1;
        continue;
      }
      let free = c.rbs;
      let gbr = 0;
      const data: { u: SimUser; rate: number; need: number }[] = [];
      for (const u of list) {
        const rate = ratePerRbMbps(c, u.sinr, r);
        if (rate <= 0) {
          u.thrMbps = 0;
          continue;
        }
        if (u.session!.kind === 'voice') {
          const need = Math.min(VOICE_GBR_MBPS / rate, free);
          free -= need;
          gbr += need;
          u.thrMbps = need * rate;
        } else {
          data.push({ u, rate, need: u.session!.demandMbps / rate });
        }
      }
      // Water-filling: equal RB share, capped by each user's need.
      data.sort((a, b) => a.need - b.need);
      let remaining = free;
      for (let k = 0; k < data.length; k++) {
        const share = remaining / (data.length - k);
        const alloc = Math.min(share, data[k].need);
        data[k].u.thrMbps = alloc * data[k].rate;
        remaining -= alloc;
      }
      st.usedRb = c.rbs - remaining;
      st.gbrRb = gbr;
      st.load = c.rbs > 0 ? st.usedRb / c.rbs : 0;
      this.loads[i] = r.interferenceLoad === 'full' ? 1 : Math.max(r.minInterfererLoad, st.load);
    }
  }

  private sample() {
    let voice = 0;
    let data = 0;
    let covered = 0;
    let sinrSum = 0;
    let sinrN = 0;
    const thr: number[] = [];
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
      }
    }
    thr.sort((a, b) => a - b);
    this.samples.push({
      t: this.t,
      activeVoice: voice,
      activeData: data,
      coverage: this.users.length ? covered / this.users.length : 0,
      meanThrMbps: thr.length ? thr.reduce((a, b) => a + b, 0) / thr.length : 0,
      p5ThrMbps: percentile(thr, 0.05),
      meanSinrDb: sinrN ? sinrSum / sinrN : 0,
      byTech,
    });
    if (this.samples.length > 3600) this.samples.shift();
  }
}
