import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { destination } from '../geo';
import { verticalFootprint } from '../radio/antenna';
import type { RadioContext } from '../radio/cells';
import type { SimEngine, SimUser } from '../sim/engine';
import type { Zone } from '../sim/population';
import type { RoadGraph } from '../sim/roads';
import type { Store } from '../state/store';
import type { BuildingSet } from '../radio/buildings';
import type { BaseStation, WifiAp } from '../types';
import { wifiRangeM } from '../radio/wifi';

const TECH_SHORT = { GSM: '2G', LTE: '4G', NR: '5G' } as const;

type UserMarker = L.CircleMarker & { uid: number };

/** Sequential blue ramp by building height (reference palette steps 150–700). */
const BUILDING_RAMP: [number, string][] = [[6, '#b7d3f6'], [12, '#86b6ef'], [18, '#5598e7'], [25, '#2a78d6'], [35, '#1c5cab'], [Infinity, '#0d366b']];
export const buildingColor = (h: number) => BUILDING_RAMP.find(([max]) => h < max)![1];
export const BUILDING_LEGEND = BUILDING_RAMP;

/** Colour of public Wi-Fi APs and of sessions carried over Wi-Fi. */
export const WIFI_COLOR = '#7b5cd6';

const WIFI_SVG = '<svg viewBox="0 0 16 16"><path d="M1.8 6.2a9 9 0 0 1 12.4 0M4.3 8.8a5.4 5.4 0 0 1 7.4 0M6.6 11.3a2 2 0 0 1 2.8 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="13.4" r="1.2" fill="currentColor"/></svg>';

/** Fill = state (idle / voice / data / over Wi-Fi / no service); outline = mobility; active users are larger. */
function userStyle(u: SimUser, onWifi: boolean): L.CircleMarkerOptions {
  const fill = onWifi ? WIFI_COLOR : u.serving < 0 && !u.session ? '#000' : u.session?.kind === 'voice' ? '#1565c0' : u.session?.kind === 'data' ? '#2e7d32' : '#9e9e9e';
  const stroke = u.mode === 'drive' ? '#222' : u.mode === 'static' ? '#f2b705' : '#fff';
  return { fillColor: fill, color: stroke, weight: u.mode === 'static' ? 2 : 1, radius: u.session ? 5 : 3.5 };
}
/**
 * Keep clicks inside a floating panel from reaching the map. Leaflet's own
 * disableClickPropagation walks up from the click target at handling time, so a
 * button that re-renders its panel (and is detached by then) would otherwise be
 * taken for a click on the empty map (deselecting, or placing a site).
 */
export function isolateFromMap(el: HTMLElement) {
  L.DomEvent.disableClickPropagation(el);
  L.DomEvent.disableScrollPropagation(el);
  el.addEventListener('click', (e) => e.stopPropagation());
  el.addEventListener('dblclick', (e) => e.stopPropagation());
}

/** Footprints whose upper beam edge never lands are drawn out to this range (dashed). */
const FOOTPRINT_MAX_M = 6000;

