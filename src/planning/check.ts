import { bearingDeg, haversineM, wrap180 } from '../geo';
import { occupiedBandwidthMHz } from '../radio/presets';
import { validity } from '../radio/propagation';
import type { BaseStation, Scenario, Sector, Tech } from '../types';

export type Severity = 'error' | 'warning' | 'info';

export interface PlanIssue {
  severity: Severity;
  kind: string;
  message: string;
  stationIds: string[];
}

interface FlatCell {
  bs: BaseStation;
  s: Sector;
  si: number;
  name: string;
  fLo: number;
  fHi: number;
}

const PCI_MAX: Record<Tech, number> = { GSM: 63, LTE: 503, NR: 1007 };

function flatten(scn: Scenario): FlatCell[] {
  const out: FlatCell[] = [];
  for (const bs of scn.stations) {
    if (!bs.enabled) continue;
    bs.sectors.forEach((s, si) => {
      if (!s.enabled) return;
      const occ = occupiedBandwidthMHz(bs.tech, bs.bandwidthMHz, s.freqMHz);
      out.push({ bs, s, si, name: `${bs.name}-${si + 1}`, fLo: s.freqMHz - occ / 2, fHi: s.freqMHz + occ / 2 });
    });
  }
  return out;
}

const coChannel = (a: FlatCell, b: FlatCell) => Math.min(a.fHi, b.fHi) - Math.max(a.fLo, b.fLo) > 1e-6;
const dist = (a: FlatCell, b: FlatCell) => haversineM(a.bs.lat, a.bs.lng, b.bs.lat, b.bs.lng);

/** True when each antenna points roughly towards the other site. */
function facing(a: FlatCell, b: FlatCell): boolean {
  if (a.bs.id === b.bs.id) return true;
  const k = Math.cos((a.bs.lat * Math.PI) / 180);
  const ab = bearingDeg(0, 0, (b.bs.lng - a.bs.lng) * k, b.bs.lat - a.bs.lat);
  const ba = (ab + 180) % 360;
  const aw = a.s.hBeamwidth >= 360 ? 180 : 60;
  const bw = b.s.hBeamwidth >= 360 ? 180 : 60;
  return Math.abs(wrap180(a.s.azimuth - ab)) <= aw && Math.abs(wrap180(b.s.azimuth - ba)) <= bw;
}

