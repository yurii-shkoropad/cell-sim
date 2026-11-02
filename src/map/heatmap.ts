import L from 'leaflet';
import type { RadioContext } from '../radio/cells';
import type { HeatmapKind, Store } from '../state/store';
import { MODULATIONS } from '../radio/modulation';
import { PATH_COND_LABEL } from '../radio/buildingPaths';

/** Unknown, LOS, NLOS, indoor. */
const COND_COLORS = ['#888888', '#1baf7a', '#eb6834', '#4a3aa7', '#9ec5e8'];
import { isolateFromMap } from './mapView';
import { colorAt, cssGradient, parseColor, rsrpScale, RXLEV_SCALE, SINR_SCALE, THR_SCALE, type Scale } from './colors';
import type { HeatmapProgress, HeatmapRequest, HeatmapResult } from './heatmap.worker';

/** Extra margin rendered outside the viewport so small pans don't show gaps. */
const PAD = 0.15;

export class HeatmapLayer {
  private worker: Worker;
  private overlay: L.ImageOverlay | null = null;
  private gen = 0;
  private result: HeatmapResult | null = null;
  private resultGrid: { lats: Float64Array; lngs: Float64Array } | null = null;
  private ctx: RadioContext | null = null;
  private timer = 0;
  private legend: L.Control;
  private legendEl: HTMLDivElement;
  private readout: HTMLDivElement;
  busy = false;
  lastMs = 0;
  onStatus: (busy: boolean, ms: number) => void = () => {};
  loadsProvider: () => Float32Array | null = () => null;

