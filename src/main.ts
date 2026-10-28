import { HeatmapLayer } from './map/heatmap';
import { MapView } from './map/mapView';
import { buildRadioContext, type RadioContext } from './radio/cells';
import { SimEngine, techMaskOf, techsOf, type SimUser } from './sim/engine';
import type { UserSpec } from './types';
import { fetchOverpass, loadBundledRoads, loadRoadGraph, type Bounds, type RoadGraph } from './sim/roads';
import { BuildingModel } from './radio/buildingModel';
import { buildingsFromBundle, buildingsFromOverpass, type BuildingSet, type BundledBuildings } from './radio/buildings';
import { LocalProjection } from './geo';
import { Store } from './state/store';
import './styles.css';
import type { App } from './ui/app';
import { button, h, selectEl, toast } from './ui/dom';
import { fmtTime, kpiPanel } from './ui/kpiPanel';
import { StationInspector } from './ui/stationInspector';
import { ApInspector } from './ui/apInspector';
import { UserInspector } from './ui/userInspector';
import { dataPanel, planningPanel } from './ui/panels/data';
import { helpPanel } from './ui/panels/help';
import { networkPanel } from './ui/panels/network';
import { layersPanel, radioPanel } from './ui/panels/settings';
import { usersPanel } from './ui/panels/users';
import { wifiPanel } from './ui/panels/wifi';

const MAX_ROAD_AREA_KM2 = 40;

const store = new Store();

// ---------------------------------------------------------------- layout
const playBtn = button('▶ Run', () => setRunning(!running), 'primary play');
const stepBtn = button('Step', () => {
  engine.step();
  liveTick();
  mapView.renderUsers(engine);
}, '', 'Advance one time step');
const resetBtn = button('Reset', () => resetSim(), '', 'Restart the simulation: users back to their start positions, KPIs cleared')
let speed = 5;
const speedSel = selectEl(
  [['1', '×1'], ['2', '×2'], ['5', '×5'], ['10', '×10'], ['30', '×30'], ['60', '×60']],
  () => String(speed) as '5',
  (v) => (speed = +v),
);
const clock = h('span', { class: 'clock' }, '0:00');
const perf = h('span', { class: 'perf' }, '');
const hmStatus = h('span', { class: 'hm-status' }, '');
const roadStatus = h('span', { class: 'hm-status' }, '');
const bldStatus = h('span', { class: 'hm-status' }, '');
// ---------------------------------------------------------------- side panels
type Side = 'left' | 'right';
const PANEL_KEY = 'radio-sim.hidden-panels';
const hiddenPanels = new Set<Side>();
try {
  for (const s of JSON.parse(localStorage.getItem(PANEL_KEY) ?? '[]') as Side[]) hiddenPanels.add(s);
} catch {
  /* ignore */
}
const toggleLeft = button('☰', () => setPanel('left', hiddenPanels.has('left')), 'ghost panel-toggle', 'Show or hide the side panel');
const toggleRight = button('KPIs ◧', () => setPanel('right', hiddenPanels.has('right')), 'ghost panel-toggle', 'Show or hide the KPI panel');

function applyPanels() {
  document.body.classList.toggle('no-left', hiddenPanels.has('left'));
  document.body.classList.toggle('no-right', hiddenPanels.has('right'));
  toggleLeft.classList.toggle('active', !hiddenPanels.has('left'));
  toggleRight.classList.toggle('active', !hiddenPanels.has('right'));
}

/** Show or hide a side panel; the map is told about its new size so tiles and the heatmap fill it. */
function setPanel(side: Side, visible: boolean) {
  if (visible) hiddenPanels.delete(side);
  else hiddenPanels.add(side);
  applyPanels();
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify([...hiddenPanels]));
  } catch {
    /* ignore */
  }
  mapView.map.invalidateSize({ pan: false });
  heatmap.schedule(50);
}
applyPanels();

