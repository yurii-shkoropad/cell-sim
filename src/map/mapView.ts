import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { destination } from '../geo';
import { verticalFootprint } from '../radio/antenna';
import type { RadioContext } from '../radio/cells';
import type { SimEngine, SimUser } from '../sim/engine';
import type { RoadGraph } from '../sim/roads';
import type { Store } from '../state/store';
import type { BaseStation } from '../types';

const TECH_SHORT = { GSM: '2G', LTE: '4G', NR: '5G' } as const;

type UserMarker = L.CircleMarker & { uid: number };

/** Fill = state (idle / voice / data / no service); outline = mobility; fixed users are larger squares-ish. */
function userStyle(u: SimUser): L.CircleMarkerOptions {
  const fill = u.serving < 0 ? '#000' : u.session?.kind === 'voice' ? '#1565c0' : u.session?.kind === 'data' ? '#2e7d32' : '#9e9e9e';
  const stroke = u.mode === 'drive' ? '#222' : u.mode === 'static' ? '#f2b705' : '#fff';
  return { fillColor: fill, color: stroke, weight: u.mode === 'static' ? 2 : 1, radius: (u.session ? 5 : 3.5) + (u.fixedId ? 2 : 0) };
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
  /** What a click on the empty map places: a base station, a static user, or nothing. */
  placeMode: 'site' | 'user' | null = null;
  private placeListeners: (() => void)[] = [];
  onAddSite: (lat: number, lng: number) => void = () => {};
  onAddUser: (lat: number, lng: number) => void = () => {};
  onStationMoved: (id: string) => void = () => {};
  onUserClick: (userId: number) => void = () => {};
  /** Called while a user is dragged (`final` false) and once on drop. */
  onUserDrag: (userId: number, lat: number, lng: number, final: boolean) => void = () => {};
  selectedUserId: number | null = null;
  private selRing: L.CircleMarker | null = null;
  private suppressClick = false;

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
    this.map.createPane('roadsPane').style.zIndex = '360';
    this.map.createPane('sectorPane').style.zIndex = '420';
    this.map.createPane('usersPane').style.zIndex = '440';

    this.renderer = L.canvas({ pane: 'usersPane', padding: 0.2 });
    this.userLayer = L.layerGroup().addTo(this.map);
    this.linkLayer = L.layerGroup().addTo(this.map);
    this.roadLayer = L.layerGroup();
    this.sectorLayer.addTo(this.map);
    this.stationLayer.addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      if (this.suppressClick) return;
      if (this.placeMode === 'site') this.onAddSite(e.latlng.lat, e.latlng.lng);
      else if (this.placeMode === 'user') this.onAddUser(e.latlng.lat, e.latlng.lng);
      else store.select(null);
    });
    this.map.on('zoomend', () => this.renderSectors());
  }

  setPlaceMode(mode: 'site' | 'user' | null) {
    this.placeMode = mode;
    this.map.getContainer().classList.toggle('add-mode', mode !== null);
    this.placeListeners.forEach((fn) => fn());
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
        m.setStyle(userStyle(u));
      }
      this.renderSelection(engine);
    }

    // Links from active users to their serving cell.
    if (!lay.showLinks || !this.ctx) {
      if (this.linkLines.length) {
        this.linkLayer.clearLayers();
        this.linkLines = [];
      }
      return;
    }
    let k = 0;
    for (const u of users) {
      if (u.serving < 0 || !u.session) continue;
      const c = this.ctx.cells[u.serving];
      if (!c) continue;
      let line = this.linkLines[k];
      const ll: L.LatLngExpression[] = [[u.lat, u.lng], [c.lat, c.lng]];
      if (!line) {
        line = L.polyline(ll, { renderer: this.renderer, weight: 1, opacity: 0.7, interactive: false });
        line.addTo(this.linkLayer);
        this.linkLines[k] = line;
      } else line.setLatLngs(ll);
      line.setStyle({ color: c.color });
      k++;
    }
    while (this.linkLines.length > k) this.linkLines.pop()!.remove();
  }

  /** Highlight ring around the user shown in the inspector. */
  renderSelection(engine: SimEngine) {
    const u = this.selectedUserId !== null ? engine.userById(this.selectedUserId) : undefined;
    if (!u || !this.store.layers.showUsers) {
      this.selRing?.remove();
      this.selRing = null;
      return;
    }
    if (!this.selRing) this.selRing = L.circleMarker([u.lat, u.lng], { renderer: this.renderer, radius: 10, weight: 2.5, color: '#000', fill: false, interactive: false }).addTo(this.userLayer);
    this.selRing.setLatLng([u.lat, u.lng]);
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