export class MapView {
  readonly map: L.Map;
  private stationLayer = L.layerGroup();
  private sectorLayer = L.layerGroup();
  private userLayer: L.LayerGroup;
  private linkLayer: L.LayerGroup;
  private roadLayer: L.LayerGroup;
  private areaRect: L.Rectangle | null = null;
  private renderer: L.Canvas;
  private userMarkers: L.CircleMarker[] = [];
  private linkLines: L.Polyline[] = [];
  private markers = new Map<string, L.Marker>();
  private highlight: L.CircleMarker | null = null;
  private ctx: RadioContext | null = null;
  /**
   * What a click on the empty map does: place a base station or a user, pick a
   * zone for batch-adding users (rectangle: two corners; circle: its centre), or nothing.
   */
  placeMode: 'site' | 'user' | 'wifi' | 'zone-rect' | 'zone-circle' | 'target' | null = null;
  /** Called when a zone is picked; the mode then ends. */
  onZone: (z: Zone) => void = () => {};
  /** Radius used by the circle zone preview, m. */
  zoneRadiusM = 300;
  private zoneStart: L.LatLng | null = null;
  private zonePreview: L.Path | null = null;
  /** Users selected in the Users list (spec ids), drawn with a highlight ring. */
  highlighted = new Set<string>();
  private hlLayer = L.layerGroup();
  private placeListeners: (() => void)[] = [];
  onAddSite: (lat: number, lng: number) => void = () => {};
  onAddUser: (lat: number, lng: number) => void = () => {};
  onAddAp: (lat: number, lng: number) => void = () => {};
  /** Target picked for the user in the inspector; the mode then ends. */
  onPickTarget: (lat: number, lng: number) => void = () => {};
  /** Selected user's target and the rest of its route there. */
  private targetLine: L.Polyline | null = null;
  private targetMark: L.Marker | null = null;
  onApMoved: (id: string) => void = () => {};
  onStationMoved: (id: string) => void = () => {};
  onUserClick: (userId: number) => void = () => {};
  /** Called while a user is dragged (`final` false) and once on drop. */
  onUserDrag: (userId: number, lat: number, lng: number, final: boolean) => void = () => {};
  selectedUserId: number | null = null;
  private selRing: L.CircleMarker | null = null;
  private suppressClick = false;
  /** Banner over the map while a place mode is active. */
  private banner: HTMLDivElement;
  private bannerText: HTMLSpanElement;
  /** Describe what clicking will place (set by the panels that own each mode). */
  placeHint: Record<'site' | 'user' | 'wifi', () => string> = { site: () => 'Click the map to place a base station', user: () => 'Click the map to place a user', wifi: () => 'Click the map to place a Wi-Fi access point' };