const header = h('header', null,
  toggleLeft,
  h('div', { class: 'brand' }, h('b', null, 'CellSim'), h('span', null, 'mobile network simulator')),
  h('div', { class: 'controls' }, playBtn, stepBtn, resetBtn, h('label', { class: 'speed' }, 'Speed ', speedSel), clock, perf),
  h('div', { class: 'right-ctl' }, roadStatus, bldStatus, hmStatus, toggleRight),
);
const mapEl = h('div', { id: 'map' });
const tabsEl = h('nav', { class: 'tabs' });
const panelEl = h('div', { class: 'panel-host' });
const left = h('aside', { class: 'left' }, tabsEl, panelEl);
const right = h('aside', { class: 'right' });
document.getElementById('app')!.append(header, h('div', { class: 'main' }, left, mapEl, right));

// ---------------------------------------------------------------- core objects
const mapView = new MapView(mapEl, store);
const heatmap = new HeatmapLayer(mapView.map, store);
let ctx: RadioContext = buildRadioContext(store.scenario);
let roads: RoadGraph | null = null;
const buildings = new BuildingModel();
const MAX_BUILDING_AREA_KM2 = 12;

const viewBounds = (): Bounds => {
  const b = mapView.map.getBounds();
  return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
};
const engine = new SimEngine(store.scenario, ctx, viewBounds());
mapView.setArea(engine.area);

const liveFns: (() => void)[] = [];
const app: App = {
  store,
  mapView,
  heatmap,
  engine,
  ctx: () => ctx,
  roads: () => roads,
  loadRoads,
  buildings: () => buildings,
  loadBuildings,
  respawnUsers: () => resetSim(),
  deleteAllUsers: () => app.deleteUsers((store.scenario.users ?? []).map((u) => u.id)),
  addUsers: (specs) => {
    (store.scenario.users ??= []).push(...specs);
    for (const s of specs) engine.addUser(s);
    usersChanged();
  },
  deleteUsers: (ids) => {
    const set = new Set(ids);
    const open = inspector.userId !== null ? engine.userById(inspector.userId) : undefined;
    if (open?.specId && set.has(open.specId)) inspector.close();
    store.scenario.users = (store.scenario.users ?? []).filter((u) => !set.has(u.id));
    engine.removeUsersBySpec(set);
    for (const id of ids) mapView.highlighted.delete(id);
    usersChanged();
  },
  editUsers: (ids, patch) => {
    const set = new Set(ids);
    for (const spec of store.scenario.users ?? []) {
      if (!set.has(spec.id)) continue;
      Object.assign(spec, patch);
      const u = engine.userBySpec(spec.id);
      if (u) applySpec(u, spec, patch);
    }
    usersChanged();
  },
  saveUser: (u) => {
    const spec = u.specId ? store.scenario.users?.find((x) => x.id === u.specId) : undefined;
    if (!spec) return;
    Object.assign(spec, {
      name: u.name ?? spec.name,
      lat: u.lat,
      lng: u.lng,
      operatorId: store.scenario.operators[u.opIdx]?.id ?? spec.operatorId,
      techs: techsOf(u.techMask),
      mobility: u.mode,
      traffic: u.traffic,
      demandMbps: u.demandMbps,
      ueRx: u.ueRxOverride,
      speedKmh: u.speedFixed ? Math.round(u.speed * 3.6) : null,
    });
    store.emit('users');
  },
  setUserSelection: (ids) => {
    mapView.highlighted = new Set(ids);
    mapView.renderHighlights(engine);
  },
  openUser: (id) => {
    // One inspector at a time: showing a user closes the station / AP panel.
    if (store.selectedStationId) store.select(null);
    if (store.selectedApId) store.selectAp(null);
    inspector.open(id);
  },
  onLiveTick: (fn) => liveFns.push(fn),
};

// Expose for scripting / inspection from the browser console.
(window as unknown as { cellsim: App }).cellsim = app;

heatmap.loadsProvider = () => engine.loads.slice();
heatmap.onStatus = (busy, ms) => (hmStatus.textContent = busy ? 'computing heatmap…' : `heatmap ${ms.toFixed(0)} ms`);

