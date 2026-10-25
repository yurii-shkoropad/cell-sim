import { destination, haversineM } from '../geo';
import { newId } from '../radio/presets';
import type { Mobility, Scenario, Tech, TrafficMode, UserSpec } from '../types';

/** Small, fast, seedable PRNG. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Zone =
  | { kind: 'rect'; south: number; west: number; north: number; east: number }
  | { kind: 'circle'; lat: number; lng: number; radiusM: number };

/** What batch-added users look like. Shares are 0..1; null = per-user random / default. */
export interface UserTemplate {
  count: number;
  /** 'all' = by operators' market share, else an operator id. */
  operator: string;
  staticShare: number;
  /** Share of the moving users that walk (the rest drive). */
  pedestrianShare: number;
  nrShare: number;
  lteShare: number;
  traffic: TrafficMode;
  demandMbps: number | null;
  ueRx: number | null;
}

/** Template from the scenario's population settings (what "Add users" starts with). */
export function templateFromSettings(scn: Scenario): UserTemplate {
  const u = scn.settings.users;
  return {
    count: u.count,
    operator: u.operatorFilter || 'all',
    staticShare: u.staticShare,
    pedestrianShare: u.pedestrianShare,
    nrShare: u.nrCapableShare,
    lteShare: u.lteCapableShare,
    traffic: 'random',
    demandMbps: null,
    ueRx: null,
  };
}

function randomPoint(z: Zone, rnd: () => number): { lat: number; lng: number } {
  if (z.kind === 'rect') return { lat: z.south + rnd() * (z.north - z.south), lng: z.west + rnd() * (z.east - z.west) };
  // Uniform over the disc: sqrt for the radius.
  return destination(z.lat, z.lng, rnd() * 360, Math.sqrt(rnd()) * z.radiusM);
}

export function zoneContains(z: Zone, lat: number, lng: number): boolean {
  if (z.kind === 'rect') return lat >= z.south && lat <= z.north && lng >= z.west && lng <= z.east;
  return haversineM(z.lat, z.lng, lat, lng) <= z.radiusM;
}

/** Next free "UE-n" number so batch names don't collide with existing users. */
function nextUeNumber(scn: Scenario): number {
  let max = 0;
  for (const u of scn.users ?? []) {
    const m = /^UE-(\d+)$/.exec(u.name);
    if (m) max = Math.max(max, +m[1]);
  }
  return max + 1;
}

/** Create `tpl.count` users at random positions in `zone` (moving users snap to roads when spawned). */
export function generateUsers(scn: Scenario, tpl: UserTemplate, zone: Zone, rnd: () => number = Math.random, count = tpl.count): UserSpec[] {
  const ops = scn.operators;
  const shares = ops.map((o) => Math.max(0, o.marketShare));
  const total = shares.reduce((a, b) => a + b, 0) || 1;
  const pickOp = () => {
    if (tpl.operator !== 'all' && ops.some((o) => o.id === tpl.operator)) return tpl.operator;
    let r = rnd() * total;
    for (let i = 0; i < ops.length; i++) if ((r -= shares[i]) < 0) return ops[i].id;
    return ops[0]?.id ?? '';
  };
  let n = nextUeNumber(scn);
  const out: UserSpec[] = [];
  for (let k = 0; k < count; k++) {
    const mobility: Mobility = rnd() < tpl.staticShare ? 'static' : rnd() < tpl.pedestrianShare ? 'walk' : 'drive';
    const r = rnd();
    const techs: Tech[] = ['GSM'];
    if (r < tpl.lteShare) techs.push('LTE');
    if (r < tpl.nrShare) techs.push('NR');
    const p = randomPoint(zone, rnd);
    out.push({ id: newId('u'), name: `UE-${n++}`, lat: p.lat, lng: p.lng, operatorId: pickOp(), techs, mobility, traffic: tpl.traffic, demandMbps: tpl.demandMbps, ueRx: tpl.ueRx });
  }
  return out;
}

/** Zone covering the demo / default area around a centre. */
export const areaAround = (lat: number, lng: number): Zone => ({ kind: 'rect', south: lat - 0.01, north: lat + 0.01, west: lng - 0.015, east: lng + 0.015 });
