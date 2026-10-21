import type { LocalProjection } from '../geo';

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Directed graph in compressed sparse row form. */
interface Csr {
  offsets: Uint32Array;
  targets: Uint32Array;
  weights: Float32Array;
  /** Nodes of the largest weakly connected component (spawn/destination pool). */
  pool: Uint32Array;
}

export interface RoadGraph {
  bounds: Bounds;
  x: Float64Array;
  y: Float64Array;
  lat: Float64Array;
  lng: Float64Array;
  walk: Csr;
  drive: Csr;
  /** Polylines for drawing, as [lat,lng][] per way. */
  polylines: [number, number][][];
  wayCount: number;
}

export type TravelMode = 'walk' | 'drive';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** Per-mirror timeout before trying the next one, ms. The main server gets longer: it is often slow but reliable. */
const ENDPOINT_TIMEOUT_MS = [90000, 30000, 30000, 30000];

const HIGHWAYS =
  'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|pedestrian|footway|path|steps|cycleway|track';

const NO_WALK = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);
const DRIVE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service']);

interface OsmElement {
  type: 'node' | 'way';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

export async function fetchOverpass(query: string, signal?: AbortSignal, onTry?: (host: string) => void): Promise<OsmElement[]> {
  let lastErr: unknown;
  for (const [k, url] of OVERPASS_ENDPOINTS.entries()) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ENDPOINT_TIMEOUT_MS[k]);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      onTry?.(new URL(url).host);
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
      const json = await res.json();
      return json.elements as OsmElement[];
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = ctl.signal.aborted ? new Error(`${new URL(url).host}: timed out`) : e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Overpass request failed');
}

export async function loadRoadGraph(b: Bounds, proj: LocalProjection, onTry?: (host: string) => void): Promise<RoadGraph> {
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  // Ways with tags, but nodes as bare coordinates (skel) to keep the response small.
  const q = `[out:json][timeout:40];way["highway"~"^(${HIGHWAYS})$"](${bbox})->.w;.w out body qt;node(w.w);out skel qt;`;
  const elements = await fetchOverpass(q, undefined, onTry);
  return buildRoadGraph(elements, b, proj);
}

/** Compact road extract shipped with the app (see public/roads). */
export interface BundledRoads {
  bounds: Bounds;
  highways: string[];
  /** Flat [lat·1e6, lng·1e6, ...]. */
  nodes: number[];
  /** [highwayIndex, flags, nodeIndex...]; flags: 1 oneway, 2 reverse oneway, 4 roundabout, 8 foot=no, 16 access=no, 32 motor_vehicle=no. */
  ways: number[][];
}

export async function loadBundledRoads(url: string, proj: LocalProjection): Promise<RoadGraph> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const b = (await res.json()) as BundledRoads;
  const els: OsmElement[] = [];
  for (let i = 0; i < b.nodes.length / 2; i++) els.push({ type: 'node', id: i, lat: b.nodes[2 * i] / 1e6, lon: b.nodes[2 * i + 1] / 1e6 });
  b.ways.forEach(([hw, f, ...nodes], i) => {
    const tags: Record<string, string> = { highway: b.highways[hw] };
    if (f & 1) tags.oneway = 'yes';
    if (f & 2) tags.oneway = '-1';
    if (f & 4) tags.junction = 'roundabout';
    if (f & 8) tags.foot = 'no';
    if (f & 16) tags.access = 'no';
    if (f & 32) tags.motor_vehicle = 'no';
    els.push({ type: 'way', id: i, nodes, tags });
  });
  return buildRoadGraph(els, b.bounds, proj);
}