function rebuild() {
  ctx = buildRadioContext(store.scenario, buildings.provider(store.scenario));
  buildings.finish(ctx);
  if (buildings.lastComputed) bldStatus.textContent = `buildings: ${buildings.set!.count} · traced ${buildings.lastComputed} site${buildings.lastComputed > 1 ? 's' : ''} in ${buildings.lastComputeMs.toFixed(0)} ms`;
  engine.setScenario(store.scenario, ctx);
  mapView.setContext(ctx);
  mapView.renderStations();
  mapView.renderWifi();
  heatmap.setContext(ctx);
}

let rebuildTimer = 0;
const scheduleRebuild = () => {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(rebuild, 60);
};
store.on('network', scheduleRebuild);
store.on('settings', scheduleRebuild);
store.on('selection', () => {
  mapView.renderStations();
  mapView.renderWifi();
});
store.on('layers', () => {
  heatmap.schedule(0);
  mapView.renderSectors();
  mapView.renderWifi();
});
mapView.onApMoved = () => store.emit('network');
mapView.onStationMoved = () => {
  store.emit('network');
  store.emit('selection');
};
const inspector = new UserInspector(app);
const stationInspector = new StationInspector(app);
const apInspector = new ApInspector(app);
mapView.onUserClick = (id) => {
  mapView.setPlaceMode(null);
  app.openUser(id);
};
mapView.onUserDrag = (id, lat, lng, final) => {
  const u = engine.userById(id);
  if (!u) return;
  engine.moveUserTo(u, lat, lng, final);
  if (final) {
    inspector.dropped(u);
    mapView.renderUsers(engine);
  }
};

/** After adding / removing / editing users: persist, refresh map, list and KPIs. */
function usersChanged() {
  store.emit('users');
  mapView.renderUsers(engine);
  if (inspector.userId !== null) inspector.renderEdit();
  liveTick();
}

/** Apply edited fields of a user entry to its live user. */
function applySpec(u: SimUser, spec: UserSpec, patch: Partial<UserSpec>) {
  if (patch.operatorId !== undefined) engine.setOperator(u, engine.opIndex(spec.operatorId));
  if (patch.techs !== undefined) engine.setTechMask(u, techMaskOf(spec.techs));
  if (patch.mobility !== undefined) engine.setMobility(u, spec.mobility);
  if (patch.traffic !== undefined) engine.setTraffic(u, spec.traffic);
  if (patch.demandMbps !== undefined) {
    u.demandMbps = spec.demandMbps;
    if (u.session?.kind === 'data' && spec.demandMbps !== null) u.session.demandMbps = spec.demandMbps;
  }
  if (patch.ueRx !== undefined) engine.setUeRx(u, spec.ueRx ?? null);
  if (patch.speedKmh !== undefined) {
    u.speedFixed = spec.speedKmh != null;
    if (spec.speedKmh != null && u.mode !== 'static') u.speed = spec.speedKmh / 3.6;
  }
  if (patch.name !== undefined) u.name = spec.name;
  if (patch.wifi !== undefined) engine.setWifiOn(u, spec.wifi ?? engine.wifiDefault(spec.id));
}

// ---------------------------------------------------------------- tabs
const tabs: [string, string, () => HTMLElement][] = [
  ['network', 'Network', () => networkPanel(app)],
  ['users', 'Users', () => usersPanel(app)],
  ['wifi', 'Wi-Fi', () => wifiPanel(app)],
  ['radio', 'Radio', () => radioPanel(app)],
  ['layers', 'Layers', () => layersPanel(app)],
  ['plan', 'Planning', () => planningPanel(app)],
  ['data', 'Import/Export', () => dataPanel(app)],
  ['help', 'Models', () => helpPanel()],
];
const panels = new Map<string, HTMLElement>();
let currentTab = '';
function showTab(key: string) {
  // Switching panels ends any placement mode (re-showing the same tab does not).
  if (key !== currentTab) mapView.setPlaceMode(null);
  currentTab = key;
  for (const [k, el] of panels) el.style.display = k === key ? '' : 'none';
  tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === key));
  try {
    localStorage.setItem('radio-sim.tab', key);
  } catch {
    /* ignore */
  }
}
for (const [k, label, make] of tabs) {
  const el = make();
  el.style.display = 'none';
  panels.set(k, el);
  panelEl.appendChild(el);
  const b = h('button', { type: 'button', onclick: () => showTab(k) }, label);
  b.dataset.k = k;
  tabsEl.appendChild(b);
}
let initialTab = 'network';
try {
  initialTab = localStorage.getItem('radio-sim.tab') ?? 'network';
} catch {
  /* ignore */
}
showTab(panels.has(initialTab) ? initialTab : 'network');
// Selecting a site (map, list, or after placing it) opens its inspector over the map.
store.on('selection', () => {
  if (store.selectedStationId) {
    inspector.close();
    stationInspector.open(store.selectedStationId);
  } else stationInspector.close();
  if (store.selectedApId) {
    inspector.close();
    apInspector.open(store.selectedApId);
  } else apInspector.close();
  mapView.renderUsers(engine);
});
store.on('network', () => {
  stationInspector.refresh();
  apInspector.refresh();
});

