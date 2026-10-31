import { BarController, BarElement, CategoryScale, Chart, Filler, Legend, LinearScale, LineController, LineElement, LogarithmicScale, PointElement, Tooltip, type ChartConfiguration } from 'chart.js';
import type { SimUser } from '../sim/engine';
import { EVENT_COLOR, EVENT_LABEL, EVENT_TYPES, percentile, TIMELINE_BUCKET_S, type SimEvent, type SimEventType } from '../sim/kpi';
import { jainIndex, SCHEDULERS, schedulerInfo } from '../sim/scheduler';
import type { App } from './app';
import { clear, fmt, h } from './dom';

Chart.register(LineController, LineElement, PointElement, LinearScale, LogarithmicScale, CategoryScale, BarController, BarElement, Legend, Tooltip, Filler);

/** Throughput CDF x-axis floor, Mbps (log scale can't show 0; such users sit at the floor). */
const THR_CDF_MIN = 0.01;
Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
Chart.defaults.font.size = 10;
Chart.defaults.color = '#52514e';
Chart.defaults.animation = false;

/** Reference categorical palette, fixed slot order (validated for CVD separation). */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
const GRID = '#e8e7e3';

const TIMELINE_TYPES: SimEventType[] = ['HO', 'HO_IRAT', 'HO_FAIL', 'PING_PONG', 'DROP', 'BLOCK'];

function lineChart(canvas: HTMLCanvasElement, labels: string[], yTitle: string, yMin?: number, yMax?: number): Chart<'line'> {
  const cfg: ChartConfiguration<'line'> = {
    type: 'line',
    data: { datasets: labels.map((l, i) => ({ label: l, data: [], borderColor: SERIES[i], backgroundColor: SERIES[i], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 })) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: labels.length > 1, position: 'top', align: 'start', labels: { boxWidth: 10, boxHeight: 2 } }, tooltip: { callbacks: { title: (it) => `t = ${fmtTime(it[0].parsed.x ?? 0)}` } } },
      scales: {
        x: { type: 'linear', grid: { color: GRID }, ticks: { callback: (v) => fmtTime(+v), maxTicksLimit: 6 } },
        y: { min: yMin, max: yMax, grid: { color: GRID }, title: { display: true, text: yTitle } },
      },
    },
  };
  return new Chart(canvas, cfg);
}

