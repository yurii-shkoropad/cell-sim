import { BarController, BarElement, CategoryScale, Chart, Filler, Legend, LinearScale, LineController, LineElement, LogarithmicScale, PointElement, Tooltip, type ChartConfiguration } from 'chart.js';
import { EVENT_COLOR, EVENT_LABEL, EVENT_TYPES, percentile, TIMELINE_BUCKET_S, type SimEventType } from '../sim/kpi';
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

function lineChart(canvas: HTMLCanvasElement, labels: string[], yTitle: string, yMin?: number): Chart<'line'> {
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
        y: { min: yMin, grid: { color: GRID }, title: { display: true, text: yTitle } },
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

export function kpiPanel(app: App): HTMLElement {
  const { engine } = app;
  const tiles = h('div', { class: 'tiles' });
  const mk = () => h('canvas');
  const cSessions = mk();
  const cRat = mk();
  const cThr = mk();
  const cSinr = mk();
  const cEvents = mk();
  const cLoad = mk();
  const cCdf = mk();
  const cThrCdf = mk();
  const thrCdfTitle = h('div', { class: 'chart-title' }, 'DL throughput distribution of active data users (CDF)');
  const box = (title: string, c: HTMLCanvasElement, tall = false) => h('div', { class: `chart-box ${tall ? 'tall' : ''}` }, h('div', { class: 'chart-title' }, title), h('div', { class: 'chart-wrap' }, c));

  const logList = h('div', { class: 'log-list' });
  const enabled = new Set<SimEventType>(EVENT_TYPES.filter((t) => t !== 'CALL_START' && t !== 'CALL_END'));
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
    tiles,
    h('div', { class: 'charts' },
      box('Active sessions', cSessions),
      box('Users by serving RAT', cRat),
      box('User DL throughput (Mbps)', cThr),
      box('Mean SINR of camped users (dB)', cSinr),
      box(`Event timeline (per ${TIMELINE_BUCKET_S} s)`, cEvents, true),
      box('Most loaded cells (PRB / TCH utilisation)', cLoad, true),
      box('SINR distribution of camped users (CDF)', cCdf),
      h('div', { class: 'chart-box tall' }, thrCdfTitle, h('div', { class: 'chart-wrap' }, cThrCdf)),
    ),
    h('div', { class: 'log' }, h('div', { class: 'chart-title' }, 'Event log (newest first, click to locate)'), chips, logList),
  );

  const sessions = lineChart(cSessions, ['Voice', 'Data'], 'sessions', 0);
  const rat = lineChart(cRat, ['GSM', 'LTE', 'NR'], 'users', 0);
  const thr = lineChart(cThr, ['Mean', 'Cell edge (5th pct)'], 'Mbps', 0);
  const sinr = lineChart(cSinr, ['Mean SINR'], 'dB');

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
    data: {
      datasets: [
        { label: 'Served', data: [], borderColor: SERIES[0], backgroundColor: SERIES[0], borderWidth: 2, pointRadius: 0, stepped: true },
        { label: 'Demand', data: [], borderColor: SERIES[1], backgroundColor: SERIES[1], borderWidth: 2, borderDash: [5, 4], pointRadius: 0, stepped: true },
      ],
    },
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

  let lastSeq = -1;
  const renderLog = (force = false) => {
    const evs = engine.log.events;
    const top = evs.length ? evs[evs.length - 1].seq : 0;
    if (!force && top === lastSeq) return;
    lastSeq = top;
    clear(logList);
    let shown = 0;
    for (let i = evs.length - 1; i >= 0 && shown < 250; i--) {
      const e = evs[i];
      if (!enabled.has(e.type)) continue;
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
    if (!shown) logList.appendChild(h('div', { class: 'hint' }, 'No events yet. Press ▶ to start the simulation.'));
  };

  const tile = (label: string, value: string, sub = '', title = '') => h('div', { class: 'tile', title }, h('div', { class: 'tv' }, value), h('div', { class: 'tl' }, label), sub ? h('div', { class: 'ts' }, sub) : null);
  const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '—');

  const update = () => {
    const k = engine.counters;
    const s = engine.samples;
    const last = s[s.length - 1];
    const admitted = k.voiceStarted + k.dataStarted - k.blockedCapacity - k.blockedCoverage;
    clear(tiles);
    tiles.append(
      tile('Users', String(engine.users.length), last ? `${last.activeVoice} voice · ${last.activeData} data` : ''),
      tile('Coverage', last ? `${(last.coverage * 100).toFixed(1)}%` : '—', 'users with a serving cell'),
      tile('HO success', pct(k.hoSuccess, k.hoAttempts), `${k.hoSuccess} of ${k.hoAttempts} · ${k.hoIrat} IRAT`),
      tile('Ping-pong', pct(k.pingPong, k.hoSuccess), `${k.pingPong} HOs`),
      tile('Drop rate', pct(k.dropped, admitted), `${k.dropped} of ${admitted} sessions`),
      tile('Block rate', pct(k.blockedCapacity + k.blockedCoverage, k.voiceStarted + k.dataStarted), `${k.blockedCoverage} coverage · ${k.blockedCapacity} capacity`),
      tile('Mean DL', last ? `${fmt(last.meanThrMbps)} Mbps` : '—', last ? `edge ${fmt(last.p5ThrMbps, 2)} Mbps` : ''),
      tile('Mean SINR', last ? `${fmt(last.meanSinrDb)} dB` : '—', 'camped users'),
      tile('Fairness', last && last.activeData ? fmt(last.fairness, 2) : '—', 'throughput ÷ demand, 1 = equal', 'Jain’s fairness index over data users’ satisfaction (throughput / demand)'),
    );

    const series = <T>(f: (x: (typeof s)[number]) => T) => s.map((p) => ({ x: p.t, y: f(p) as unknown as number }));
    sessions.data.datasets[0].data = series((p) => p.activeVoice);
    sessions.data.datasets[1].data = series((p) => p.activeData);
    rat.data.datasets[0].data = series((p) => p.byTech.GSM);
    rat.data.datasets[1].data = series((p) => p.byTech.LTE);
    rat.data.datasets[2].data = series((p) => p.byTech.NR);
    thr.data.datasets[0].data = series((p) => p.meanThrMbps);
    thr.data.datasets[1].data = series((p) => p.p5ThrMbps);
    sinr.data.datasets[0].data = series((p) => p.meanSinrDb);
    for (const c of [sessions, rat, thr, sinr]) c.update('none');

    // Timeline: last 60 buckets
    const nowB = Math.floor(engine.t / TIMELINE_BUCKET_S);
    const startB = Math.max(0, nowB - 59);
    const labels: string[] = [];
    const rows = TIMELINE_TYPES.map(() => [] as number[]);
    for (let b = startB; b <= nowB; b++) {
      labels.push(fmtTime(b * TIMELINE_BUCKET_S));
      const counts = engine.log.buckets.get(b) ?? {};
      TIMELINE_TYPES.forEach((t, i) => rows[i].push(counts[t] ?? 0));
    }
    events.data.labels = labels;
    rows.forEach((r, i) => (events.data.datasets[i].data = r));
    events.update('none');

    // Load top 12
    const ctx = app.ctx();
    const ranked = engine.cells.map((c, i) => ({ i, load: c.load })).filter((x) => x.load > 0).sort((a, b) => b.load - a.load).slice(0, 12);
    load.data.labels = ranked.map((r) => `${ctx.cells[r.i]?.name ?? r.i} (${ctx.cells[r.i]?.tech ?? ''})`);
    load.data.datasets[0].data = ranked.map((r) => r.load * 100);
    load.update('none');

    // SINR CDF
    const vals = engine.users.filter((u) => u.serving >= 0 && Number.isFinite(u.sinr)).map((u) => u.sinr).sort((a, b) => a - b);
    cdf.data.datasets[0].data = vals.map((v, i) => ({ x: Math.max(-10, Math.min(35, v)), y: ((i + 1) / vals.length) * 100 }));
    cdf.update('none');

    // Throughput CDF (served vs. demanded) of active data users
    const dataUsers = engine.users.filter((u) => u.session?.kind === 'data');
    const served = dataUsers.map((u) => u.thrMbps).sort((a, b) => a - b);
    const demand = dataUsers.map((u) => u.session!.demandMbps).sort((a, b) => a - b);
    const cdfPts = (xs: number[]) => xs.map((v, i) => ({ x: Math.max(THR_CDF_MIN, v), y: ((i + 1) / xs.length) * 100 }));
    thrCdf.data.datasets[0].data = cdfPts(served);
    thrCdf.data.datasets[1].data = cdfPts(demand);
    thrCdf.update('none');
    thrCdfTitle.textContent = served.length
      ? `DL throughput of active data users (CDF) · n = ${served.length} · 5th pct ${fmtMbps(percentile(served, 0.05))} · median ${fmtMbps(percentile(served, 0.5))}`
      : 'DL throughput of active data users (CDF): no active data sessions';

    renderLog();
  };

  app.onLiveTick(update);
  update();
  return root;
}
