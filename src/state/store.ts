import type { BaseStation, Scenario, Settings, Tech } from '../types';
import { defaultScenario, defaultSettings } from './defaults';

export type HeatmapKind = 'none' | 'rsrp' | 'server' | 'sinr' | 'throughput';

export interface LayerState {
  heatmap: HeatmapKind;
  opacity: number;
  /** Heatmap grid step in screen pixels. */
  resolutionPx: number;
  operatorFilter: string; // 'all' or operator id
  techFilter: Tech | 'all';
  showSectors: boolean;
  showUsers: boolean;
  showLinks: boolean;
  showRoads: boolean;
}

type EventName = 'network' | 'settings' | 'selection' | 'layers' | 'scenario' | 'users';
type Listener = () => void;

const STORAGE_KEY = 'radio-sim.scenario.v1';

/** Central app state with a tiny pub/sub. */
export class Store {
  scenario: Scenario;
  selectedStationId: string | null = null;
  layers: LayerState = {
    heatmap: 'rsrp',
    opacity: 0.55,
    resolutionPx: 4,
    operatorFilter: 'op1',
    techFilter: 'LTE',
    showSectors: true,
    showUsers: true,
    showLinks: false,
    showRoads: false,
  };
  private listeners = new Map<EventName, Set<Listener>>();
  private saveTimer = 0;

  constructor() {
    this.scenario = loadSaved() ?? defaultScenario();
  }

  on(ev: EventName, fn: Listener): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(ev: EventName) {
    this.listeners.get(ev)?.forEach((fn) => fn());
    if (ev !== 'selection' && ev !== 'layers') this.scheduleSave();
  }

  station(id: string | null): BaseStation | undefined {
    return id ? this.scenario.stations.find((s) => s.id === id) : undefined;
  }

  select(id: string | null) {
    this.selectedStationId = id;
    this.emit('selection');
  }

  addStations(list: BaseStation[]) {
    this.scenario.stations.push(...list);
    this.emit('network');
  }

  removeStation(id: string) {
    this.scenario.stations = this.scenario.stations.filter((s) => s.id !== id);
    if (this.selectedStationId === id) this.selectedStationId = null;
    this.emit('network');
    this.emit('selection');
  }

  replaceScenario(s: Scenario) {
    s.settings = mergeSettings(s.settings);
    s.fixedUsers ??= [];
    this.scenario = s;
    this.selectedStationId = null;
    if (!s.operators.some((o) => o.id === this.layers.operatorFilter)) this.layers.operatorFilter = 'all';
    this.emit('scenario');
    this.emit('network');
    this.emit('settings');
    this.emit('selection');
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.scenario));
      } catch {
        /* storage unavailable or full; the scenario still lives in memory */
      }
    }, 500);
  }
}

/** Fill settings keys missing from older or partial scenario files. */
export function mergeSettings(p: Partial<Settings> | undefined): Settings {
  const d = defaultSettings();
  const t = p?.thresholds;
  return {
    radio: { ...d.radio, ...p?.radio },
    users: { ...d.users, ...p?.users },
    sim: { ...d.sim, ...p?.sim },
    thresholds: { GSM: { ...d.thresholds.GSM, ...t?.GSM }, LTE: { ...d.thresholds.LTE, ...t?.LTE }, NR: { ...d.thresholds.NR, ...t?.NR } },
  };
}

function loadSaved(): Scenario | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Scenario;
    if (s?.version !== 1 || !Array.isArray(s.stations)) return null;
    s.settings = mergeSettings(s.settings);
    s.fixedUsers ??= [];
    return s;
  } catch {
    return null;
  }
}

export function clearSaved() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
