import type { BaseStation, Scenario, Settings, Tech } from '../types';
import { areaAround, generateUsers, mulberry32, templateFromSettings } from '../sim/population';
import { DEFAULT_CENTER, defaultScenario, defaultSettings, defaultWifi } from './defaults';

export type HeatmapKind = 'none' | 'rsrp' | 'server' | 'sinr' | 'throughput' | 'modulation' | 'condition';

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
  showBuildings: boolean;
  /** Wi-Fi APs and their association range. */
  showWifi: boolean;
}

/** 'model': the path-loss model was switched from outside the Radio panel (it re-renders). */
type EventName = 'network' | 'settings' | 'selection' | 'layers' | 'scenario' | 'users' | 'model';
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
    showBuildings: false,
    showWifi: true,
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

  /** Selected Wi-Fi AP (its inspector is open); exclusive with the selected station. */
  selectedApId: string | null = null;

  ap(id: string | null) {
    return id ? this.scenario.wifi?.find((a) => a.id === id) : undefined;
  }

  selectAp(id: string | null) {
    this.selectedApId = id;
    if (id) this.selectedStationId = null;
    this.emit('selection');
  }

  removeAps(ids: Set<string>) {
    this.scenario.wifi = (this.scenario.wifi ?? []).filter((a) => !ids.has(a.id));
    if (this.selectedApId && ids.has(this.selectedApId)) this.selectedApId = null;
    this.emit('network');
    this.emit('selection');
  }

  select(id: string | null) {
    this.selectedStationId = id;
    if (id) this.selectedApId = null;
    this.emit('selection');
  }

  addStations(list: BaseStation[]) {
    this.scenario.stations.push(...list);
    this.emit('network');
    this.revealStations(list);
  }

  /** True when the coverage layer's operator/RAT filter shows this station. */
  isVisible(bs: BaseStation): boolean {
    const l = this.layers;
    return (l.operatorFilter === 'all' || l.operatorFilter === bs.operatorId) && (l.techFilter === 'all' || l.techFilter === bs.tech);
  }

  /** Point the layer filter at newly added stations if it would hide all of them. */
  private revealStations(list: BaseStation[]) {
    if (!list.length || list.some((s) => this.isVisible(s))) return;
    const ops = new Set(list.map((s) => s.operatorId));
    const techs = new Set(list.map((s) => s.tech));
    this.layers.operatorFilter = ops.size === 1 ? list[0].operatorId : 'all';
    this.layers.techFilter = techs.size === 1 ? list[0].tech : 'all';
    this.emit('layers');
  }

  /** Switch to the building-aware path-loss model (COST-231 Walfisch–Ikegami + OSM buildings). */
  useBuildingModel() {
    this.scenario.settings.radio.model = 'cost231-wi';
    this.emit('settings');
    this.emit('model');
  }

  /** Show every operator and RAT on the coverage layer. */
  showAllLayers() {
    this.layers.operatorFilter = 'all';
    this.layers.techFilter = 'all';
    this.emit('layers');
  }

  removeStation(id: string) {
    this.scenario.stations = this.scenario.stations.filter((s) => s.id !== id);
    if (this.selectedStationId === id) this.selectedStationId = null;
    this.emit('network');
    this.emit('selection');
  }

  replaceScenario(s: Scenario) {
    s.settings = mergeSettings(s.settings);
    migrateUsers(s);
    this.scenario = s;
    this.selectedStationId = null;
    this.selectedApId = null;
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
    wifi: { ...d.wifi, ...p?.wifi },
    ca: { ...d.ca, ...p?.ca },
    thresholds: { GSM: { ...d.thresholds.GSM, ...t?.GSM }, LTE: { ...d.thresholds.LTE, ...t?.LTE }, NR: { ...d.thresholds.NR, ...t?.NR } },
  };
}

/**
 * Older scenarios had random users generated on every reset plus separate fixed
 * users; now every user is listed in `users`. Generate the random ones once
 * (seeded) and merge in the fixed ones.
 */
export function migrateUsers(s: Scenario) {
  // Scenarios saved before Wi-Fi existed: the demo area gets the demo APs, elsewhere none.
  if (!s.wifi) s.wifi = Math.abs(s.center.lat - DEFAULT_CENTER.lat) < 0.02 && Math.abs(s.center.lng - DEFAULT_CENTER.lng) < 0.03 ? defaultWifi() : [];
  if (!s.users) {
    const generated = generateUsers(s, templateFromSettings(s), areaAround(s.center.lat, s.center.lng), mulberry32(s.settings.sim.seed));
    s.users = [...(s.fixedUsers ?? []), ...generated];
  }
  delete s.fixedUsers;
}

function loadSaved(): Scenario | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Scenario;
    if (s?.version !== 1 || !Array.isArray(s.stations)) return null;
    s.settings = mergeSettings(s.settings);
    migrateUsers(s);
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