export function buildRoadGraph(elements: OsmElement[], bounds: Bounds, proj: LocalProjection): RoadGraph {
  const nodePos = new Map<number, [number, number]>();
  for (const e of elements) if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) nodePos.set(e.id, [e.lat, e.lon]);

  const index = new Map<number, number>();
  const lat: number[] = [];
  const lng: number[] = [];
  const idx = (osmId: number) => {
    let i = index.get(osmId);
    if (i === undefined) {
      const p = nodePos.get(osmId)!;
      i = lat.length;
      index.set(osmId, i);
      lat.push(p[0]);
      lng.push(p[1]);
    }
    return i;
  };

  const walkEdges: number[] = [];
  const driveEdges: number[] = [];
  const polylines: [number, number][][] = [];
  let wayCount = 0;

  for (const e of elements) {
    if (e.type !== 'way' || !e.nodes || !e.tags?.highway) continue;
    const hw = e.tags.highway;
    const nodes = e.nodes.filter((n) => nodePos.has(n));
    if (nodes.length < 2) continue;
    wayCount++;
    const ids = nodes.map(idx);
    polylines.push(nodes.map((n) => nodePos.get(n)!));
    const walk = !NO_WALK.has(hw) && e.tags.foot !== 'no';
    const drive = DRIVE.has(hw) && e.tags.access !== 'no' && e.tags.motor_vehicle !== 'no';
    const ow = e.tags.oneway;
    const forward = ow !== '-1';
    const backward = !(ow === 'yes' || ow === 'true' || ow === '1' || hw === 'motorway' || e.tags.junction === 'roundabout') || ow === '-1';
    for (let k = 0; k + 1 < ids.length; k++) {
      const a = ids[k];
      const c = ids[k + 1];
      if (walk) walkEdges.push(a, c, c, a);
      if (drive) {
        if (forward) driveEdges.push(a, c);
        if (backward) driveEdges.push(c, a);
      }
    }
  }

  const n = lat.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = proj.toXY(lat[i], lng[i]);
    x[i] = p.x;
    y[i] = p.y;
  }

  return {
    bounds,
    x,
    y,
    lat: Float64Array.from(lat),
    lng: Float64Array.from(lng),
    walk: toCsr(n, walkEdges, x, y),
    drive: toCsr(n, driveEdges, x, y),
    polylines,
    wayCount,
  };
}

function toCsr(n: number, edges: number[], x: Float64Array, y: Float64Array): Csr {
  const m = edges.length / 2;
  const offsets = new Uint32Array(n + 1);
  for (let k = 0; k < m; k++) offsets[edges[2 * k] + 1]++;
  for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i];
  const fill = offsets.slice(0, n);
  const targets = new Uint32Array(m);
  const weights = new Float32Array(m);
  for (let k = 0; k < m; k++) {
    const a = edges[2 * k];
    const b = edges[2 * k + 1];
    const pos = fill[a]++;
    targets[pos] = b;
    weights[pos] = Math.hypot(x[a] - x[b], y[a] - y[b]);
  }
  return { offsets, targets, weights, pool: largestComponent(n, offsets, targets) };
}

/** Largest weakly connected component, treating edges as undirected. */
function largestComponent(n: number, offsets: Uint32Array, targets: Uint32Array): Uint32Array {
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let a = 0; a < n; a++) {
    for (let k = offsets[a]; k < offsets[a + 1]; k++) {
      const ra = find(a);
      const rb = find(targets[k]);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const size = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (offsets[i + 1] === offsets[i]) continue; // isolated w.r.t. this mode
    const r = find(i);
    size.set(r, (size.get(r) ?? 0) + 1);
  }
  let best = -1;
  let bestSize = 0;
  for (const [r, s] of size) if (s > bestSize) [best, bestSize] = [r, s];
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (offsets[i + 1] !== offsets[i] && find(i) === best) out.push(i);
  return Uint32Array.from(out);
}

/** A* shortest path; returns node indices from `from` to `to`, or null. */
export function route(g: RoadGraph, mode: TravelMode, from: number, to: number): number[] | null {
  const csr = mode === 'walk' ? g.walk : g.drive;
  const n = g.x.length;
  const gScore = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const h = (i: number) => Math.hypot(g.x[i] - g.x[to], g.y[i] - g.y[to]);
  gScore[from] = 0;
  heap.push(from, h(from));
  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (cur === to) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (++expanded > 200000) return null;
    for (let k = csr.offsets[cur]; k < csr.offsets[cur + 1]; k++) {
      const nb = csr.targets[k];
      const t = gScore[cur] + csr.weights[k];
      if (t < gScore[nb]) {
        gScore[nb] = t;
        prev[nb] = cur;
        heap.push(nb, t + h(nb));
      }
    }
  }
  if (gScore[to] === Infinity) return null;
  const path: number[] = [];
  for (let c = to; c !== -1; c = prev[c]) path.push(c);
  return path.reverse();
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}
