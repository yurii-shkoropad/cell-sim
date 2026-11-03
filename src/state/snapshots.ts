import type { Scenario } from '../types';
import type { LayerState } from './store';

/**
 * Named copies of the whole state, kept in this browser (localStorage): the scenario (network,
 * users, Wi-Fi, buildings, settings), the map layers and view options, and the map position.
 */
export interface Snapshot {
  id: string;
  name: string;
  savedAt: number;
  scenario: Scenario;
  layers: LayerState;
  view: { lat: number; lng: number; zoom: number };
}

const KEY = 'radio-sim.snapshots.v1';

export function listSnapshots(): Snapshot[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((s) => s && typeof s.id === 'string' && s.scenario) : [];
  } catch {
    return [];
  }
}

/** Writes the list; false when the browser refuses (storage full or blocked). */
function write(list: Snapshot[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** Saves a new snapshot, or replaces the one with `id`. Returns it, or null if storage refused. */
export function saveSnapshot(name: string, scenario: Scenario, layers: LayerState, view: Snapshot['view'], id?: string): Snapshot | null {
  const list = listSnapshots();
  const snap: Snapshot = { id: id ?? `snap-${Date.now().toString(36)}`, name, savedAt: Date.now(), scenario: clone(scenario), layers: clone(layers), view };
  const k = list.findIndex((s) => s.id === snap.id);
  if (k >= 0) list[k] = snap;
  else list.unshift(snap);
  return write(list) ? snap : null;
}

export function renameSnapshot(id: string, name: string): boolean {
  const list = listSnapshots();
  const s = list.find((x) => x.id === id);
  if (!s) return false;
  s.name = name;
  return write(list);
}

export function deleteSnapshot(id: string): boolean {
  return write(listSnapshots().filter((s) => s.id !== id));
}

/** A deep copy to load, so editing after loading never changes the saved snapshot. */
export function snapshotCopy(id: string): Snapshot | undefined {
  const s = listSnapshots().find((x) => x.id === id);
  return s ? clone(s) : undefined;
}

/** Approximate size of the stored snapshots, kB. */
export function snapshotsSizeKb(): number {
  try {
    return Math.round((localStorage.getItem(KEY)?.length ?? 0) / 1024);
  } catch {
    return 0;
  }
}
