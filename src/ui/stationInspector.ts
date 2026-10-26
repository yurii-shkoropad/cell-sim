import L from 'leaflet';
import { linkModulation, linkRank, type CellRF } from '../radio/cells';
import { antennaType, validAntennaFor } from '../radio/mimo';
import { modulation, validModulationFor } from '../radio/modulation';
import type { CellState } from '../sim/engine';
import { EVENT_COLOR, EVENT_LABEL } from '../sim/kpi';
import { schedulerInfo } from '../sim/scheduler';
import type { BaseStation } from '../types';
import { isolateFromMap } from '../map/mapView';
import type { App } from './app';
import { button, clear, fmt, h } from './dom';
import { fmtTime } from './kpiPanel';
import { renderStationConfig } from './stationConfig';

type Tab = 'overview' | 'config';
const MAX_USER_ROWS = 60;

/**
 * Floating panel over the map for the selected base station: a live overview
 * (site totals, per-sector load, connected users, events) and its configuration.
 */
export class StationInspector {
  private el: HTMLElement;
  private head = h('div', { class: 'ui-head' });
  private tabsEl = h('div', { class: 'si-tabs' });
  private body = h('div');
  private id: string | null = null;
  private tab: Tab = 'overview';
  private timer = 0;
  private cfgState = { profileSector: 0 };
  onOpen: () => void = () => {};

  constructor(private app: App) {
    this.el = h('div', { class: 'user-inspector station-inspector', style: 'display:none' }, this.head, this.tabsEl, this.body);
    app.mapView.map.getContainer().appendChild(this.el);
    isolateFromMap(this.el);
    L.DomEvent.on(this.el, 'mousemove', L.DomEvent.stopPropagation);
  }

  get stationId() {
    return this.id;
  }

