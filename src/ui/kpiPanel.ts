import { BarController, BarElement, CategoryScale, Chart, Filler, Legend, LinearScale, LineController, LineElement, LogarithmicScale, PointElement, Tooltip, type ChartConfiguration } from 'chart.js';
import { EVENT_COLOR, EVENT_LABEL, EVENT_TYPES, percentile, TIMELINE_BUCKET_S, type SimEventType } from '../sim/kpi';
import { SCHEDULERS, schedulerInfo } from '../sim/scheduler';
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
  const cmpNote = h('div', { class: 'hint' }, 'What-if on the current snapshot: the same LTE/NR users, positions, SINR and demands, as if every LTE/NR cell used each scheduler (GSM users get a fixed GPRS slot and are left out). Fairness is Jain per cell over throughput ÷ demand, or over throughput with full buffer.');
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
      h('div', { class: 'chart-box tall' }, thrCdfTitle, modeChips, fbField, h('div', { class: 'chart-wrap' }, cThrCdf), cmpWarn, cmpNote, cmpTable),
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

    // Throughput CDF of active data users: live served vs. demand, or all schedulers what-if
    const cdfPts = (xs: number[]) => [...xs].sort((a, b) => a - b).map((v, i, a) => ({ x: Math.max(THR_CDF_MIN, v), y: ((i + 1) / a.length) * 100 }));
    const dataUsers = engine.users.filter((u) => u.session?.kind === 'data');
    const demand = dataUsers.map((u) => u.session!.demandMbps);
    const demandSet = { label: 'Demand', data: cdfPts(demand), borderColor: '#8a8984', backgroundColor: '#8a8984', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, stepped: true as const };
    if (!compare) {
      const served = dataUsers.map((u) => u.thrMbps).sort((a, b) => a - b);
      thrCdf.data.datasets = [
        { label: 'Served', data: cdfPts(served), borderColor: SERIES[0], backgroundColor: SERIES[0], borderWidth: 2, pointRadius: 0, stepped: true },
        { ...demandSet, borderColor: SERIES[1], backgroundColor: SERIES[1], borderWidth: 2 },
      ];
      thrCdfTitle.textContent = served.length
        ? `DL throughput of active data users (CDF) · n = ${served.length} · 5th pct ${fmtMbps(percentile(served, 0.05))} · median ${fmtMbps(percentile(served, 0.5))}`
        : 'DL throughput of active data users (CDF): no active data sessions';
    } else {
      const keys = SCHEDULERS.map((x) => x.key);
      const res = engine.compareSchedulers(keys, fullBuffer);
      const liveKey = schedulerInfo(app.store.scenario.settings.radio.scheduler)?.key ?? 'rr';
      thrCdf.data.datasets = [
        ...SCHEDULERS.map((x, i) => ({ label: x.label.replace(/ \(.*\)$/, ''), data: cdfPts(res[x.key].thr), borderColor: SERIES[i], backgroundColor: SERIES[i], borderWidth: x.key === liveKey ? 2.5 : 2, pointRadius: 0, stepped: true as const })),
        ...(fullBuffer ? [] : [{ ...demandSet, data: cdfPts(res.demand) }]),
      ];
      const n = res[keys[0]].thr.length;
      thrCdfTitle.textContent = n ? `DL throughput CDF by scheduler · n = ${n} LTE/NR data users${fullBuffer ? ' · full buffer' : ''}` : 'DL throughput CDF by scheduler: no active LTE/NR data sessions';
      // All curves identical means no cell is short of resources: say so instead of leaving it a mystery.
      const sig = (k: string) => res[k].thr.map((v) => v.toFixed(3)).join(',');
      const identical = n > 0 && keys.every((k) => sig(k) === sig(keys[0]));
      cmpWarn.style.display = identical ? '' : 'none';
      cmpWarn.textContent = identical
        ? 'All schedulers give the same result: no cell is congested, so every user already gets its full demand and there is nothing to share differently. Tick “Full buffer” above, or raise the load (more users, higher data demand).'
        : '';
      // Comparison table
      clear(cmpTable);
      const rows = SCHEDULERS.map((x, i) => {
        const t = [...res[x.key].thr].sort((a, b) => a - b);
        const total = t.reduce((a, b) => a + b, 0);
        return { x, i, total, mean: t.length ? total / t.length : 0, p5: percentile(t, 0.05), med: percentile(t, 0.5), fair: res[x.key].fairness };
      });
      const best = (f: (r: (typeof rows)[number]) => number) => Math.max(...rows.map(f));
      cmpTable.appendChild(
        h('table', { class: 'meas cmp' },
          h('tr', null, ...['Scheduler', 'Total', 'Mean', '5th pct', 'Median', 'Fairness'].map((t) => h('th', null, t))),
          ...rows.map((r) => h('tr', { class: r.x.key === liveKey ? 'live' : '' },
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

    renderLog();
  };

  renderModeChips();
  app.onLiveTick(update);
  update();
  return root;
}