  constructor(
    el: HTMLElement,
    private store: Store,
  ) {
    const c = store.scenario.center;
    this.map = L.map(el, { zoomControl: true, preferCanvas: false }).setView([c.lat, c.lng], c.zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    L.control.scale({ imperial: false }).addTo(this.map);

    this.map.createPane('heatmapPane').style.zIndex = '350';
    this.map.createPane('buildingsPane').style.zIndex = '355';
    this.map.createPane('roadsPane').style.zIndex = '360';
    this.map.createPane('sectorPane').style.zIndex = '420';
    this.map.createPane('usersPane').style.zIndex = '440';

    this.renderer = L.canvas({ pane: 'usersPane', padding: 0.2 });
    this.userLayer = L.layerGroup().addTo(this.map);
    this.linkLayer = L.layerGroup().addTo(this.map);
    this.roadLayer = L.layerGroup();
    this.sectorLayer.addTo(this.map);
    this.stationLayer.addTo(this.map);
    this.wifiLayer.addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      if (this.suppressClick) return;
      if (this.placeMode === 'site') this.onAddSite(e.latlng.lat, e.latlng.lng);
      else if (this.placeMode === 'user') this.onAddUser(e.latlng.lat, e.latlng.lng);
      else if (this.placeMode === 'wifi') this.onAddAp(e.latlng.lat, e.latlng.lng);
      else if (this.placeMode === 'target') {
        this.setPlaceMode(null);
        this.onPickTarget(e.latlng.lat, e.latlng.lng);
      }
      else if (this.placeMode === 'zone-circle') {
        const c = e.latlng;
        this.setPlaceMode(null);
        this.onZone({ kind: 'circle', lat: c.lat, lng: c.lng, radiusM: this.zoneRadiusM });
      } else if (this.placeMode === 'zone-rect') {
        if (!this.zoneStart) this.zoneStart = e.latlng;
        else {
          const b = L.latLngBounds(this.zoneStart, e.latlng);
          this.setPlaceMode(null);
          this.onZone({ kind: 'rect', south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
        }
      } else {
        store.selectedApId = null;
        store.select(null);
      }
    });
    // Live preview of the zone being picked.
    this.map.on('mousemove', (e: L.LeafletMouseEvent) => {
      if (this.placeMode === 'zone-circle') this.showZonePreview(L.circle(e.latlng, { radius: this.zoneRadiusM }));
      else if (this.placeMode === 'zone-rect' && this.zoneStart) this.showZonePreview(L.rectangle(L.latLngBounds(this.zoneStart, e.latlng)));
    });
    this.hlLayer.addTo(this.map);
    this.map.on('zoomend', () => this.renderSectors());
    this.map.on('moveend', () => {
      if (this.store.layers.showBuildings) this.renderBuildings();
    });

    this.bannerText = L.DomUtil.create('span', 'place-text');
    this.banner = L.DomUtil.create('div', 'place-banner', this.map.getContainer());
    const done = L.DomUtil.create('button', 'btn', this.banner);
    done.type = 'button';
    done.textContent = 'Done';
    done.title = 'Stop editing (Esc)';
    done.onclick = () => this.setPlaceMode(null);
    this.banner.prepend(this.bannerText);
    this.banner.style.display = 'none';
    isolateFromMap(this.banner);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.placeMode) this.setPlaceMode(null);
    });
  }

  /**
   * Enter/leave a place mode. While placing sites the map is in "edit network"
   * mode: base stations can be dragged; outside it they are fixed, so viewing
   * the map never moves a site by accident.
   */
  setPlaceMode(mode: MapView['placeMode']) {
    if (this.placeMode === mode) return;
    this.placeMode = mode;
    this.zoneStart = null;
    this.zonePreview?.remove();
    this.zonePreview = null;
    this.map.getContainer().classList.toggle('add-mode', mode !== null);
    this.refreshBanner();
    for (const m of this.markers.values()) this.applyDraggable(m);
    for (const m of this.apMarkers.values()) (mode === 'wifi' ? m.dragging?.enable() : m.dragging?.disable());
    this.placeListeners.forEach((fn) => fn());
  }

  /** Re-read the banner text (e.g. after the template or operator changed). */
  refreshBanner() {
    const mode = this.placeMode;
    this.banner.style.display = mode ? '' : 'none';
    if (!mode) return;
    this.bannerText.innerHTML = '';
    const title = document.createElement('b');
    const sub = document.createElement('span');
    sub.className = 'place-sub';
    if (mode === 'target') {
      title.textContent = 'Click the map to set where the selected user goes';
      sub.textContent = 'It follows the roads there and stops · Esc to cancel';
    } else if (mode === 'zone-rect' || mode === 'zone-circle') {
      title.textContent = mode === 'zone-rect' ? 'Pick a rectangle for the new users' : `Pick the centre of a ${this.zoneRadiusM} m circle for the new users`;
      sub.textContent = mode === 'zone-rect' ? 'Click one corner, then the opposite corner · Esc to cancel' : 'Click the map · Esc to cancel';
    } else {
      title.textContent = this.placeHint[mode]();
      sub.textContent = mode === 'site' ? 'Click the map to add · drag sites to move · Esc to finish' : mode === 'wifi' ? 'Click the map to add · drag APs to move · Esc to finish' : 'Click the map to add · Esc to finish';
    }
    this.bannerText.append(title, sub);
  }

  private applyDraggable(m: L.Marker) {
    if (this.placeMode === 'site') m.dragging?.enable();
    else m.dragging?.disable();
  }

  onPlaceModeChange(fn: () => void) {
    this.placeListeners.push(fn);
  }

  setContext(ctx: RadioContext) {
    this.ctx = ctx;
  }

  // ---------------------------------------------------------------- stations

  renderStations() {
    const scn = this.store.scenario;
    const ops = new Map(scn.operators.map((o) => [o.id, o]));
    const seen = new Set<string>();
    for (const bs of scn.stations) {
      seen.add(bs.id);
      const op = ops.get(bs.operatorId);
      const color = op?.color ?? '#555';
      const selected = this.store.selectedStationId === bs.id;
      const html = `<div class="bs-icon ${selected ? 'selected' : ''} ${bs.enabled ? '' : 'disabled'}" style="--c:${color}"><span>${TECH_SHORT[bs.tech]}</span></div>`;
      // Nudge icons by RAT so co-located 2G/4G/5G sites stay individually clickable.
      const dx = bs.tech === 'GSM' ? 13 : bs.tech === 'NR' ? -13 : 0;
      const icon = L.divIcon({ className: 'bs-divicon', html, iconSize: [22, 22], iconAnchor: [11 + dx, 11] });
      let m = this.markers.get(bs.id);
      if (!m) {
        m = L.marker([bs.lat, bs.lng], { icon, draggable: true, autoPan: true, zIndexOffset: 1000 });
        m.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          // Clicking an existing site means "edit this one": leave placement mode.
          this.setPlaceMode(null);
          this.store.select(bs.id);
        });
        m.on('drag', () => {
          const p = m!.getLatLng();
          const s = this.store.station(bs.id);
          if (s) {
            s.lat = p.lat;
            s.lng = p.lng;
            this.renderSectors();
          }
        });
        m.on('dragend', () => this.onStationMoved(bs.id));
        m.addTo(this.stationLayer);
        this.markers.set(bs.id, m);
      } else {
        m.setLatLng([bs.lat, bs.lng]);
        m.setIcon(icon);
      }
      this.applyDraggable(m);
      m.bindTooltip(`${bs.name} · ${op?.name ?? '?'} · ${bs.tech} ${bs.band}`, { direction: 'top', offset: [0, -10] });
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) {
        m.remove();
        this.markers.delete(id);
      }
    }
    this.renderSectors();
  }

  /** Sector wedges, sized in screen space so they stay readable at any zoom. */
  renderSectors() {
    this.sectorLayer.clearLayers();
    if (!this.store.layers.showSectors) return;
    const scn = this.store.scenario;
    const ops = new Map(scn.operators.map((o) => [o.id, o]));
    const zoom = this.map.getZoom();
    const lenM = 70 * Math.pow(2, 16 - zoom);
    const byServer = this.store.layers.heatmap === 'server';
    const cellColor = new Map<string, string>();
    if (this.ctx) for (const c of this.ctx.cells) cellColor.set(c.sectorId, c.color);
    const visible = (bs: BaseStation) => {
      const lay = this.store.layers;
      return (lay.operatorFilter === 'all' || bs.operatorId === lay.operatorFilter) && (lay.techFilter === 'all' || bs.tech === lay.techFilter);
    };

    for (const bs of scn.stations) {
      const dim = !visible(bs);
      const opColor = ops.get(bs.operatorId)?.color ?? '#555';
      const selected = this.store.selectedStationId === bs.id;
      // Stagger lengths by technology so co-located 2G/4G/5G sectors are distinguishable.
      const len = lenM * (bs.tech === 'GSM' ? 1.25 : bs.tech === 'LTE' ? 1 : 0.8);
      for (const s of bs.sectors) {
        const color = byServer ? (cellColor.get(s.id) ?? opColor) : opColor;
        const style: L.PathOptions = {
          pane: 'sectorPane',
          color: selected ? '#000' : color,
          weight: selected ? 2 : 1,
          fillColor: color,
          fillOpacity: !s.enabled || !bs.enabled ? 0.05 : dim ? 0.08 : 0.45,
          opacity: dim ? 0.3 : 0.9,
          dashArray: s.enabled && bs.enabled ? undefined : '3 3',
          interactive: false,
        };
        if (s.hBeamwidth >= 360) {
          L.circle([bs.lat, bs.lng], { ...style, radius: len * 0.55 }).addTo(this.sectorLayer);
          continue;
        }
        const half = Math.min(s.hBeamwidth, 120) / 2;
        const pts: L.LatLngExpression[] = [[bs.lat, bs.lng]];
        for (let a = -half; a <= half + 1e-6; a += half / 6) {
          const p = destination(bs.lat, bs.lng, s.azimuth + a, len);
          pts.push([p.lat, p.lng]);
        }
        L.polygon(pts, style).addTo(this.sectorLayer);
      }
    }
    const sel = this.store.station(this.store.selectedStationId);
    if (sel) this.renderFootprint(sel, cellColor);
  }

  /**
   * Ground footprint of each sector's vertical main beam for the selected station:
   * the ring segment between where the −3 dB edges (tilt ± V-BW/2) reach UE height,
   * plus a dashed arc where the boresight lands. Drawn in metres, so it scales with zoom.
   */
  private renderFootprint(bs: BaseStation, cellColor: Map<string, string>) {
    const hm = this.store.scenario.settings.radio.ueHeightM;
    const arc = (az: number, half: number, r: number) => {
      const out: [number, number][] = [];
      const n = Math.max(8, Math.ceil(half / 3));
      for (let k = 0; k <= n; k++) {
        const p = destination(bs.lat, bs.lng, az - half + (2 * half * k) / n, r);
        out.push([p.lat, p.lng]);
      }
      return out;
    };
    for (const s of bs.sectors) {
      if (!s.enabled || !bs.enabled) continue;
      const fp = verticalFootprint(bs.heightM, hm, s.tilt, s.vBeamwidth);
      const color = cellColor.get(s.id) ?? '#000';
      const half = Math.min(s.hBeamwidth, 360) / 2;
      const capped = !Number.isFinite(fp.far) || fp.far > FOOTPRINT_MAX_M;
      const far = Math.min(fp.far, FOOTPRINT_MAX_M);
      const near = Math.min(fp.near, far);
      const outer = arc(s.azimuth, half, far);
      const inner = near > 1 ? arc(s.azimuth, half, near).reverse() : [[bs.lat, bs.lng] as [number, number]];
      L.polygon([...outer, ...inner], { pane: 'sectorPane', stroke: false, fillColor: color, fillOpacity: 0.18, interactive: false }).addTo(this.sectorLayer);
      L.polyline(outer, { pane: 'sectorPane', color, weight: 2, opacity: 0.9, dashArray: capped ? '2 6' : undefined, interactive: false }).addTo(this.sectorLayer);
      if (near > 1) L.polyline(inner, { pane: 'sectorPane', color, weight: 2, opacity: 0.9, interactive: false }).addTo(this.sectorLayer);
      if (Number.isFinite(fp.peak) && fp.peak <= FOOTPRINT_MAX_M) {
        L.polyline(arc(s.azimuth, half, fp.peak), { pane: 'sectorPane', color, weight: 1.5, opacity: 0.9, dashArray: '6 4', interactive: false }).addTo(this.sectorLayer);
      }
    }
  }

  // ---------------------------------------------------------------- Wi-Fi

  private wifiLayer = L.layerGroup();
  private apMarkers = new Map<string, L.Marker>();
  private apRange = L.layerGroup();

  /** AP markers and association-range circles (median RSSI = the minimum RSSI). */
  renderWifi() {
    const scn = this.store.scenario;
    const aps = scn.wifi ?? [];
    const show = this.store.layers.showWifi;
    this.apRange.clearLayers();
    if (!show) {
      this.wifiLayer.clearLayers();
      this.apMarkers.clear();
      return;
    }
    this.apRange.addTo(this.wifiLayer);
    const minRssi = scn.settings.wifi.minRssiDbm;
    const rf = new Map((this.ctx?.wifi ?? []).map((a) => [a.apId, a]));
    const seen = new Set<string>();
    for (const ap of aps) {
      seen.add(ap.id);
      const color = this.apColor(ap);
      const selected = this.store.selectedApId === ap.id;
      const icon = L.divIcon({ className: 'bs-divicon', html: `<div class="ap-icon ${selected ? 'selected' : ''} ${ap.enabled ? '' : 'disabled'}" style="--c:${color}">${WIFI_SVG}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
      let m = this.apMarkers.get(ap.id);
      if (!m) {
        m = L.marker([ap.lat, ap.lng], { icon, draggable: true, autoPan: true, zIndexOffset: 900 });
        m.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          this.setPlaceMode(null);
          this.store.selectAp(ap.id);
        });
        m.on('drag', () => {
          const a = this.store.ap(ap.id);
          if (!a) return;
          const p = m!.getLatLng();
          a.lat = p.lat;
          a.lng = p.lng;
        });
        m.on('dragend', () => this.onApMoved(ap.id));
        m.addTo(this.wifiLayer);
        this.apMarkers.set(ap.id, m);
      } else {
        m.setLatLng([ap.lat, ap.lng]);
        m.setIcon(icon);
      }
      if (this.placeMode === 'wifi') m.dragging?.enable();
      else m.dragging?.disable();
      m.bindTooltip(`${ap.name} · ${ap.band} GHz ch ${ap.channel} · ${ap.widthMHz} MHz${ap.access === 'public' ? '' : ` · ${scn.operators.find((o) => o.id === ap.access)?.name ?? '?'} only`}`, { direction: 'top', offset: [0, -10] });
      const r = rf.get(ap.id);
      if (r) {
        L.circle([ap.lat, ap.lng], { radius: wifiRangeM(r, minRssi), pane: 'sectorPane', color, weight: selected ? 2 : 1, dashArray: '4 4', fillColor: color, fillOpacity: selected ? 0.12 : 0.06, interactive: false }).addTo(this.apRange);
      }
    }
    for (const [id, m] of this.apMarkers) {
      if (!seen.has(id)) {
        m.remove();
        this.apMarkers.delete(id);
      }
    }
  }

  apColor(ap: WifiAp): string {
    return ap.access === 'public' ? WIFI_COLOR : (this.store.scenario.operators.find((o) => o.id === ap.access)?.color ?? WIFI_COLOR);
  }

  focusAp(id: string) {
    const ap = this.store.ap(id);
    if (ap) this.map.panTo([ap.lat, ap.lng]);
  }

  focusStation(id: string) {
    const bs = this.store.station(id);
    if (bs) this.map.panTo([bs.lat, bs.lng]);
  }

  // ---------------------------------------------------------------- users

  renderUsers(engine: SimEngine) {
    const lay = this.store.layers;
    const users = engine.users;
    if (!lay.showUsers) {
      this.userLayer.clearLayers();
      this.userMarkers = [];
      this.selRing = null;
    } else {
      while (this.userMarkers.length > users.length) this.userMarkers.pop()!.remove();
      for (let i = 0; i < users.length; i++) {
        const u = users[i];
        let m = this.userMarkers[i];
        if (!m) {
          m = L.circleMarker([u.lat, u.lng], { renderer: this.renderer, radius: 4, weight: 1, color: '#fff', fillOpacity: 0.95 });
          this.attachUserDrag(m);
          m.addTo(this.userLayer);
          this.userMarkers[i] = m;
        }
        (m as UserMarker).uid = u.id;
        m.setLatLng([u.lat, u.lng]);
        m.setStyle(userStyle(u, engine.onWifi(u)));
      }
      this.renderSelection(engine);
      this.renderHighlights(engine);
    }

    // Links: active users → serving cell (Layers option), plus every user camped
    // on the selected station (solid = active session, dashed = idle).
    const selBs = this.store.selectedStationId;
    const selAp = this.store.selectedApId;
    if ((!lay.showLinks && !selBs && !selAp) || !this.ctx || !lay.showUsers) {
      if (this.linkLines.length) {
        this.linkLayer.clearLayers();
        this.linkLines = [];
      }
      return;
    }
    let k = 0;
    const line = (ll: L.LatLngExpression[], style: L.PolylineOptions) => {
      let l = this.linkLines[k];
      if (!l) {
        l = L.polyline(ll, { renderer: this.renderer, interactive: false });
        l.addTo(this.linkLayer);
        this.linkLines[k] = l;
      } else l.setLatLngs(ll);
      l.setStyle(style);
      k++;
    };
    for (const u of users) {
      // Wi-Fi association: to the AP (solid = session over Wi-Fi, dashed = associated only).
      const ap = u.wifiAp >= 0 ? this.ctx.wifi[u.wifiAp] : undefined;
      const wifiCarried = engine.onWifi(u);
      if (ap && (ap.apId === selAp || (lay.showLinks && wifiCarried))) {
        line([[u.lat, u.lng], [ap.lat, ap.lng]], { color: WIFI_COLOR, weight: ap.apId === selAp ? 2 : 1, opacity: 0.85, dashArray: wifiCarried ? undefined : '3 4' });
      }
      if (u.serving < 0) continue;
      const c = this.ctx.cells[u.serving];
      if (!c) continue;
      const ofSelected = c.bsId === selBs;
      if (!ofSelected && !(lay.showLinks && u.session && !wifiCarried)) continue;
      line([[u.lat, u.lng], [c.lat, c.lng]], { color: c.color, weight: ofSelected ? 2 : 1, opacity: ofSelected ? 0.9 : 0.7, dashArray: ofSelected && (!u.session || wifiCarried) ? '3 4' : undefined });
    }
    while (this.linkLines.length > k) this.linkLines.pop()!.remove();
  }

  private showZonePreview(p: L.Path) {
    this.zonePreview?.remove();
    p.setStyle({ color: '#2a78d6', weight: 2, dashArray: '6 4', fillOpacity: 0.08, interactive: false });
    this.zonePreview = p.addTo(this.map);
  }

  /** Rings around users selected in the Users list. */
  renderHighlights(engine: SimEngine) {
    this.hlLayer.clearLayers();
    if (!this.highlighted.size || !this.store.layers.showUsers) return;
    for (const u of engine.users) {
      if (!u.specId || !this.highlighted.has(u.specId)) continue;
      L.circleMarker([u.lat, u.lng], { renderer: this.renderer, radius: 8, weight: 2, color: '#2a78d6', fill: false, interactive: false }).addTo(this.hlLayer);
    }
  }

  /** Highlight ring around the user shown in the inspector. */
  renderSelection(engine: SimEngine) {
    const u = this.selectedUserId !== null ? engine.userById(this.selectedUserId) : undefined;
    this.renderTarget(engine, u);
    if (!u || !this.store.layers.showUsers) {
      this.selRing?.remove();
      this.selRing = null;
      return;
    }
    if (!this.selRing) this.selRing = L.circleMarker([u.lat, u.lng], { renderer: this.renderer, radius: 10, weight: 2.5, color: '#000', fill: false, interactive: false }).addTo(this.userLayer);
    this.selRing.setLatLng([u.lat, u.lng]);
  }

  /** Flag at the selected user's target and a dashed line along the rest of its route. */
  private renderTarget(engine: SimEngine, u: SimUser | undefined) {
    if (!u?.target || !this.store.layers.showUsers) {
      this.targetLine?.remove();
      this.targetMark?.remove();
      this.targetLine = this.targetMark = null;
      return;
    }
    const pts = engine.targetRoute(u);
    if (!this.targetLine) this.targetLine = L.polyline([], { color: '#000', weight: 2, opacity: 0.6, dashArray: '4 5', interactive: false }).addTo(this.map);
    this.targetLine.setLatLngs(pts);
    const t: L.LatLngExpression = [u.target.lat, u.target.lng];
    if (!this.targetMark) {
      const icon = L.divIcon({ className: 'target-divicon', html: '<div class="target-icon">⚑</div>', iconSize: [20, 20], iconAnchor: [4, 18] });
      this.targetMark = L.marker(t, { icon, interactive: false, keyboard: false, zIndexOffset: 900 }).addTo(this.map);
    } else this.targetMark.setLatLng(t);
    this.targetMark.getElement()?.classList.toggle('reached', u.arrived);
  }

  /** Press on a user: a short press selects it, moving the mouse drags it. */
  private attachUserDrag(m: L.CircleMarker) {
    m.on('click', (e) => L.DomEvent.stopPropagation(e));
    m.on('mousedown', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stop(e);
      const uid = (m as UserMarker).uid;
      const start = e.containerPoint;
      let moved = false;
      let last = e.latlng;
      this.map.dragging.disable();
      const onMove = (ev: L.LeafletMouseEvent) => {
        if (!moved && ev.containerPoint.distanceTo(start) < 4) return;
        moved = true;
        last = ev.latlng;
        m.setLatLng(last);
        if (this.selectedUserId === uid) this.selRing?.setLatLng(last);
        this.onUserDrag(uid, last.lat, last.lng, false);
      };
      const onUp = () => {
        this.map.off('mousemove', onMove);
        this.map.dragging.enable();
        // The mouseup also produces a map click; don't let it place a site or deselect.
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
        if (moved) this.onUserDrag(uid, last.lat, last.lng, true);
        else this.onUserClick(uid);
      };
      this.map.on('mousemove', onMove);
      document.addEventListener('mouseup', onUp, { once: true });
    });
  }

  // ---------------------------------------------------------------- buildings

  private buildingSet: BuildingSet | null = null;
  private buildingDefaultH = 12;
  private buildingBoxes: Float64Array | null = null;
  private buildingLayer = L.layerGroup();
  private buildingRenderer = L.canvas({ pane: 'buildingsPane' });

  setBuildings(set: BuildingSet | null, defaultHeightM: number) {
    this.buildingSet = set;
    this.buildingDefaultH = defaultHeightM;
    this.buildingBoxes = null;
    if (set) {
      // Per-building bounding boxes for fast view culling.
      const b = new Float64Array(set.count * 4);
      for (let i = 0; i < set.count; i++) {
        let s = 90, w = 180, n = -90, e = -180;
        for (let k = set.ringOffsets[set.ringStart[i]]; k < set.ringOffsets[set.ringStart[i + 1]]; k++) {
          const la = set.coords[2 * k];
          const ln = set.coords[2 * k + 1];
          if (la < s) s = la;
          if (la > n) n = la;
          if (ln < w) w = ln;
          if (ln > e) e = ln;
        }
        b.set([s, w, n, e], i * 4);
      }
      this.buildingBoxes = b;
    }
    this.renderBuildings();
  }

  /** Footprints in view, coloured by height (only from zoom 15: tens of thousands otherwise). */
  renderBuildings() {
    this.buildingLayer.clearLayers();
    const set = this.buildingSet;
    if (!this.store.layers.showBuildings || !set || !this.buildingBoxes) {
      this.buildingLayer.remove();
      return;
    }
    this.buildingLayer.addTo(this.map);
    if (this.map.getZoom() < 15) return;
    const v = this.map.getBounds().pad(0.1);
    const vs = v.getSouth(), vw = v.getWest(), vn = v.getNorth(), ve = v.getEast();
    const bx = this.buildingBoxes;
    for (let i = 0; i < set.count; i++) {
      if (bx[i * 4 + 2] < vs || bx[i * 4] > vn || bx[i * 4 + 3] < vw || bx[i * 4 + 1] > ve) continue;
      // Outer outline(s) and courtyards; Leaflet fills multi-ring polygons with holes.
      const rings: [number, number][][] = [];
      for (let ri = set.ringStart[i]; ri < set.ringStart[i + 1]; ri++) {
        const ring: [number, number][] = [];
        for (let k = set.ringOffsets[ri]; k < set.ringOffsets[ri + 1]; k++) ring.push([set.coords[2 * k], set.coords[2 * k + 1]]);
        rings.push(ring);
      }
      const known = set.heights[i] > 0;
      const hgt = known ? set.heights[i] : this.buildingDefaultH;
      L.polygon(rings, {
        renderer: this.buildingRenderer,
        color: known ? '#184f95' : '#8a8984',
        weight: 0.6,
        dashArray: known ? undefined : '2 2',
        fillColor: buildingColor(hgt),
        fillOpacity: 0.55,
        interactive: false,
      }).addTo(this.buildingLayer);
    }
  }

  // ---------------------------------------------------------------- roads / area

  renderRoads(g: RoadGraph | null) {
    this.roadLayer.clearLayers();
    if (g) {
      const r = L.canvas({ pane: 'roadsPane' });
      for (const pl of g.polylines) L.polyline(pl, { renderer: r, color: '#ff00aa', weight: 1.5, opacity: 0.6, interactive: false }).addTo(this.roadLayer);
    }
    this.setRoadsVisible(this.store.layers.showRoads);
  }

  setRoadsVisible(on: boolean) {
    if (on) this.roadLayer.addTo(this.map);
    else this.roadLayer.remove();
  }

  setArea(b: { south: number; west: number; north: number; east: number } | null) {
    this.areaRect?.remove();
    this.areaRect = null;
    if (b) {
      this.areaRect = L.rectangle(
        [
          [b.south, b.west],
          [b.north, b.east],
        ],
        { color: '#333', weight: 1, dashArray: '6 4', fill: false, interactive: false },
      ).addTo(this.map);
    }
  }

  flashAt(lat: number, lng: number, color: string) {
    this.highlight?.remove();
    this.highlight = L.circleMarker([lat, lng], { radius: 16, color, weight: 3, fill: false, className: 'flash' }).addTo(this.map);
    this.map.panTo([lat, lng]);
    const h = this.highlight;
    setTimeout(() => {
      if (this.highlight === h) {
        h.remove();
        this.highlight = null;
      }
    }, 2500);
  }
}
