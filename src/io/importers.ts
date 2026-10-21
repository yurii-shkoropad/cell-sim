import { bearingDeg, haversineM, LocalProjection } from '../geo';
import { cellColor } from '../radio/cells';
import { makeStation, newId, type StationPreset } from '../radio/presets';
import { fetchOverpass, type Bounds } from '../sim/roads';
import type { BaseStation, Operator, Scenario, Tech } from '../types';

export interface ImportResult {
  stations: BaseStation[];
  newOperators: Operator[];
  skipped: Record<string, number>;
}

const inBounds = (b: Bounds, lat: number, lng: number) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;

function operatorFor(scn: Scenario, created: Operator[], plmn: string, name?: string): Operator {
  const all = [...scn.operators, ...created];
  let op = all.find((o) => o.plmn === plmn) ?? (name ? all.find((o) => o.name.toLowerCase() === name.toLowerCase()) : undefined);
  if (!op && name) {
    const n = name.toLowerCase();
    op = all.find((o) => n.includes(o.name.toLowerCase()) || o.name.toLowerCase().includes(n));
  }
  if (!op) {
    op = { id: newId('op'), name: name || `PLMN ${plmn}`, plmn, color: cellColor(all.length + 7), marketShare: 0 };
    created.push(op);
  }
  return op;
}

interface CsvCell {
  radio: string;
  mcc: string;
  net: string;
  area: string;
  cell: number;
  lat: number;
  lng: number;
}

/**
 * OpenCelliD CSV (radio,mcc,net,area,cell,unit,lon,lat,range,...), with or without header.
 * Cell positions in OpenCelliD are estimates from crowd-sourced measurements, so
 * cells are grouped into sites (LTE by eNB id, NR by gNB id, GSM by proximity),
 * the site is placed at the centroid, and sector azimuths point at each cell's estimate.
 */
export function importOpenCellId(text: string, scn: Scenario, bounds: Bounds, presets: Record<Tech, StationPreset>, maxSites = 400): ImportResult {
  const skipped: Record<string, number> = {};
  const skip = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1);
  const rows: CsvCell[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('radio')) continue;
    const f = line.split(',');
    if (f.length < 8) {
      skip('malformed');
      continue;
    }
    const radio = f[0].trim().toUpperCase();
    const lng = parseFloat(f[6]);
    const lat = parseFloat(f[7]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      skip('malformed');
      continue;
    }
    if (!inBounds(bounds, lat, lng)) {
      skip('outside view');
      continue;
    }
    if (radio !== 'GSM' && radio !== 'LTE' && radio !== 'NR') {
      skip(`${radio} (not modelled)`);
      continue;
    }
    rows.push({ radio, mcc: f[1].trim(), net: f[2].trim(), area: f[3].trim(), cell: Number(f[4]), lat, lng });
  }

  // Group into sites
  const groups = new Map<string, CsvCell[]>();
  const gsmClusters: { key: string; lat: number; lng: number }[] = [];
  for (const r of rows) {
    let key: string;
    if (r.radio === 'LTE') key = `L|${r.mcc}|${r.net}|${Math.floor(r.cell / 256)}`;
    else if (r.radio === 'NR') key = `N|${r.mcc}|${r.net}|${Math.floor(r.cell / 4096)}`;
    else {
      const prefix = `G|${r.mcc}|${r.net}|${r.area}`;
      const hit = gsmClusters.find((c) => c.key.startsWith(prefix + '|') && haversineM(c.lat, c.lng, r.lat, r.lng) < 150);
      if (hit) key = hit.key;
      else {
        key = `${prefix}|${gsmClusters.length}`;
        gsmClusters.push({ key, lat: r.lat, lng: r.lng });
      }
    }
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }

  const created: Operator[] = [];
  const stations: BaseStation[] = [];
  let siteIdx = 0;
  for (const [key, cells] of groups) {
    if (stations.length >= maxSites) {
      skip('site limit');
      continue;
    }
    const tech = cells[0].radio as Tech;
    const lat = cells.reduce((a, c) => a + c.lat, 0) / cells.length;
    const lng = cells.reduce((a, c) => a + c.lng, 0) / cells.length;
    const plmn = `${cells[0].mcc}-${cells[0].net.padStart(2, '0')}`;
    const op = operatorFor(scn, created, plmn);
    const id = key.split('|')[3];
    const bs = makeStation(presets[tech], lat, lng, op.id, `${tech === 'GSM' ? 'G' : tech === 'LTE' ? 'L' : 'N'}${id}`, { sectors: cells.length >= 2 ? cells.length : 3, pciBase: (siteIdx * 3) % 504 });
    // Point sectors towards each cell's measured centroid when it's far enough from the site.
    const proj = new LocalProjection(lat, lng);
    if (cells.length >= 2) {
      const sorted = cells
        .map((c) => {
          const p = proj.toXY(c.lat, c.lng);
          return { c, d: Math.hypot(p.x, p.y), az: bearingDeg(0, 0, p.x, p.y) };
        })
        .sort((a, b) => a.az - b.az);
      const spread = sorted.every((s) => s.d > 30);
      sorted.forEach((s, i) => {
        bs.sectors[i].azimuth = spread ? Math.round(s.az) : Math.round((360 / sorted.length) * i);
      });
    }
    stations.push(bs);
    siteIdx++;
  }
  return { stations, newOperators: created, skipped };
}

/** Communication masts/towers from OpenStreetMap via Overpass. */
export async function importOsmTowers(scn: Scenario, bounds: Bounds, preset: StationPreset, defaultOperatorId: string): Promise<ImportResult> {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  const q = `[out:json][timeout:40];(
    nwr["man_made"~"^(mast|tower)$"]["tower:type"="communication"](${bbox});
    nwr["communication:mobile_phone"="yes"](${bbox});
    nwr["telecom"="antenna"](${bbox});
  );out center tags;`;
  const els = (await fetchOverpass(q)) as unknown as { id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[];
  const created: Operator[] = [];
  const stations: BaseStation[] = [];
  const skipped: Record<string, number> = {};
  for (const e of els) {
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (lat === undefined || lng === undefined) continue;
    // De-duplicate towers tagged several ways.
    if (stations.some((s) => haversineM(s.lat, s.lng, lat, lng) < 15)) {
      skipped['duplicate'] = (skipped['duplicate'] ?? 0) + 1;
      continue;
    }
    const t = e.tags ?? {};
    const opName = t.operator?.split(';')[0]?.trim();
    const opId = opName ? operatorFor(scn, created, '', opName).id : defaultOperatorId;
    const bs = makeStation(preset, lat, lng, opId, t.name || t.ref || `OSM${e.id}`, { sectors: 3, pciBase: (stations.length * 3) % 504 });
    const h = parseFloat(t.height ?? '');
    if (Number.isFinite(h) && h > 3 && h < 400) bs.heightM = Math.round(h * 0.9);
    stations.push(bs);
  }
  return { stations, newOperators: created, skipped };
}

export function exportScenario(scn: Scenario) {
  const blob = new Blob([JSON.stringify(scn, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${scn.name.replace(/[^\w-]+/g, '_') || 'scenario'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function parseScenario(text: string): Scenario {
  const s = JSON.parse(text) as Scenario;
  if (s.version !== 1 || !Array.isArray(s.stations) || !Array.isArray(s.operators)) throw new Error('Not a radio-sim scenario file (version 1)');
  return s;
}