right.appendChild(kpiPanel(app));

// ---------------------------------------------------------------- simulation loop
let running = false;
function setRunning(on: boolean) {
  running = on;
  playBtn.textContent = on ? '⏸ Pause' : '▶ Run';
  playBtn.classList.toggle('active', on);
  last = performance.now();
}

function resetSim() {
  // User ids are reassigned on respawn, so the inspector's selection is no longer valid.
  inspector.close();
  engine.reset();
  mapView.renderUsers(engine);
  liveTick();
}

function liveTick() {
  clock.textContent = fmtTime(engine.t);
  for (const fn of liveFns) fn();
}

let last = performance.now();
let acc = 0;
let lastLive = 0;
let lastUserDraw = 0;
let lastHeatRefresh = 0;
let simAtWindow = 0;
let realAtWindow = performance.now();

function frame(now: number) {
  const dtReal = Math.min(now - last, 250);
  last = now;
  if (running) {
    const stepMs = store.scenario.settings.sim.stepMs;
    acc += dtReal * speed;
    const t0 = performance.now();
    let steps = 0;
    // Keep the UI responsive: at most ~14 ms of simulation per frame.
    while (acc >= stepMs && performance.now() - t0 < 14) {
      engine.step();
      acc -= stepMs;
      steps++;
    }
    if (acc > stepMs * 5) acc = stepMs * 5; // falling behind: drop backlog rather than spiral
    if (steps && now - lastUserDraw > 66) {
      mapView.renderUsers(engine);
      lastUserDraw = now;
    }
    // In 'actual' load mode the SINR map depends on traffic; refresh occasionally.
    const r = store.scenario.settings.radio;
    if (r.interferenceLoad === 'actual' && (store.layers.heatmap === 'sinr' || store.layers.heatmap === 'throughput') && now - lastHeatRefresh > 10000) {
      heatmap.schedule(0);
      lastHeatRefresh = now;
    }
  }
  if (now - lastLive > 1000) {
    liveTick();
    lastLive = now;
    const simDt = engine.t - simAtWindow;
    const realDt = (now - realAtWindow) / 1000;
    perf.textContent = running ? `×${(simDt / realDt).toFixed(1)} actual` : '';
    simAtWindow = engine.t;
    realAtWindow = now;
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- roads
async function loadRoads() {
  const b = viewBounds();
  const proj = new LocalProjection((b.south + b.north) / 2, (b.west + b.east) / 2);
  const sw = proj.toXY(b.south, b.west);
  const ne = proj.toXY(b.north, b.east);
  const km2 = ((ne.x - sw.x) * (ne.y - sw.y)) / 1e6;
  if (km2 > MAX_ROAD_AREA_KM2) {
    toast(`The view covers ${km2.toFixed(0)} km². Zoom in to at most ${MAX_ROAD_AREA_KM2} km² before loading roads.`, 'error');
    return;
  }
  if (roadsLoading) return;
  roadsLoading = true;
  try {
    const proj0 = new LocalProjection(store.scenario.center.lat, store.scenario.center.lng);
    roadStatus.textContent = 'roads: loading…';
    roads = await loadRoadGraph(b, proj0, (host) => (roadStatus.textContent = `roads: querying ${host}…`));
    roadStatus.textContent = `roads: ${roads.wayCount} OSM ways`;
    engine.setGraph(roads);
    mapView.renderRoads(roads);
    mapView.setArea(engine.area);
    resetSim();
    toast(`Loaded ${roads.wayCount} OSM ways. Users respawned on the road network.`, 'ok');
  } catch (e) {
    roadStatus.textContent = 'roads: not loaded (random waypoint)';
    toast(`Could not load roads: ${(e as Error).message}`, 'error');
  } finally {
    roadsLoading = false;
  }
}
let roadsLoading = false;

// ---------------------------------------------------------------- buildings
function applyBuildings(set: BuildingSet, source: string) {
  buildings.setBuildings(set, source);
  bldStatus.textContent = `buildings: ${set.count} (${source})`;
  mapView.setBuildings(set, store.scenario.settings.radio.defaultBuildingHeightM);
  scheduleRebuild();
}

/** Fetch OSM building footprints for the current view from Overpass. */
async function loadBuildings() {
  const b = viewBounds();
  const proj = new LocalProjection((b.south + b.north) / 2, (b.west + b.east) / 2);
  const sw = proj.toXY(b.south, b.west);
  const ne = proj.toXY(b.north, b.east);
  const km2 = ((ne.x - sw.x) * (ne.y - sw.y)) / 1e6;
  if (km2 > MAX_BUILDING_AREA_KM2) {
    toast(`The view covers ${km2.toFixed(0)} km². Zoom in to at most ${MAX_BUILDING_AREA_KM2} km² before loading buildings.`, 'error');
    return;
  }
  bldStatus.textContent = 'buildings: loading…';
  try {
    const els = await fetchOverpass(`[out:json][timeout:90];(way["building"](${b.south},${b.west},${b.north},${b.east});rel["building"]["type"="multipolygon"](${b.south},${b.west},${b.north},${b.east}););out body qt;>;out skel qt;`, undefined, (host) => (bldStatus.textContent = `buildings: querying ${host}…`));
    const set = buildingsFromOverpass(els as Parameters<typeof buildingsFromOverpass>[0], b);
    applyBuildings(set, 'Overpass');
    toast(`Loaded ${set.count} OSM buildings`, 'ok');
  } catch (e) {
    bldStatus.textContent = buildings.set ? `buildings: ${buildings.set.count} (${buildings.source})` : '';
    toast(`Could not load buildings: ${(e as Error).message}`, 'error');
  }
}

// ---------------------------------------------------------------- boot
store.on('scenario', () => {
  roads = null;
  roadStatus.textContent = '';
  engine.setGraph(null);
  mapView.renderRoads(null);
  engine.area = viewBounds();
  mapView.setArea(engine.area);
});
rebuild();
resetSim();
requestAnimationFrame(frame);
// Put users on real streets right away: the demo area ships with an OSM extract,
// anywhere else is fetched live from Overpass.
const BUNDLED = { url: `${import.meta.env.BASE_URL}roads/lviv-polytechnic.json`, south: 49.8176, west: 23.9862, north: 49.8536, east: 24.0422 };
const BUNDLED_BUILDINGS = `${import.meta.env.BASE_URL}buildings/lviv-polytechnic.json`;
(async () => {
  const c = store.scenario.center;
  if (c.lat > BUNDLED.south && c.lat < BUNDLED.north && c.lng > BUNDLED.west && c.lng < BUNDLED.east) {
    try {
      roadStatus.textContent = 'roads: loading bundled extract…';
      roads = await loadBundledRoads(BUNDLED.url, new LocalProjection(c.lat, c.lng));
      engine.setGraph(roads);
      mapView.renderRoads(roads);
      mapView.setArea(engine.area);
      resetSim();
      roadStatus.textContent = `roads: ${roads.wayCount} OSM ways (bundled)`;
      fetch(BUNDLED_BUILDINGS)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j: BundledBuildings) => applyBuildings(buildingsFromBundle(j), 'bundled'))
        .catch(() => (bldStatus.textContent = ''));
      return;
    } catch {
      /* fall through to Overpass */
    }
  }
  loadRoads();
})();