export function checkPlan(scn: Scenario): PlanIssue[] {
  const R = scn.settings.sim.neighbourRadiusM;
  const cells = flatten(scn);
  const issues: PlanIssue[] = [];
  const ops = new Map(scn.operators.map((o) => [o.id, o.name]));

  // Range checks and model validity
  for (const bs of scn.stations) {
    bs.sectors.forEach((s, si) => {
      if (s.pci < 0 || s.pci > PCI_MAX[bs.tech] || !Number.isInteger(s.pci)) {
        issues.push({ severity: 'error', kind: bs.tech === 'GSM' ? 'BSIC range' : 'PCI range', message: `${bs.name}-${si + 1}: ${bs.tech === 'GSM' ? 'BSIC' : 'PCI'} ${s.pci} outside 0..${PCI_MAX[bs.tech]}`, stationIds: [bs.id] });
      }
    });
    const f = bs.sectors[0]?.freqMHz ?? 0;
    for (const v of validity(f, bs.heightM, scn.settings.radio.ueHeightM, scn.settings.radio.model)) {
      issues.push({ severity: 'info', kind: 'Model validity', message: `${bs.name}: ${v.message}`, stationIds: [bs.id] });
    }
  }

  for (let i = 0; i < cells.length; i++) {
    const a = cells[i];
    const neighbours: FlatCell[] = [];
    for (let j = 0; j < cells.length; j++) {
      if (i === j) continue;
      const b = cells[j];
      if (!coChannel(a, b)) continue;
      const d = dist(a, b);
      if (d <= R) neighbours.push(b);
      if (j < i) continue; // pairwise checks once per pair

      if (a.bs.operatorId !== b.bs.operatorId && d <= R) {
        issues.push({ severity: 'warning', kind: 'Inter-operator overlap', message: `${a.name} (${ops.get(a.bs.operatorId)}) and ${b.name} (${ops.get(b.bs.operatorId)}) share spectrum around ${a.s.freqMHz} MHz, ${d.toFixed(0)} m apart`, stationIds: [a.bs.id, b.bs.id] });
        continue;
      }
      if (a.bs.tech === 'GSM' && b.bs.tech === 'GSM') {
        if (d <= R) {
          const sameBsic = a.s.pci === b.s.pci;
          issues.push({
            severity: sameBsic ? 'error' : a.bs.id === b.bs.id ? 'error' : 'warning',
            kind: sameBsic ? 'BCCH+BSIC clash' : 'Co-channel BCCH',
            message: `${a.name} and ${b.name} both on ${a.s.freqMHz} MHz${sameBsic ? ` with BSIC ${a.s.pci}` : ''}, ${d.toFixed(0)} m apart`,
            stationIds: [a.bs.id, b.bs.id],
          });
        }
        continue;
      }
      if (a.bs.tech !== b.bs.tech) continue;
      if (a.s.pci === b.s.pci && d <= R) {
        issues.push({ severity: 'error', kind: 'PCI collision', message: `${a.name} and ${b.name} share PCI ${a.s.pci} on overlapping carriers, ${d.toFixed(0)} m apart`, stationIds: [a.bs.id, b.bs.id] });
      } else if (a.s.pci % 3 === b.s.pci % 3 && d <= R / 2 && facing(a, b)) {
        issues.push({ severity: a.bs.id === b.bs.id ? 'warning' : 'info', kind: 'PCI mod 3', message: `${a.name} (PCI ${a.s.pci}) and ${b.name} (PCI ${b.s.pci}) have the same PCI mod 3 (reference-signal shift) and face each other`, stationIds: [a.bs.id, b.bs.id] });
      }
    }
    // Confusion: two neighbours of `a` with the same PCI.
    if (a.bs.tech !== 'GSM') {
      const byPci = new Map<number, FlatCell[]>();
      for (const n of neighbours) {
        if (n.bs.tech !== a.bs.tech || n.bs.operatorId !== a.bs.operatorId) continue;
        const l = byPci.get(n.s.pci) ?? [];
        l.push(n);
        byPci.set(n.s.pci, l);
      }
      for (const [pci, l] of byPci) {
        if (l.length > 1) issues.push({ severity: 'warning', kind: 'PCI confusion', message: `${a.name} has ${l.length} neighbours with PCI ${pci}: ${l.map((x) => x.name).join(', ')}`, stationIds: [a.bs.id, ...l.map((x) => x.bs.id)] });
      }
    }
  }

  // GSM adjacent channels on the same site
  for (const bs of scn.stations) {
    if (bs.tech !== 'GSM') continue;
    for (let i = 0; i < bs.sectors.length; i++)
      for (let j = i + 1; j < bs.sectors.length; j++)
        if (Math.abs(Math.abs(bs.sectors[i].freqMHz - bs.sectors[j].freqMHz) - 0.2) < 1e-3)
          issues.push({ severity: 'warning', kind: 'Adjacent channel', message: `${bs.name}: sectors ${i + 1} and ${j + 1} on adjacent GSM channels`, stationIds: [bs.id] });
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * Greedy PCI planning for LTE/NR: each site gets a group g and its sectors
 * PCI = 3g + sectorIndex (distinct mod 3 on a site), choosing the smallest g
 * not used by any co-channel cell of the same RAT within the neighbour radius.
 */
export function autoAssignPci(scn: Scenario, operatorId: string | 'all'): number {
  const R = scn.settings.sim.neighbourRadiusM;
  let changed = 0;
  for (const tech of ['LTE', 'NR'] as Tech[]) {
    const sites = scn.stations.filter((b) => b.tech === tech && (operatorId === 'all' || b.operatorId === operatorId));
    const groups = tech === 'LTE' ? 168 : 336;
    const assigned: BaseStation[] = [];
    for (const bs of sites) {
      const near = assigned.filter((o) => haversineM(bs.lat, bs.lng, o.lat, o.lng) <= 2 * R);
      const used = new Set<number>();
      for (const o of near)
        for (const s of o.sectors)
          if (bs.sectors.some((t) => Math.abs(t.freqMHz - s.freqMHz) < (bs.bandwidthMHz + o.bandwidthMHz) / 2)) used.add(Math.floor(s.pci / 3));
      let g = 0;
      while (used.has(g) && g < groups - 1) g++;
      bs.sectors.forEach((s, i) => {
        const pci = 3 * g + (i % 3);
        if (s.pci !== pci) changed++;
        s.pci = pci;
      });
      assigned.push(bs);
    }
  }
  return changed;
}

/**
 * Greedy GSM BCCH frequency plan. Each sector picks the channel from the list
 * minimising sum(1/d²) over co-channel (and 1/60·1/d² adjacent) already-planned sectors.
 */
export function autoAssignGsm(scn: Scenario, operatorId: string | 'all', firstFreqMHz: number, channels: number): number {
  const list = Array.from({ length: channels }, (_, k) => +(firstFreqMHz + 0.2 * k).toFixed(1));
  const sites = scn.stations.filter((b) => b.tech === 'GSM' && (operatorId === 'all' || b.operatorId === operatorId));
  const planned: { lat: number; lng: number; f: number; siteId: string }[] = [];
  let changed = 0;
  for (const bs of sites) {
    for (const s of bs.sectors) {
      let best = list[0];
      let bestCost = Infinity;
      for (const f of list) {
        let cost = 0;
        for (const p of planned) {
          const d = Math.max(haversineM(bs.lat, bs.lng, p.lat, p.lng), 50);
          const df = Math.abs(p.f - f);
          if (df < 1e-3) cost += p.siteId === bs.id ? 1e6 : 1 / (d * d);
          else if (Math.abs(df - 0.2) < 1e-3) cost += p.siteId === bs.id ? 1e5 : 1 / (60 * d * d);
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = f;
        }
      }
      if (s.freqMHz !== best) changed++;
      s.freqMHz = best;
      planned.push({ lat: bs.lat, lng: bs.lng, f: best, siteId: bs.id });
    }
  }
  return changed;
}