  constructor(
    private map: L.Map,
    private store: Store,
  ) {
    this.worker = new Worker(new URL('./heatmap.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<HeatmapResult | HeatmapProgress>) => {
      if ('progress' in e.data) this.showProgress(e.data);
      else this.onResult(e.data);
    };
    // Small "updating" pill on the map while a job runs (only if it takes a moment).
    this.busyEl = L.DomUtil.create('div', 'hm-busy', map.getContainer());
    this.busyEl.style.display = 'none';
    this.worker.onerror = () => {
      // Never stay "busy" forever: a failed job must not block every later one.
      this.busy = false;
      this.onStatus(false, this.lastMs);
      this.setBusyUi(null, null);
    };

    this.legendEl = L.DomUtil.create('div', 'legend');
    isolateFromMap(this.legendEl);
    const Legend = L.Control.extend({ onAdd: () => this.legendEl });
    this.legend = new Legend({ position: 'bottomright' });
    this.legend.addTo(map);
    // Floating panels (station / user inspectors) stop above the legend: expose the space it takes.
    const reserve = () => this.reserveLegendSpace();
    new ResizeObserver(reserve).observe(this.legendEl);
    map.on('resize', reserve);
    window.addEventListener('resize', reserve);

    this.readout = L.DomUtil.create('div', 'readout', map.getContainer());
    this.readout.style.display = 'none';
    map.on('mousemove', (e: L.LeafletMouseEvent) => this.showReadout(e));
    map.on('mouseout', () => (this.readout.style.display = 'none'));
    map.on('moveend', () => this.schedule(150));
  }

  setContext(ctx: RadioContext) {
    this.ctx = ctx;
    this.schedule(50);
  }

  /** Debounced recompute. */
  schedule(delay = 100) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.compute(), delay);
  }

  /** Re-colour without recomputing (layer kind / opacity changes). */
  redraw() {
    if (this.store.layers.heatmap === 'none') {
      this.overlay?.remove();
      this.overlay = null;
      this.renderLegend();
      return;
    }
    if (this.result && this.resultGrid) this.paint();
    else this.schedule(0);
  }

  /**
   * Start a job for the current view. Progressive: a coarse pass (4× the cell size, ~16× fewer
   * points) covers the whole view quickly, then the full-resolution pass replaces it. Only one
   * job runs at a time; moves during a job just mark the map dirty, and the latest view is
   * computed when it finishes (no backlog of jobs for views already left).
   */
  private compute(stage: 'coarse' | 'fine' = 'coarse') {
    const lay = this.store.layers;
    if (lay.heatmap === 'none' || !this.ctx) {
      this.redraw();
      return;
    }
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    const size = this.map.getSize();
    if (size.x < 2 || size.y < 2) return;
    const fineRes = Math.max(2, lay.resolutionPx);
    const coarseRes = Math.max(fineRes * 4, 12);
    if (stage === 'coarse' && coarseRes >= 16 && fineRes >= 16) stage = 'fine';
    const res = stage === 'coarse' ? coarseRes : fineRes;
    const x0 = -size.x * PAD;
    const y0 = -size.y * PAD;
    const cols = Math.ceil((size.x * (1 + 2 * PAD)) / res);
    const rows = Math.ceil((size.y * (1 + 2 * PAD)) / res);
    const lngs = new Float64Array(cols);
    const lats = new Float64Array(rows);
    for (let i = 0; i < cols; i++) lngs[i] = this.map.containerPointToLatLng([x0 + (i + 0.5) * res, 0]).lng;
    for (let j = 0; j < rows; j++) lats[j] = this.map.containerPointToLatLng([0, y0 + (j + 0.5) * res]).lat;
    const scn = this.store.scenario;
    const opIdx = lay.operatorFilter === 'all' ? -1 : scn.operators.findIndex((o) => o.id === lay.operatorFilter);
    const th = scn.settings.thresholds;
    // Send the building path maps only when they changed (see heatmap.worker.ts).
    let ctx = this.ctx;
    if (ctx.paths) {
      if (ctx.paths.version === this.sentPathsVersion) ctx = { ...ctx, paths: { loss: [], cond: [], version: ctx.paths.version } };
      else this.sentPathsVersion = ctx.paths.version;
    }
    // Same for the indoor footprint mask.
    if (ctx.indoor) {
      if (ctx.indoor.version === this.sentIndoorVersion) ctx = { ...ctx, indoor: { ...ctx.indoor, mask: new Uint8Array(0) } };
      else this.sentIndoorVersion = ctx.indoor.version;
    }
    const req: HeatmapRequest = {
      gen: ++this.gen,
      ctx,
      radio: scn.settings.radio,
      lats,
      lngs,
      op: opIdx,
      tech: lay.techFilter === 'all' ? null : lay.techFilter,
      loads: scn.settings.radio.interferenceLoad === 'full' ? null : this.loadsProvider(),
      minRx: { GSM: th.GSM.minRxDbm, LTE: th.LTE.minRxDbm, NR: th.NR.minRxDbm },
      ueRx: { GSM: 1, LTE: scn.settings.users.ueRxLte, NR: scn.settings.users.ueRxNr },
    };
    this.pending = {
      stage,
      lats,
      lngs,
      bounds: L.latLngBounds(this.map.containerPointToLatLng([x0, y0]), this.map.containerPointToLatLng([x0 + cols * res, y0 + rows * res])),
    };
    this.busy = true;
    this.onStatus(true, this.lastMs);
    this.setBusyUi(stage, null);
    this.worker.postMessage(req);
  }

  private pending: { stage: 'coarse' | 'fine'; lats: Float64Array; lngs: Float64Array; bounds: L.LatLngBounds } | null = null;
  /** The view changed while a job was running: compute it when the job is done. */
  private dirty = false;
  private sentPathsVersion = -1;
  private sentIndoorVersion = -1;
  private bounds: L.LatLngBounds | null = null;

  private onResult(r: HeatmapResult) {
    if (r.gen !== this.gen || !this.pending) return; // stale
    this.result = r;
    this.resultGrid = { lats: this.pending.lats, lngs: this.pending.lngs };
    this.bounds = this.pending.bounds;
    this.busy = false;
    const coarse = this.pending.stage === 'coarse';
    this.paint();
    if (this.dirty) this.compute('coarse'); // the view moved meanwhile: start over for it
    else if (coarse) this.compute('fine');
    else {
      this.lastMs = r.ms;
      this.onStatus(false, r.ms);
      this.setBusyUi(null, null);
    }
  }

  private busyEl: HTMLDivElement;
  private busyTimer = 0;
  private busyShown = false;

  private showProgress(p: HeatmapProgress) {
    if (p.gen === this.gen && this.busy) this.setBusyUi(this.pending?.stage ?? 'fine', p.progress);
  }

  /** stage null = done. Shown only after 250 ms, so quick updates never flash it. */
  private setBusyUi(stage: 'coarse' | 'fine' | null, progress: number | null) {
    if (stage === null) {
      clearTimeout(this.busyTimer);
      this.busyTimer = 0;
      this.busyShown = false;
      this.busyEl.style.display = 'none';
      return;
    }
    const names: Record<string, string> = { rsrp: 'signal', server: 'best server', sinr: 'SINR', throughput: 'throughput', modulation: 'modulation', condition: 'propagation' };
    const what = names[this.store.layers.heatmap] ?? 'coverage';
    const pct = progress === null ? '' : ` · ${Math.round(progress * 100)}%`;
    this.busyEl.innerHTML = `<span class="hm-spin"></span>${stage === 'coarse' ? `Updating ${what} map…` : `Refining ${what} map${pct}`}<i style="width:${progress === null ? 0 : Math.round(progress * 100)}%"></i>`;
    if (this.busyShown) return;
    if (!this.busyTimer) this.busyTimer = window.setTimeout(() => {
      this.busyTimer = 0;
      if (!this.busy) return;
      this.busyShown = true;
      this.busyEl.style.display = '';
    }, 250);
  }

  scale(kind: HeatmapKind = this.store.layers.heatmap): Scale | null {
    if (kind === 'rsrp') return this.store.layers.techFilter === 'GSM' ? RXLEV_SCALE : rsrpScale(this.store.layers.rsrpPalette, this.store.layers.rsrpSmooth);
    if (kind === 'sinr') return SINR_SCALE;
    if (kind === 'throughput') return THR_SCALE;
    return null;
  }

  private paint() {
    const r = this.result!;
    const kind = this.store.layers.heatmap;
    if (kind === 'none') return;
    const canvas = document.createElement('canvas');
    canvas.width = r.cols;
    canvas.height = r.rows;
    const g = canvas.getContext('2d')!;
    const img = g.createImageData(r.cols, r.rows);
    const px = img.data;
    const scale = this.scale(kind);
    const cellRgb = this.ctx ? this.ctx.cells.map((c) => parseColor(c.color)) : [];
    const modRgb = MODULATIONS.map((m) => parseColor(m.color));
    const condRgb = COND_COLORS.map((c) => parseColor(c));
    for (let k = 0; k < r.cols * r.rows; k++) {
      const srv = r.server[k];
      let rgb: [number, number, number] | null = null;
      if (kind === 'rsrp') {
        const v = r.rsrp[k];
        if (v > -Infinity && v >= scale!.stops[0].v - (scale!.classes ? 0 : 10)) rgb = colorAt(scale!, v);
      } else if (srv >= 0) {
        if (kind === 'server') rgb = cellRgb[srv] ?? null;
        else if (kind === 'sinr') rgb = colorAt(scale!, r.sinr[k]);
        else if (kind === 'throughput') rgb = r.thr[k] > 0 ? colorAt(scale!, r.thr[k]) : null;
        else if (kind === 'modulation') rgb = r.mod[k] >= 0 ? modRgb[r.mod[k]] : null;
        else if (kind === 'condition') rgb = r.cond[k] ? condRgb[r.cond[k]] : null;
      }
      if (!rgb) continue;
      const o = k * 4;
      px[o] = rgb[0];
      px[o + 1] = rgb[1];
      px[o + 2] = rgb[2];
      px[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const url = canvas.toDataURL();
    const opacity = this.store.layers.opacity;
    if (!this.overlay) {
      this.overlay = L.imageOverlay(url, this.bounds!, { opacity, interactive: false, className: 'heatmap-img', pane: 'heatmapPane' }).addTo(this.map);
    } else {
      this.overlay.setUrl(url);
      this.overlay.setBounds(this.bounds!);
      this.overlay.setOpacity(opacity);
    }
    this.renderLegend();
  }

  setOpacity(o: number) {
    this.overlay?.setOpacity(o);
  }

  /** Space the legend takes at the bottom of the map, as --legend-space for the floating inspectors. */
  private reserveLegendSpace() {
    const container = this.map.getContainer();
    const shown = this.legendEl.style.display !== 'none' && this.legendEl.offsetHeight > 0;
    const space = shown ? container.getBoundingClientRect().bottom - this.legendEl.getBoundingClientRect().top : 0;
    container.style.setProperty('--legend-space', `${Math.max(0, Math.round(space))}px`);
  }

  private renderLegend() {
    this.renderLegendContent();
    this.reserveLegendSpace();
  }

  private renderLegendContent() {
    const kind = this.store.layers.heatmap;
    const el = this.legendEl;
    el.innerHTML = '';
    if (kind === 'none') {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const lay = this.store.layers;
    // Nothing matches the filter: say so instead of drawing an empty map.
    const stations = this.store.scenario.stations.filter((s) => s.enabled);
    if (stations.length && !stations.some((s) => this.store.isVisible(s))) {
      const opName = lay.operatorFilter === 'all' ? 'any operator' : (this.store.scenario.operators.find((o) => o.id === lay.operatorFilter)?.name ?? '?');
      const head = document.createElement('div');
      head.className = 'legend-title';
      head.textContent = `No ${lay.techFilter === 'all' ? '' : lay.techFilter + ' '}cells for ${opName}`;
      const note = document.createElement('div');
      note.className = 'legend-note';
      note.textContent = 'The coverage layer is filtered (Layers → Operator / Technology).';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.style.marginTop = '6px';
      btn.textContent = 'Show all operators & RATs';
      btn.onclick = () => this.store.showAllLayers();
      el.append(head, note, btn);
      return;
    }
    if (!stations.length) {
      el.innerHTML = '<div class="legend-title">No stations on air</div><div class="legend-note">Add sites in the Network tab.</div>';
      return;
    }
    const op = lay.operatorFilter === 'all' ? 'All operators' : (this.store.scenario.operators.find((o) => o.id === lay.operatorFilter)?.name ?? '');
    const tech = lay.techFilter === 'all' ? 'all RATs' : lay.techFilter;
    const head = document.createElement('div');
    head.className = 'legend-title';
    const scale = this.scale(kind);
    const us = this.store.scenario.settings.users;
    head.textContent =
      kind === 'server' ? `Best server · ${op} · ${tech}`
      : kind === 'modulation' ? `Modulation reached · ${op} · ${tech} (${us.ueRxLte}Rx LTE / ${us.ueRxNr}Rx NR UE)`
      : kind === 'condition' ? `Propagation condition · ${op} · ${tech}`
      : `${scale!.title} (${scale!.unit}) · ${op} · ${tech}`;
    el.appendChild(head);
    if (scale) {
      const bar = document.createElement('div');
      bar.className = 'legend-bar';
      bar.style.background = cssGradient(scale);
      el.appendChild(bar);
      const ticks = document.createElement('div');
      ticks.className = 'legend-ticks';
      const lo = scale.stops[0].v;
      const hi = scale.stops[scale.stops.length - 1].v;
      // Classes: a label at every colour boundary, on the legend's equal-width bands.
      const tickVals = scale.classes ? scale.stops.map((x) => x.v) : scale.ticks;
      for (const [k, t] of tickVals.entries()) {
        const s = document.createElement('span');
        const pos = scale.classes ? k / (tickVals.length - 1) : ((scale.axis ? scale.axis(t) : t) - lo) / (hi - lo);
        s.style.left = `${(pos * 100).toFixed(1)}%`;
        s.textContent = String(t);
        ticks.appendChild(s);
      }
      el.appendChild(ticks);
    } else if (kind === 'condition' && !this.ctx?.paths && !this.ctx?.indoor) {
      // Nothing to draw: explain why and offer the fix instead of an empty map.
      const wi = this.store.scenario.settings.radio.model === 'cost231-wi';
      head.textContent = wi ? 'Propagation condition: no building data here' : 'Propagation condition needs the building model';
      const note = document.createElement('div');
      note.className = 'legend-note';
      note.textContent = wi
        ? 'Load OSM buildings for this area (Radio tab → Load OSM buildings for current view).'
        : 'No building footprints loaded (or entry loss set to None), so Hata cannot tell indoor from outdoor, and LOS / NLOS needs the building model. Load OSM buildings (Radio tab) or switch to COST-231 Walfisch–Ikegami + OSM buildings.';
      el.appendChild(note);
      if (!wi) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn primary';
        btn.style.marginTop = '6px';
        btn.textContent = 'Use building model';
        btn.onclick = () => this.store.useBuildingModel();
        el.appendChild(btn);
      }
    } else if (kind === 'condition') {
      const row = document.createElement('div');
      row.className = 'legend-cats';
      const cats: [number, string][] = this.ctx?.paths
        ? [[1, 'LOS (street canyon)'], [2, 'NLOS (blocked by buildings)'], [3, 'Indoor (+ entry loss)'], ...(this.ctx.indoor ? [[4, 'Outdoor, beyond traced paths (Hata)'] as [number, string]] : [])]
        : [[4, 'Outdoor (Hata)'], [3, 'Indoor (Hata + entry loss)']];
      cats.forEach(([k, label]) => {
        const s = document.createElement('span');
        const i = document.createElement('i');
        i.style.background = COND_COLORS[k];
        s.append(i, label);
        row.appendChild(s);
      });
      el.appendChild(row);
      const note = document.createElement('div');
      note.className = 'legend-note';
      note.textContent = this.ctx?.paths ? 'Path from the best server, traced through OSM buildings.' : 'Hata: inside an OSM building footprint = indoor (P.2109 entry loss added). For LOS / NLOS use the COST-231 Walfisch–Ikegami + OSM buildings model.';
      el.appendChild(note);
    } else if (kind === 'modulation') {
      const row = document.createElement('div');
      row.className = 'legend-cats';
      for (const m of MODULATIONS) {
        const s = document.createElement('span');
        const i = document.createElement('i');
        i.style.background = m.color;
        s.append(i, m.key === 'gmsk' ? 'GMSK' : m.label);
        row.appendChild(s);
      }
      el.appendChild(row);
      const note = document.createElement('div');
      note.className = 'legend-note';
      note.textContent = 'Per-layer modulation at the chosen MIMO rank, capped by each station’s max modulation.';
      el.appendChild(note);
    } else {
      const note = document.createElement('div');
      note.className = 'legend-note';
      note.textContent = 'Colours match cell sectors on the map. Uncoloured = below camping threshold.';
      el.appendChild(note);
    }
  }

  private showReadout(e: L.LeafletMouseEvent) {
    const r = this.result;
    const grid = this.resultGrid;
    if (!r || !grid || this.store.layers.heatmap === 'none' || !this.ctx) {
      this.readout.style.display = 'none';
      return;
    }
    const col = nearestIndex(grid.lngs, e.latlng.lng);
    const row = nearestIndex(grid.lats, e.latlng.lat);
    if (col < 0 || row < 0) {
      this.readout.style.display = 'none';
      return;
    }
    const k = row * r.cols + col;
    const srv = r.server[k];
    const cell = srv >= 0 ? this.ctx.cells[srv] : null;
    const rs = r.rsrp[k];
    const level = this.store.layers.techFilter === 'GSM' ? 'RxLev' : 'Level';
    // Line 1: the radio at this point; line 2: the cell serving it and what it gives.
    const line1 = [`${level} ${rs > -Infinity ? rs.toFixed(1) + ' dBm' : '—'}`];
    const line2: string[] = [];
    if (cell) {
      line1.push(`SINR ${r.sinr[k].toFixed(1)} dB`);
      if (r.cond[k]) line1.push(PATH_COND_LABEL[r.cond[k]]);
      line2.push(`${cell.name} (${cell.tech}, PCI ${cell.pci})`);
      if (cell.tech !== 'GSM') {
        // The map assumes a typical phone, not any particular user (see Users → Rx antennas).
        const us = this.store.scenario.settings.users;
        const m = r.mod[k] >= 0 ? MODULATIONS[r.mod[k]].label : '—';
        line2.push(`${m} · peak ${r.thr[k].toFixed(1)} Mbps (${cell.tech === 'NR' ? us.ueRxNr : us.ueRxLte}Rx UE)`);
      }
    } else line1.push('no service');
    this.readout.textContent = line1.join(' · ') + (line2.length ? '\n' + line2.join(' · ') : '');
    this.readout.style.display = '';
    this.readout.style.left = `${e.containerPoint.x + 14}px`;
    this.readout.style.top = `${e.containerPoint.y + 14}px`;
  }
}

/** Index of the nearest element in a monotonic array, or -1 if outside. */
function nearestIndex(a: Float64Array, v: number): number {
  const n = a.length;
  if (n < 2) return -1;
  const asc = a[1] > a[0];
  const step = Math.abs(a[1] - a[0]);
  const i = Math.round((asc ? v - a[0] : a[0] - v) / step);
  return i >= 0 && i < n ? i : -1;
}

