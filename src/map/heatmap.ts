import L from 'leaflet';
import type { RadioContext } from '../radio/cells';
import type { HeatmapKind, Store } from '../state/store';
import { colorAt, cssGradient, parseColor, RSRP_SCALE, RXLEV_SCALE, SINR_SCALE, THR_SCALE, type Scale } from './colors';
import type { HeatmapRequest, HeatmapResult } from './heatmap.worker';

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
    this.worker.onmessage = (e: MessageEvent<HeatmapResult>) => this.onResult(e.data);

    this.legendEl = L.DomUtil.create('div', 'legend');
    const Legend = L.Control.extend({ onAdd: () => this.legendEl });
    this.legend = new Legend({ position: 'bottomright' });
    this.legend.addTo(map);

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

  private compute() {
    const lay = this.store.layers;
    if (lay.heatmap === 'none' || !this.ctx) {
      this.redraw();
      return;
    }
    const size = this.map.getSize();
    if (size.x < 2 || size.y < 2) return;
    const res = Math.max(2, lay.resolutionPx);
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
    const req: HeatmapRequest = {
      gen: ++this.gen,
      ctx: this.ctx,
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
      lats,
      lngs,
      bounds: L.latLngBounds(this.map.containerPointToLatLng([x0, y0]), this.map.containerPointToLatLng([x0 + cols * res, y0 + rows * res])),
    };
    this.busy = true;
    this.onStatus(true, this.lastMs);
    this.worker.postMessage(req);
  }

  private pending: { lats: Float64Array; lngs: Float64Array; bounds: L.LatLngBounds } | null = null;
  private bounds: L.LatLngBounds | null = null;

  private onResult(r: HeatmapResult) {
    if (r.gen !== this.gen || !this.pending) return; // stale
    this.result = r;
    this.resultGrid = { lats: this.pending.lats, lngs: this.pending.lngs };
    this.bounds = this.pending.bounds;
    this.busy = false;
    this.lastMs = r.ms;
    this.onStatus(false, r.ms);
    this.paint();
  }

  scale(kind: HeatmapKind = this.store.layers.heatmap): Scale | null {
    if (kind === 'rsrp') return this.store.layers.techFilter === 'GSM' ? RXLEV_SCALE : RSRP_SCALE;
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
    for (let k = 0; k < r.cols * r.rows; k++) {
      const srv = r.server[k];
      let rgb: [number, number, number] | null = null;
      if (kind === 'rsrp') {
        const v = r.rsrp[k];
        if (v > -Infinity && v >= (scale!.stops[0].v as number) - 10) rgb = colorAt(scale!, v);
      } else if (srv >= 0) {
        if (kind === 'server') rgb = cellRgb[srv] ?? null;
        else if (kind === 'sinr') rgb = colorAt(scale!, r.sinr[k]);
        else if (kind === 'throughput') rgb = r.thr[k] > 0 ? colorAt(scale!, r.thr[k]) : null;
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

  private renderLegend() {
    const kind = this.store.layers.heatmap;
    const el = this.legendEl;
    el.innerHTML = '';
    if (kind === 'none') {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const lay = this.store.layers;
    const op = lay.operatorFilter === 'all' ? 'All operators' : (this.store.scenario.operators.find((o) => o.id === lay.operatorFilter)?.name ?? '');
    const tech = lay.techFilter === 'all' ? 'all RATs' : lay.techFilter;
    const head = document.createElement('div');
    head.className = 'legend-title';
    const scale = this.scale(kind);
    head.textContent = kind === 'server' ? `Best server · ${op} · ${tech}` : `${scale!.title} (${scale!.unit}) · ${op} · ${tech}`;
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
      for (const t of scale.ticks) {
        const s = document.createElement('span');
        const pos = ((scale.axis ? scale.axis(t) : t) - lo) / (hi - lo);
        s.style.left = `${(pos * 100).toFixed(1)}%`;
        s.textContent = String(t);
        ticks.appendChild(s);
      }
      el.appendChild(ticks);
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
    const parts = [`${level} ${rs > -Infinity ? rs.toFixed(1) + ' dBm' : '—'}`];
    if (cell) {
      parts.push(`SINR ${r.sinr[k].toFixed(1)} dB`, `${cell.name} (${cell.tech}, PCI ${cell.pci})`);
      if (cell.tech !== 'GSM') {
        // The map assumes a typical phone, not any particular user (see Users → Rx antennas).
        const us = this.store.scenario.settings.users;
        parts.push(`peak ${r.thr[k].toFixed(1)} Mbps (${cell.tech === 'NR' ? us.ueRxNr : us.ueRxLte}Rx UE)`);
      }
    } else parts.push('no service');
    this.readout.textContent = parts.join(' · ');
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