  open(id: string) {
    const changedStation = id !== this.id;
    this.id = id;
    this.el.style.display = '';
    this.app.mapView.map.getContainer().classList.add('inspector-open');
    if (changedStation) this.cfgState.profileSector = 0;
    this.onOpen();
    this.render();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      if (this.tab === 'overview') this.renderOverview();
    }, 500);
  }

  close() {
    if (this.id === null) return;
    this.id = null;
    this.el.style.display = 'none';
    this.app.mapView.map.getContainer().classList.remove('inspector-open');
    clearInterval(this.timer);
  }

  private station(): BaseStation | undefined {
    return this.app.store.station(this.id);
  }

  /** Full re-render (header, tabs, body). Called on open and when the network changes. */
  render() {
    const bs = this.station();
    if (!bs) {
      this.close();
      return;
    }
    this.renderHead(bs);
    clear(this.tabsEl);
    for (const [t, label] of [['overview', 'Overview'], ['config', 'Configure']] as [Tab, string][]) {
      this.tabsEl.appendChild(h('button', { type: 'button', class: `si-tab ${this.tab === t ? 'active' : ''}`, onclick: () => {
        this.tab = t;
        this.render();
      } }, label));
    }
    if (this.tab === 'config') renderStationConfig(this.app, bs, this.body, this.cfgState);
    else this.renderOverview();
  }

  /** Re-render after an edit elsewhere, without rebuilding the config form the user is typing in. */
  refresh() {
    const bs = this.station();
    if (!bs) return this.close();
    this.renderHead(bs);
    if (this.tab === 'overview') this.renderOverview();
  }

  private renderHead(bs: BaseStation) {
    const { store } = this.app;
    const op = store.scenario.operators.find((o) => o.id === bs.operatorId);
    const ant = antennaType(validAntennaFor(bs.tech, bs.antennaType));
    const mod = modulation(validModulationFor(bs.tech, bs.maxModulation));
    const sched = bs.tech === 'GSM' ? null : (schedulerInfo(bs.scheduler) ?? schedulerInfo(store.scenario.settings.radio.scheduler));
    const onAir = h('input', { type: 'checkbox', checked: bs.enabled, onchange: () => {
      bs.enabled = onAir.checked;
      store.emit('network');
    } });
    clear(this.head);
    this.head.append(
      h('div', { class: 'si-title' },
        h('div', { class: 'ui-title' }, h('span', { class: 'dot', style: `background:${op?.color ?? '#888'}` }), h('b', null, bs.name), h('span', { class: 'muted' }, ` · ${op?.name ?? '?'}`)),
        h('div', { class: 'si-sub' }, [
          `${bs.tech} ${bs.band}`,
          bs.tech === 'GSM' ? `${bs.trxCount} TRX` : `${bs.bandwidthMHz} MHz`,
          bs.tech === 'GSM' ? null : ant.label,
          bs.tech === 'GSM' ? 'GMSK' : `max ${mod.label}`,
          sched?.label ?? null,
        ].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'si-actions' },
        h('label', { class: 'si-onair', title: 'Station transmitting' }, onAir, 'On air'),
        button('⌖', () => this.app.mapView.focusStation(bs.id), 'icon', 'Centre the map on this site'),
        button('✕', () => store.select(null), 'icon', 'Close'),
      ),
    );
  }

  // ---------------------------------------------------------------- overview

  private renderOverview() {
    const bs = this.station();
    if (!bs) return this.close();
    const { engine, store } = this.app;
    const ctx = this.app.ctx();
    const r = store.scenario.settings.radio;
    const thr = store.scenario.settings.thresholds;

    const cells: { s: number; idx: number; c: CellRF; st: CellState }[] = [];
    bs.sectors.forEach((s, si) => {
      const idx = ctx.cells.findIndex((c) => c.sectorId === s.id);
      if (idx >= 0) cells.push({ s: si, idx, c: ctx.cells[idx], st: engine.cells[idx] });
    });
    const byIdx = new Map(cells.map((x) => [x.idx, x]));
    const users = engine.users.filter((u) => u.serving >= 0 && byIdx.has(u.serving));
    const active = users.filter((u) => u.session);
    const data = active.filter((u) => u.session!.kind === 'data');
    const served = data.reduce((a, u) => a + u.thrMbps, 0);
    const demand = data.reduce((a, u) => a + u.session!.demandMbps, 0);
    const sinrs = users.map((u) => u.sinr).filter(Number.isFinite);
    const edge = users.filter((u) => Number.isFinite(u.sinr) && u.sinr < 0).length;
    const sum = (f: (st: CellState) => number) => cells.reduce((a, x) => a + f(x.st), 0);

    const kv = (k: string, v: string, cls = '') => h('div', { class: `kv ${cls}` }, h('span', null, k), h('b', null, v));
    clear(this.body);

    if (!bs.enabled || !cells.length) {
      this.body.append(h('p', { class: 'hint' }, bs.enabled ? 'No sectors on air.' : 'Station is off air: turn it on to see live statistics.'));
      return;
    }

    // Site totals
    this.body.append(
      h('div', { class: 'kv-grid' },
        kv('Users', `${users.length} camped · ${active.length} active (${active.length - data.length} voice, ${data.length} data)`),
        kv('Served DL', data.length ? `${fmt(served, 1)} of ${fmt(demand, 1)} Mbps (${Math.round((100 * served) / Math.max(demand, 1e-9))}%)` : '—'),
        kv('Mean SINR', sinrs.length ? `${fmt(sinrs.reduce((a, b) => a + b, 0) / sinrs.length)} dB` : '—'),
        kv('Cell-edge users', `${edge} with SINR < 0 dB`, edge ? 'bad' : ''),
        kv('Handovers', `${sum((s) => s.hoIn)} in · ${sum((s) => s.hoOut)} out`),
        kv('Drops / blocks', `${sum((s) => s.drops)} / ${sum((s) => s.blocks)}`, sum((s) => s.drops + s.blocks) ? 'bad' : ''),
      ),
    );

    // Per-sector cards
    this.body.append(h('h4', null, 'Sectors'));
    for (const x of cells) {
      const sec = bs.sectors[x.s];
      const su = users.filter((u) => u.serving === x.idx);
      const sa = su.filter((u) => u.session);
      const sThr = sa.reduce((a, u) => a + (u.session!.kind === 'data' ? u.thrMbps : 0), 0);
      const sSinr = su.map((u) => u.sinr).filter(Number.isFinite);
      const pct = Math.round(x.st.load * 100);
      const cap = x.c.tech === 'GSM' ? `${x.st.tchUsed}/${x.c.tch} TCH` : `${fmt(x.st.usedRb, 0)}/${x.c.rbs} RB`;
      this.body.append(
        h('div', { class: 'si-card' },
          h('div', { class: 'si-card-head' },
            h('span', { class: 'dot', style: `background:${x.c.color}` }),
            h('b', null, `S${x.s + 1}`),
            h('span', { class: 'muted' }, `az ${sec.azimuth}° · ${x.c.tech === 'GSM' ? 'BSIC' : 'PCI'} ${sec.pci} · ${sec.freqMHz} MHz`),
          ),
          h('div', { class: 'si-bar', title: 'PRB / TCH utilisation' }, h('i', { style: `width:${Math.min(100, pct)}%;background:${pct >= 90 ? '#c0392b' : pct >= 70 ? '#eda100' : '#2a78d6'}` }), h('span', null, `${pct}% · ${cap}`)),
          h('div', { class: 'si-stats' },
            h('span', null, `${sa.length} active / ${su.length} camped`),
            x.c.tech === 'GSM' ? null : h('span', null, `${fmt(sThr, 1)} Mbps`),
            h('span', null, `SINR ${sSinr.length ? fmt(sSinr.reduce((a, b) => a + b, 0) / sSinr.length) : '—'} dB`),
            x.st.muGain > 1.001 ? h('span', { title: 'MU-MIMO capacity multiplier' }, `MU ×${fmt(x.st.muGain, 1)}`) : null,
            h('span', { title: 'handovers in / out' }, `HO ${x.st.hoIn}↓ ${x.st.hoOut}↑`),
            (() => {
              const hp = this.app.engine.hoParams(x.idx);
              const custom = !!bs.sectors[x.s].ho;
              return h('span', { class: custom ? 'ho-custom' : '', title: custom ? 'Per-cell handover parameters (Configure tab)' : 'RAT default handover parameters' }, `hys ${hp.hysteresisDb} · off ${hp.a3OffsetDb} · TTT ${hp.tttMs}${hp.cioDb ? ` · CIO ${hp.cioDb > 0 ? '+' : ''}${hp.cioDb}` : ''}`);
            })(),
            h('span', { title: 'drops / blocks' }, `✖${x.st.drops} ⛔${x.st.blocks}`),
          ),
        ),
      );
    }

    // Connected users
    const ordered = [...users].sort((a, b) => Number(!!b.session) - Number(!!a.session) || b.thrMbps - a.thrMbps || b.rx - a.rx);
    const rows = ordered.slice(0, MAX_USER_ROWS).map((u) => {
      const x = byIdx.get(u.serving)!;
      const minRx = thr[x.c.tech].minRxDbm;
      const lk = linkRank(x.c, u.sinr, engine.ueRx(u), r);
      const mod = u.session ? linkModulation(x.c, lk) : null;
      const state = u.session ? (u.session.kind === 'voice' ? 'voice' : 'data') : 'idle';
      // mousedown: this table is rebuilt every 500 ms, which can swallow a click.
      return h('tr', { class: `si-user ${state}`, title: 'Open this user', onmousedown: () => this.app.openUser(u.id) },
        h('td', null, h('span', { class: `st-dot ${state}` }), u.name ?? `UE${u.id}`),
        h('td', null, `S${x.s + 1}`),
        h('td', { class: u.rx < minRx + 6 ? 'bad' : '' }, fmt(u.rx, 0)),
        h('td', { class: u.sinr < 0 ? 'bad' : '' }, fmt(u.sinr, 1)),
        h('td', null, u.session && x.c.tech !== 'GSM' ? String(lk.rank) : ''),
        h('td', null, mod ? mod.label.replace('QAM', 'Q') : ''),
        h('td', null, u.session ? (u.session.kind === 'data' ? fmt(u.thrMbps, 1) : 'GBR') : ''),
      );
    });
    this.body.append(
      h('h4', null, `Connected users (${users.length})`),
      users.length
        ? h('table', { class: 'meas si-users' },
            h('tr', null, ...['UE', 'Sec', 'dBm', 'SINR', 'Lay', 'Mod', 'Mbps'].map((t) => h('th', null, t))),
            ...rows,
          )
        : h('div', { class: 'hint' }, 'No users camped on this site.'),
      users.length > MAX_USER_ROWS ? h('div', { class: 'hint' }, `…and ${users.length - MAX_USER_ROWS} more`) : '',
    );

    // Recent events at this site
    const names = new Set(cells.map((x) => x.c.name));
    const evs = engine.log.events.filter((e) => (e.from && names.has(e.from)) || (e.to && names.has(e.to))).slice(-8).reverse();
    this.body.append(
      h('h4', null, 'Recent events'),
      h('div', { class: 'ui-events' },
        ...(evs.length
          ? evs.map((e) => h('div', { class: 'ui-ev', onmousedown: () => this.app.openUser(e.userId), style: 'cursor:pointer' },
              h('span', { class: 't' }, fmtTime(e.t)),
              h('span', { class: 'ty', style: `--c:${EVENT_COLOR[e.type]}` }, EVENT_LABEL[e.type]),
              h('span', { class: 'd' }, `UE${e.userId} ${e.from && e.to ? `${e.from} → ${e.to}` : e.detail}`),
            ))
          : [h('div', { class: 'hint' }, 'None yet')]),
      ),
    );
  }
}