/** Mbps with sensible precision across kbit/s … Gbit/s. */
export function fmtMbps(v: number): string {
  if (v < 1) return `${(v * 1000).toFixed(0)} kbps`;
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} Mbps`;
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- scopes

/** What the KPI panel shows: the whole network, one site (all its sectors), or one sector. */
type Scope = { kind: 'network' } | { kind: 'site'; bsId: string } | { kind: 'cell'; bsId: string; sectorId: string };

/** One second of statistics for the current scope. */
interface Row {
  t: number;
  voice: number;
  data: number;
  camped: number;
  meanThr: number;
  p5Thr: number;
  sinr: number;
  served: number;
  demand: number;
  capacity: number;
  /** PRB (TCH) utilisation, 0..1. */
  util: number;
  byTech?: { GSM: number; LTE: number; NR: number };
  /** Network only: throughput carried by Wi-Fi APs, Mbps, and sessions over Wi-Fi. */
  wifi?: number;
  wifiSessions?: number;
}

interface ScopeView {
  title: string;
  rows: Row[];
  /** Cell indices in the scope (all cells for the network). */
  cells: number[];
  users: SimUser[];
  /** For filtering events by cell name; null = no filter. */
  cellNames: Set<string> | null;
}

export function kpiPanel(app: App): HTMLElement {
  const { engine, store } = app;
  let scope: Scope = { kind: 'network' };
  const scopeBar = h('div', { class: 'scope-bar' });
  const tiles = h('div', { class: 'tiles' });
  const mk = () => h('canvas');
  const cSessions = mk();
  const cRat = mk();
  const cThr = mk();
  const cSinr = mk();
  const cCap = mk();
  const cUtil = mk();
  const cEvents = mk();
  const cLoad = mk();
  const cCdf = mk();
  const cThrCdf = mk();
  const cWifi = mk();
  const wifiTitle = h('div', { class: 'chart-title', title: 'Served DL throughput carried by the cellular cells and by the Wi-Fi APs (whole network)' }, 'Data traffic: cellular vs Wi-Fi (Mbps)');
  const wifiBox = h('div', { class: 'chart-box' }, wifiTitle, h('div', { class: 'chart-wrap' }, cWifi));
  const ratTitle = h('div', { class: 'chart-title' }, 'Users by serving RAT');
  const loadTitle = h('div', { class: 'chart-title' }, 'Most loaded cells (PRB / TCH utilisation)');
  const thrCdfTitle = h('div', { class: 'chart-title' }, 'DL throughput distribution of active data users (CDF)');
  // View: live served vs. demand, or a what-if comparison of all schedulers.
  let compare = false;
  let fullBuffer = false;
  try {
    compare = localStorage.getItem('radio-sim.cdf-compare') === '1';
    fullBuffer = localStorage.getItem('radio-sim.cdf-fullbuffer') === '1';
  } catch {
    /* ignore */
  }
  const fbBox = h('input', { type: 'checkbox', checked: fullBuffer, onchange: () => {
    fullBuffer = fbBox.checked;
    try {
      localStorage.setItem('radio-sim.cdf-fullbuffer', fullBuffer ? '1' : '0');
    } catch {
      /* ignore */
    }
    update();
  } });
  const fbField = h('label', { class: 'field check', title: 'Every data user wants as much as it can get, so schedulers differ at any load (the standard way to compare them)' }, fbBox, h('span', null, 'Full buffer (every data user wants maximum throughput)'));
  const cmpWarn = h('div', { class: 'callout' });
  const cmpTable = h('div', { class: 'cmp-table' });
  const cmpNote = h('div', { class: 'hint' }, 'What-if on the current snapshot: the same LTE/NR users, positions, SINR and demands, as if every LTE/NR cell in the scope used each scheduler (GSM users get a fixed GPRS slot and are left out). Fairness is Jain per cell over throughput ÷ demand, or over throughput with full buffer.');
  const modeChips = h('div', { class: 'chips' });
  const renderModeChips = () => {
    clear(modeChips);
    for (const [on, label] of [[false, 'Served vs demand'], [true, 'Compare schedulers']] as [boolean, string][]) {
      modeChips.appendChild(h('button', { type: 'button', class: `chip ${compare === on ? 'on' : ''}`, style: `--c:${on ? SERIES[2] : SERIES[0]}`, onclick: () => {
        compare = on;
        try {
          localStorage.setItem('radio-sim.cdf-compare', on ? '1' : '0');
        } catch {
          /* ignore */
        }
        renderModeChips();
        update();
      } }, label));
    }
    cmpTable.style.display = compare ? '' : 'none';
    cmpNote.style.display = compare ? '' : 'none';
    fbField.style.display = compare ? '' : 'none';
    if (!compare) cmpWarn.style.display = 'none';
  };
  const box = (title: string | HTMLElement, c: HTMLCanvasElement, tall = false, hint?: string) =>
    h('div', { class: `chart-box ${tall ? 'tall' : ''}` }, typeof title === 'string' ? h('div', { class: 'chart-title', title: hint }, title) : title, h('div', { class: 'chart-wrap' }, c));

  const logList = h('div', { class: 'log-list' });
  const logTitle = h('div', { class: 'chart-title' }, 'Event log (newest first, click to locate)');
  const enabled = new Set<SimEventType>(EVENT_TYPES.filter((t) => t !== 'CALL_START' && t !== 'CALL_END' && t !== 'SCELL_ADD' && t !== 'SCELL_REMOVE'));
  const chips = h('div', { class: 'chips' },
    ...EVENT_TYPES.map((t) => {
      const chip = h('button', { type: 'button', class: `chip ${enabled.has(t) ? 'on' : ''}`, style: `--c:${EVENT_COLOR[t]}`, onclick: () => {
        if (enabled.has(t)) enabled.delete(t);
        else enabled.add(t);
        chip.classList.toggle('on', enabled.has(t));
        renderLog(true);
      } }, EVENT_LABEL[t]);
      return chip;
    }),
  );

  const root = h('div', { class: 'kpi' },
    scopeBar,
    tiles,
    h('div', { class: 'charts' },
      box('Active sessions', cSessions),
      h('div', { class: 'chart-box' }, ratTitle, h('div', { class: 'chart-wrap' }, cRat)),
      box('User DL throughput (Mbps)', cThr),
      box('Mean SINR of camped users (dB)', cSinr),
      box('Throughput vs capacity (Mbps)', cCap, false, 'Capacity: all RBs (× MU-MIMO gain) at the mean rate per RB of the current users; GSM: all traffic channels as GPRS slots'),
      box('Utilisation (%)', cUtil, false, 'PRB (GSM: TCH) utilisation, and served throughput ÷ capacity'),
      wifiBox,
      box(`Event timeline (per ${TIMELINE_BUCKET_S} s)`, cEvents, true),
      h('div', { class: 'chart-box tall' }, loadTitle, h('div', { class: 'chart-wrap' }, cLoad)),
      box('SINR distribution of camped users (CDF)', cCdf),
      h('div', { class: 'chart-box tall' }, thrCdfTitle, modeChips, fbField, h('div', { class: 'chart-wrap' }, cThrCdf), cmpWarn, cmpNote, cmpTable),
    ),
    h('div', { class: 'log' }, logTitle, chips, logList),
  );

  const sessions = lineChart(cSessions, ['Voice', 'Data'], 'sessions', 0);
  const rat = lineChart(cRat, ['GSM', 'LTE', 'NR'], 'users', 0);
  const thr = lineChart(cThr, ['Mean', 'Cell edge (5th pct)'], 'Mbps', 0);
  const sinr = lineChart(cSinr, ['Mean SINR'], 'dB');
  const cap = lineChart(cCap, ['Served', 'Demand', 'Capacity'], 'Mbps', 0);
  cap.data.datasets[1].borderDash = [5, 4];
  const util = lineChart(cUtil, ['PRB / TCH utilisation', 'Throughput utilisation'], '%', 0, 100);
  const wifiChart = lineChart(cWifi, ['Cellular', 'Wi-Fi'], 'Mbps', 0);
  wifiChart.data.datasets[1].borderColor = wifiChart.data.datasets[1].backgroundColor = '#7b5cd6';

  const events = new Chart<'bar', number[], string>(cEvents, {
    type: 'bar',
    data: { labels: [], datasets: TIMELINE_TYPES.map((t, i) => ({ label: EVENT_LABEL[t], data: [], backgroundColor: SERIES[i], borderColor: '#fcfcfb', borderWidth: { top: 1, bottom: 0, left: 0, right: 0 }, borderRadius: 2, borderSkipped: 'bottom' })) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'start', labels: { boxWidth: 10, boxHeight: 10 } } },
      scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { stacked: true, grid: { color: GRID }, title: { display: true, text: 'events' }, beginAtZero: true } },
    },
  });

  const load = new Chart<'bar', number[], string>(cLoad, {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Load', data: [], backgroundColor: SERIES[0], borderRadius: 4, borderSkipped: 'start', barPercentage: 0.8 }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => `${(it.parsed.x ?? 0).toFixed(0)}% load` } } },
      scales: { x: { min: 0, max: 100, grid: { color: GRID }, ticks: { callback: (v) => `${v}%` } }, y: { grid: { display: false }, ticks: { autoSkip: false } } },
    },
  });

  const cdf = new Chart<'line', { x: number; y: number }[]>(cCdf, {
    type: 'line',
    data: { datasets: [{ label: 'CDF', data: [], borderColor: SERIES[0], borderWidth: 2, pointRadius: 0, stepped: true }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (it) => `SINR ≤ ${(it[0].parsed.x ?? 0).toFixed(1)} dB`, label: (it) => `${(+(it.parsed.y ?? 0)).toFixed(0)}% of users` } } },
      scales: { x: { type: 'linear', min: -10, max: 35, grid: { color: GRID }, title: { display: true, text: 'SINR (dB)' } }, y: { min: 0, max: 100, grid: { color: GRID }, ticks: { callback: (v) => `${v}%` } } },
    },
  });

  const thrCdf = new Chart<'line', { x: number; y: number }[]>(cThrCdf, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: { position: 'top', align: 'start', labels: { boxWidth: 10, boxHeight: 2 } },
        tooltip: { callbacks: {
          title: (it) => `${it[0].dataset.label} ≤ ${fmtMbps(it[0].parsed.x ?? 0)}`,
          label: (it) => `${(+(it.parsed.y ?? 0)).toFixed(0)}% of data users`,
        } },
      },
      scales: {
        x: { type: 'logarithmic', min: THR_CDF_MIN, grid: { color: GRID }, title: { display: true, text: 'DL throughput (Mbps, log scale)' }, ticks: { maxRotation: 0, autoSkip: false, callback: (v) => ([0.01, 0.1, 1, 10, 100, 1000, 10000].includes(+v) ? String(v) : '') } },
        y: { min: 0, max: 100, grid: { color: GRID }, ticks: { callback: (v) => `${v}%` } },
      },
    },
  });

  // ---------------------------------------------------------------- scope data

  /** Network rows from the engine's samples; site / cell rows merged from per-cell history by time. */
  const buildView = (): ScopeView => {
    const ctx = app.ctx();
    const bs = scope.kind === 'network' ? undefined : store.station(scope.bsId);
    if (scope.kind === 'network' || !bs) {
      if (scope.kind !== 'network') scope = { kind: 'network' };
      return {
        title: 'Network',
        cells: ctx.cells.map((_, i) => i),
        users: engine.users,
        cellNames: null,
        rows: engine.samples.map((p) => ({
          t: p.t,
          voice: p.activeVoice,
          data: p.activeData,
          camped: p.byTech.GSM + p.byTech.LTE + p.byTech.NR,
          meanThr: p.meanThrMbps,
          p5Thr: p.p5ThrMbps,
          sinr: p.meanSinrDb,
          served: p.servedMbps ?? 0,
          demand: p.demandMbps ?? 0,
          capacity: p.capacityMbps ?? 0,
          util: p.prbUtil ?? 0,
          byTech: p.byTech,
          wifi: p.wifiServedMbps ?? 0,
          wifiSessions: p.wifiSessions ?? 0,
        })),
      };
    }
    const sectorIds = scope.kind === 'cell' ? [scope.sectorId] : bs.sectors.map((s) => s.id);
    const cells = ctx.cells.map((c, i) => (sectorIds.includes(c.sectorId) ? i : -1)).filter((i) => i >= 0);
    const cellSet = new Set(cells);
    // Merge sector histories by sample time.
    const byT = new Map<number, Row & { loadW: number; resW: number; thrW: number; sinrW: number; p5Min: number }>();
    for (const sid of sectorIds) {
      for (const p of engine.cellHistory.get(sid) ?? []) {
        let r = byT.get(p.t);
        if (!r) byT.set(p.t, (r = { t: p.t, voice: 0, data: 0, camped: 0, meanThr: 0, p5Thr: 0, sinr: NaN, served: 0, demand: 0, capacity: 0, util: 0, loadW: 0, resW: 0, thrW: 0, sinrW: 0, p5Min: Infinity }));
        r.voice += p.voice;
        r.data += p.data;
        r.camped += p.camped;
        r.served += p.servedMbps;
        r.demand += p.demandMbps;
        r.capacity += p.capacityMbps;
        r.loadW += p.load * p.resources;
        r.resW += p.resources;
        r.thrW += p.meanThrMbps * p.data;
        if (p.data > 0) r.p5Min = Math.min(r.p5Min, p.p5ThrMbps);
        if (Number.isFinite(p.meanSinrDb)) {
          r.sinrW += p.meanSinrDb * p.camped;
        }
      }
    }
    const rows = [...byT.values()]
      .sort((a, b) => a.t - b.t)
      .map((r) => ({ ...r, util: r.resW ? r.loadW / r.resW : 0, meanThr: r.data ? r.thrW / r.data : 0, p5Thr: Number.isFinite(r.p5Min) ? r.p5Min : 0, sinr: r.camped ? r.sinrW / r.camped : NaN }));
    const secIdx = scope.kind === 'cell' ? bs.sectors.findIndex((s) => s.id === (scope as { sectorId: string }).sectorId) : -1;
    return {
      title: scope.kind === 'cell' ? `${bs.name} · S${secIdx + 1}` : `Site ${bs.name}`,
      cells,
      users: engine.users.filter((u) => cellSet.has(u.serving)),
      cellNames: new Set(cells.map((i) => ctx.cells[i].name)),
      rows,
    };
  };

  const renderScopeBar = () => {
    clear(scopeBar);
    const bsId = scope.kind === 'network' ? store.selectedStationId : scope.bsId;
    const bs = store.station(bsId);
    const ctx = app.ctx();
    const chip = (label: string, on: boolean, color: string, pick: () => void, title?: string) =>
      h('button', { type: 'button', class: `chip ${on ? 'on' : ''}`, style: `--c:${color}`, title, onclick: () => {
        pick();
        update();
      } }, label);
    scopeBar.append(h('span', { class: 'scope-lbl' }, 'KPIs for'), chip('Network', scope.kind === 'network', '#52514e', () => (scope = { kind: 'network' })));
    if (bs) {
      scopeBar.appendChild(chip(`Site ${bs.name}`, scope.kind === 'site', store.scenario.operators.find((o) => o.id === bs.operatorId)?.color ?? '#888', () => (scope = { kind: 'site', bsId: bs.id }), 'All sectors of the selected station'));
      bs.sectors.forEach((s, i) => {
        const c = ctx.cells.find((x) => x.sectorId === s.id);
        if (!c) return;
        scopeBar.appendChild(chip(`S${i + 1}`, scope.kind === 'cell' && scope.sectorId === s.id, c.color, () => (scope = { kind: 'cell', bsId: bs.id, sectorId: s.id }), `${c.name} · ${c.tech} · PCI ${c.pci}`));
      });
    } else scopeBar.appendChild(h('span', { class: 'hint' }, 'Select a station on the map for its KPIs'));
  };

  // ---------------------------------------------------------------- event log

  let lastSeq = -1;
  let lastLogScope = '';
  const inScope = (v: ScopeView, e: SimEvent) => !v.cellNames || (!!e.from && v.cellNames.has(e.from)) || (!!e.to && v.cellNames.has(e.to));
  const renderLog = (force = false, view?: ScopeView) => {
    const v = view ?? buildView();
    const evs = engine.log.events;
    const top = evs.length ? evs[evs.length - 1].seq : 0;
    const key = v.title;
    if (!force && top === lastSeq && key === lastLogScope) return;
    lastSeq = top;
    lastLogScope = key;
    logTitle.textContent = `Event log · ${v.title} (newest first, click to locate)`;
    clear(logList);
    let shown = 0;
    for (let i = evs.length - 1; i >= 0 && shown < 250; i--) {
      const e = evs[i];
      if (!enabled.has(e.type) || !inScope(v, e)) continue;
      shown++;
      logList.appendChild(
        h('div', { class: 'log-row', onclick: () => app.mapView.flashAt(e.lat, e.lng, EVENT_COLOR[e.type]) },
          h('span', { class: 't' }, fmtTime(e.t)),
          h('span', { class: 'ty', style: `--c:${EVENT_COLOR[e.type]}` }, EVENT_LABEL[e.type]),
          h('span', { class: 'u' }, `UE${e.userId}`),
          h('span', { class: 'cells' }, e.from && e.to ? `${e.from} → ${e.to}` : (e.from ?? e.to ?? '')),
          h('span', { class: 'd' }, e.detail),
        ),
      );
    }
    if (!shown) logList.appendChild(h('div', { class: 'hint' }, evs.length ? 'No events for this scope yet.' : 'No events yet. Press ▶ to start the simulation.'));
  };

  // ---------------------------------------------------------------- tiles

  const tile = (label: string, value: string, sub = '', title = '') => h('div', { class: 'tile', title }, h('div', { class: 'tv' }, value), h('div', { class: 'tl' }, label), sub ? h('div', { class: 'ts' }, sub) : null);
  const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '—');
  const pct0 = (x: number) => `${Math.round(x * 100)}%`;

  const renderTiles = (v: ScopeView) => {
    const last = v.rows[v.rows.length - 1];
    clear(tiles);
    if (scope.kind === 'network') {
      const k = engine.counters;
      const s = engine.samples[engine.samples.length - 1];
      const admitted = k.voiceStarted + k.dataStarted - k.blockedCapacity - k.blockedCoverage;
      tiles.append(
        tile('Users', String(engine.users.length), s ? `${s.activeVoice} voice · ${s.activeData} data` : ''),
        tile('Coverage', s ? `${(s.coverage * 100).toFixed(1)}%` : '—', 'users with a serving cell'),
        tile('HO success', pct(k.hoSuccess, k.hoAttempts), `${k.hoSuccess} of ${k.hoAttempts} · ${k.hoIrat} IRAT`),
        tile('Ping-pong', pct(k.pingPong, k.hoSuccess), `${k.pingPong} HOs`),
        tile('Drop rate', pct(k.dropped, admitted), `${k.dropped} of ${admitted} sessions`),
        tile('Block rate', pct(k.blockedCapacity + k.blockedCoverage, k.voiceStarted + k.dataStarted), `${k.blockedCoverage} coverage · ${k.blockedCapacity} capacity`),
        tile('Mean DL', s ? `${fmt(s.meanThrMbps)} Mbps` : '—', s ? `edge ${fmt(s.p5ThrMbps, 2)} Mbps` : ''),
        tile('Mean SINR', s ? `${fmt(s.meanSinrDb)} dB` : '—', 'camped users'),
        tile('Fairness', s && s.activeData ? fmt(s.fairness, 2) : '—', 'throughput ÷ demand, 1 = equal', 'Jain’s fairness index over data users’ satisfaction (throughput / demand)'),
        tile('PRB utilisation', last ? pct0(last.util) : '—', 'LTE/NR, RB-weighted'),
        tile('Throughput used', last && last.capacity ? pct0(last.served / last.capacity) : '—', last ? `${fmtMbps(last.served)} of ${fmtMbps(last.capacity)}` : '', 'Served DL ÷ estimated capacity of all cells'),
      );
      if (store.scenario.settings.ca.enabled) {
        tiles.append(tile('Carrier aggregation', s ? `${s.caUsers ?? 0} users` : '—', s ? `${fmtMbps(s.scellMbps ?? 0)} on SCells${last && last.served > 0 ? ` (${pct0((s.scellMbps ?? 0) / last.served)})` : ''}` : '', 'Data users with at least one secondary cell, and the DL throughput their SCells carry'));
      }
      if (store.scenario.settings.wifi.enabled && (store.scenario.wifi ?? []).length) {
        const w = last?.wifi ?? 0;
        tiles.append(
          tile('Wi-Fi offload', last && last.served + w > 0 ? pct0(w / (last.served + w)) : '—', `${fmtMbps(w)} over Wi-Fi`, 'Share of the served DL throughput carried by Wi-Fi APs'),
          tile('Wi-Fi users', s ? String(s.wifiUsers ?? 0) : '—', s ? `${s.wifiSessions ?? 0} sessions · ${k.wifiOffloads} offloaded · ${k.wifiFallbacks} back` : '', 'Phones associated to an AP; sessions carried over Wi-Fi; sessions moved to Wi-Fi and back to cellular since reset'),
        );
      }
      return;
    }
    // Site / sector: counters from the cells in scope.
    const sum = (f: (i: number) => number) => v.cells.reduce((a, i) => a + f(i), 0);
    const st = (i: number) => engine.cells[i];
    const hoIn = sum((i) => st(i).hoIn);
    const hoOut = sum((i) => st(i).hoOut);
    const drops = sum((i) => st(i).drops);
    const blocks = sum((i) => st(i).blocks);
    const started = sum((i) => st(i).started);
    const data = v.users.filter((u) => u.session?.kind === 'data');
    const sat = data.map((u) => Math.min(1, u.thrMbps / Math.max(u.session!.demandMbps, 1e-9)));
    const thrs = data.map((u) => u.thrMbps).sort((a, b) => a - b);
    const sinrs = v.users.map((u) => u.sinr).filter(Number.isFinite);
    const active = v.users.filter((u) => u.session).length;
    tiles.append(
      tile('Users', String(v.users.length), `${active} active · ${active - data.length} voice · ${data.length} data`, 'camped on the cells in scope'),
      tile('PRB utilisation', last ? pct0(last.util) : '—', v.cells.some((i) => app.ctx().cells[i].tech === 'GSM') ? 'TCH for GSM' : 'resource blocks in use'),
      tile('Throughput used', last && last.capacity ? pct0(last.served / last.capacity) : '—', last ? `${fmtMbps(last.served)} of ${fmtMbps(last.capacity)}` : '', 'Served DL ÷ estimated capacity'),
      tile('Demand served', last && last.demand ? pct0(Math.min(1, last.served / last.demand)) : '—', last ? `${fmtMbps(last.served)} of ${fmtMbps(last.demand)} asked` : ''),
      tile('Mean DL', thrs.length ? `${fmt(thrs.reduce((a, b) => a + b, 0) / thrs.length)} Mbps` : '—', thrs.length ? `edge ${fmt(percentile(thrs, 0.05), 2)} Mbps` : ''),
      tile('Mean SINR', sinrs.length ? `${fmt(sinrs.reduce((a, b) => a + b, 0) / sinrs.length)} dB` : '—', 'camped users'),
      tile('Handovers', `${hoIn} in · ${hoOut} out`, 'since reset'),
      tile('Drop rate', pct(drops, started + hoIn), `${drops} of ${started + hoIn} sessions`, 'Drops ÷ sessions handled (started here or handed in)'),
      tile('Block rate', pct(blocks, started + blocks), `${blocks} blocked`),
      tile('Fairness', sat.length > 1 ? fmt(jainIndex(sat), 2) : '—', 'throughput ÷ demand, 1 = equal'),
    );
  };

  // ---------------------------------------------------------------- update

  const update = () => {
    const v = buildView();
    renderScopeBar();
    renderTiles(v);
    const ctx = app.ctx();

    const series = (f: (r: Row) => number) => v.rows.map((r) => ({ x: r.t, y: f(r) }));
    sessions.data.datasets[0].data = series((r) => r.voice);
    sessions.data.datasets[1].data = series((r) => r.data);
    if (scope.kind === 'network') {
      ratTitle.textContent = 'Users by serving RAT';
      rat.data.datasets = ['GSM', 'LTE', 'NR'].map((t, i) => ({ label: t, data: series((r) => r.byTech?.[t as 'GSM'] ?? 0), borderColor: SERIES[i], backgroundColor: SERIES[i], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 }));
      rat.options.plugins!.legend!.display = true;
    } else {
      ratTitle.textContent = 'Users camped on the scope';
      rat.data.datasets = [{ label: 'Camped', data: series((r) => r.camped), borderColor: SERIES[0], backgroundColor: SERIES[0], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 }];
      rat.options.plugins!.legend!.display = false;
    }
    thr.data.datasets[0].data = series((r) => r.meanThr);
    thr.data.datasets[1].data = series((r) => r.p5Thr);
    sinr.data.datasets[0].data = series((r) => r.sinr);
    cap.data.datasets[0].data = series((r) => r.served);
    cap.data.datasets[1].data = series((r) => r.demand);
    cap.data.datasets[2].data = series((r) => r.capacity);
    util.data.datasets[0].data = series((r) => r.util * 100);
    util.data.datasets[1].data = series((r) => (r.capacity > 0 ? Math.min(100, (100 * r.served) / r.capacity) : 0));
    for (const c of [sessions, rat, thr, sinr, cap, util]) c.update('none');
    // Wi-Fi offload is a network-wide view (APs are not part of a site's cells).
    const showWifi = scope.kind === 'network' && (store.scenario.wifi ?? []).length > 0;
    wifiBox.style.display = showWifi ? '' : 'none';
    if (showWifi) {
      wifiChart.data.datasets[0].data = series((r) => r.served);
      wifiChart.data.datasets[1].data = series((r) => r.wifi ?? 0);
      const last = v.rows[v.rows.length - 1];
      const tot = last ? last.served + (last.wifi ?? 0) : 0;
      wifiTitle.textContent = `Data traffic: cellular vs Wi-Fi (Mbps)${tot > 0 ? ` · ${Math.round((100 * (last!.wifi ?? 0)) / tot)}% offloaded now` : ''}`;
      wifiChart.update('none');
    }

    // Timeline: last 60 buckets (scope: from the events touching its cells)
    const nowB = Math.floor(engine.t / TIMELINE_BUCKET_S);
    const startB = Math.max(0, nowB - 59);
    const labels: string[] = [];
    const rows = TIMELINE_TYPES.map(() => [] as number[]);
    let scoped: Map<number, Partial<Record<SimEventType, number>>> | null = null;
    if (v.cellNames) {
      scoped = new Map();
      for (const e of engine.log.events) {
        if (!inScope(v, e)) continue;
        const b = Math.floor(e.t / TIMELINE_BUCKET_S);
        if (b < startB) continue;
        const m = scoped.get(b) ?? {};
        m[e.type] = (m[e.type] ?? 0) + 1;
        scoped.set(b, m);
      }
    }
    for (let b = startB; b <= nowB; b++) {
      labels.push(fmtTime(b * TIMELINE_BUCKET_S));
      const counts = (scoped ?? engine.log.buckets).get(b) ?? {};
      TIMELINE_TYPES.forEach((t, i) => rows[i].push(counts[t] ?? 0));
    }
    events.data.labels = labels;
    rows.forEach((r, i) => (events.data.datasets[i].data = r));
    events.update('none');

    // Load: top 12 cells (network) or every cell in scope
    const ranked = (scope.kind === 'network' ? v.cells.filter((i) => engine.cells[i]?.load > 0).sort((a, b) => engine.cells[b].load - engine.cells[a].load).slice(0, 12) : v.cells);
    loadTitle.textContent = scope.kind === 'network' ? 'Most loaded cells (PRB / TCH utilisation)' : 'Cell load (PRB / TCH utilisation)';
    load.data.labels = ranked.map((i) => `${ctx.cells[i]?.name ?? i} (${ctx.cells[i]?.tech ?? ''})`);
    load.data.datasets[0].data = ranked.map((i) => (engine.cells[i]?.load ?? 0) * 100);
    load.update('none');

    // SINR CDF of camped users in scope
    const vals = v.users.filter((u) => u.serving >= 0 && Number.isFinite(u.sinr)).map((u) => u.sinr).sort((a, b) => a - b);
    cdf.data.datasets[0].data = vals.map((x, i) => ({ x: Math.max(-10, Math.min(35, x)), y: ((i + 1) / vals.length) * 100 }));
    cdf.update('none');

    // Throughput CDF of active data users: live served vs. demand, or all schedulers what-if
    const cdfPts = (xs: number[]) => [...xs].sort((a, b) => a - b).map((x, i, a) => ({ x: Math.max(THR_CDF_MIN, x), y: ((i + 1) / a.length) * 100 }));
    const dataUsers = v.users.filter((u) => u.session?.kind === 'data');
    const demandSet = { label: 'Demand', data: cdfPts(dataUsers.map((u) => u.session!.demandMbps)), borderColor: '#8a8984', backgroundColor: '#8a8984', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, stepped: true as const };
    if (!compare) {
      const served = dataUsers.map((u) => u.thrMbps).sort((a, b) => a - b);
      thrCdf.data.datasets = [
        { label: 'Served', data: cdfPts(served), borderColor: SERIES[0], backgroundColor: SERIES[0], borderWidth: 2, pointRadius: 0, stepped: true },
        { ...demandSet, borderColor: SERIES[1], backgroundColor: SERIES[1], borderWidth: 2 },
      ];
      thrCdfTitle.textContent = served.length
        ? `DL throughput of active data users (CDF) · ${v.title} · n = ${served.length} · 5th pct ${fmtMbps(percentile(served, 0.05))} · median ${fmtMbps(percentile(served, 0.5))}`
        : `DL throughput of active data users (CDF) · ${v.title}: no active data sessions`;
    } else {
      const keys = SCHEDULERS.map((x) => x.key);
      const res = engine.compareSchedulers(keys, fullBuffer, scope.kind === 'network' ? undefined : new Set(v.cells));
      const liveKey = schedulerInfo(store.scenario.settings.radio.scheduler)?.key ?? 'rr';
      thrCdf.data.datasets = [
        ...SCHEDULERS.map((x, i) => ({ label: x.label.replace(/ \(.*\)$/, ''), data: cdfPts(res[x.key].thr), borderColor: SERIES[i], backgroundColor: SERIES[i], borderWidth: x.key === liveKey ? 2.5 : 2, pointRadius: 0, stepped: true as const })),
        ...(fullBuffer ? [] : [{ ...demandSet, data: cdfPts(res.demand) }]),
      ];
      const n = res[keys[0]].thr.length;
      thrCdfTitle.textContent = n ? `DL throughput CDF by scheduler · ${v.title} · n = ${n} LTE/NR data users${fullBuffer ? ' · full buffer' : ''}` : `DL throughput CDF by scheduler · ${v.title}: no active LTE/NR data sessions`;
      // All curves identical means no cell is short of resources: say so instead of leaving it a mystery.
      const sig = (k: string) => res[k].thr.map((x) => x.toFixed(3)).join(',');
      const identical = n > 0 && keys.every((k) => sig(k) === sig(keys[0]));
      cmpWarn.style.display = identical ? '' : 'none';
      cmpWarn.textContent = identical
        ? 'All schedulers give the same result: no cell is congested, so every user already gets its full demand and there is nothing to share differently. Tick “Full buffer” above, or raise the load (more users, higher data demand).'
        : '';
      clear(cmpTable);
      const rowsC = SCHEDULERS.map((x, i) => {
        const t = [...res[x.key].thr].sort((a, b) => a - b);
        const total = t.reduce((a, b) => a + b, 0);
        return { x, i, total, mean: t.length ? total / t.length : 0, p5: percentile(t, 0.05), med: percentile(t, 0.5), fair: res[x.key].fairness };
      });
      const best = (f: (r: (typeof rowsC)[number]) => number) => Math.max(...rowsC.map(f));
      cmpTable.appendChild(
        h('table', { class: 'meas cmp' },
          h('tr', null, ...['Scheduler', 'Total', 'Mean', '5th pct', 'Median', 'Fairness'].map((t) => h('th', null, t))),
          ...rowsC.map((r) => h('tr', { class: r.x.key === liveKey ? 'live' : '' },
            h('td', null, h('span', { class: 'dot', style: `background:${SERIES[r.i]}` }), ' ', r.x.label.replace(/ \(.*\)$/, ''), r.x.key === liveKey ? h('span', { class: 'live-tag' }, ' live') : ''),
            h('td', { class: r.total === best((q) => q.total) && r.total > 0 ? 'top' : '' }, fmtMbps(r.total)),
            h('td', { class: r.mean === best((q) => q.mean) && r.mean > 0 ? 'top' : '' }, fmtMbps(r.mean)),
            h('td', { class: r.p5 === best((q) => q.p5) && r.p5 > 0 ? 'top' : '' }, fmtMbps(r.p5)),
            h('td', { class: r.med === best((q) => q.med) && r.med > 0 ? 'top' : '' }, fmtMbps(r.med)),
            h('td', { class: r.fair === best((q) => q.fair) ? 'top' : '' }, fmt(r.fair, 2)),
          )),
        ),
      );
    }

    // Log axis range from the data (rounded up to the next decade).
    let maxX = THR_CDF_MIN * 10;
    for (const d of thrCdf.data.datasets) for (const p of d.data) if (p.x > maxX) maxX = p.x;
    thrCdf.options.scales!.x!.max = Math.pow(10, Math.ceil(Math.log10(maxX)));
    thrCdf.update('none');

    renderLog(false, v);
  };

  // Selecting a station switches the panel to that site; closing it returns to the network.
  store.on('selection', () => {
    const id = store.selectedStationId;
    scope = id ? { kind: 'site', bsId: id } : { kind: 'network' };
    update();
  });

  renderModeChips();
  app.onLiveTick(update);
  update();
  return root;
}
