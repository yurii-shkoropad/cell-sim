import L from 'leaflet';
import { GSM_SLOT_MBPS, linkModulation, linkRank, pathCondition, peakRateMbps, type CellRF } from '../radio/cells';
import { PATH_COND_LABEL } from '../radio/buildingPaths';
import { modulation } from '../radio/modulation';
import { schedulerInfo } from '../sim/scheduler';
import { techMaskOf, techsOf, type SimUser } from '../sim/engine';
import { EVENT_COLOR, EVENT_LABEL } from '../sim/kpi';
import { TECHS, type Mobility, type TrafficMode } from '../types';
import { isolateFromMap } from '../map/mapView';
import type { App } from './app';
import { button, clear, fmt, h, selectEl } from './dom';
import { fmtTime } from './kpiPanel';

/**
 * Ideal-conditions ceiling for a UE on a cell: every RB, every layer the cell and
 * phone can both handle, each at the cell's max modulation (perfect SINR, no other users).
 */
function maxPossible(c: CellRF, ueRx: number, overhead: number): string {
  if (c.tech === 'GSM') return `${fmt(GSM_SLOT_MBPS * 1000, 1)} kbps (one GPRS timeslot)`;
  const layers = Math.max(1, Math.min(c.ports, c.maxLayers, ueRx));
  const mod = modulation(c.modulation);
  const mbps = (layers * mod.seMax * c.rbBwHz * (1 - overhead) * c.rbs) / 1e6;
  return `${fmt(mbps, 1)} Mbps (${layers} layer${layers > 1 ? 's' : ''} × ${mod.label}, ideal radio, alone)`;
}

const MOBILITY: [Mobility, string][] = [['walk', 'Pedestrian'], ['drive', 'Vehicle'], ['static', 'Static']];
const TRAFFIC: [TrafficMode, string][] = [['random', 'Random (Poisson)'], ['voice', 'Continuous voice'], ['data', 'Continuous data'], ['idle', 'Idle (no sessions)']];

/** Floating panel over the map showing one UE's live radio state, with controls to edit it. */
export class UserInspector {
  private el: HTMLElement;
  private editHost = h('div', { class: 'ui-edit' });
  private editOpen = true;
  private liveHost = h('div', { class: 'ui-live' });
  private titleEl = h('div', { class: 'ui-title' });
  private uid: number | null = null;
  private follow = false;
  private timer = 0;

  constructor(private app: App) {
    this.el = h('div', { class: 'user-inspector', style: 'display:none' },
      h('div', { class: 'ui-head' }, this.titleEl, button('✕', () => this.close(), 'icon', 'Close')),
      this.liveHost,
      this.editHost,
    );
    const container = app.mapView.map.getContainer();
    container.appendChild(this.el);
    isolateFromMap(this.el);
    L.DomEvent.on(this.el, 'mousemove', L.DomEvent.stopPropagation);
  }

  get userId() {
    return this.uid;
  }

  open(id: number) {
    this.uid = id;
    this.app.mapView.selectedUserId = id;
    this.el.style.display = '';
    this.app.mapView.map.getContainer().classList.add('inspector-open');
    this.renderEdit();
    this.renderLive();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.renderLive(), 300);
    this.app.mapView.renderSelection(this.app.engine);
  }

  close() {
    this.uid = null;
    this.app.mapView.selectedUserId = null;
    this.el.style.display = 'none';
    this.app.mapView.map.getContainer().classList.remove('inspector-open');
    clearInterval(this.timer);
    this.app.mapView.renderSelection(this.app.engine);
  }

  private user(): SimUser | undefined {
    return this.uid === null ? undefined : this.app.engine.userById(this.uid);
  }

  /** Called after a drag ends so the user's saved start position follows it. */
  dropped(u: SimUser) {
    this.app.saveUser(u);
    if (u.id === this.uid) this.renderLive();
  }

  // ---------------------------------------------------------------- edit form

  renderEdit() {
    clear(this.editHost);
    const u = this.user();
    if (!u) return;
    const { engine, store } = this.app;
    const after = () => {
      this.app.saveUser(u);
      this.renderEdit();
      this.renderLive();
      this.app.mapView.renderUsers(engine);
    };
    const row = (label: string, ctl: HTMLElement) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), h('span', { class: 'ctl' }, ctl));

    const boxes: HTMLInputElement[] = TECHS.map((t, i) =>
      h('input', { type: 'checkbox', checked: techsOf(u.techMask).includes(t), onchange: () => {
        const sel = TECHS.filter((_, k) => boxes[k].checked);
        if (!sel.length) {
          boxes[i].checked = true; // a device must support at least one RAT
          return;
        }
        engine.setTechMask(u, techMaskOf(sel));
        after();
      } }),
    );
    const techBoxes = h('span', { class: 'techs' }, ...TECHS.map((t, i) => h('label', null, boxes[i], t)));

    const speed = h('input', { type: 'number', min: '0', step: '1', value: String(Math.round(u.speed * 3.6)), disabled: u.mode === 'static', onchange: () => {
      const v = parseFloat(speed.value);
      if (Number.isFinite(v) && v >= 0) {
        u.speed = v / 3.6;
        u.speedFixed = true; // keep this speed on every trip
      }
      after();
    } });
    const demand = h('input', { type: 'number', min: '0', step: '0.5', placeholder: 'random', value: u.demandMbps === null ? '' : String(u.demandMbps), onchange: () => {
      const v = parseFloat(demand.value);
      u.demandMbps = demand.value.trim() === '' || !Number.isFinite(v) ? null : Math.max(0.01, v);
      if (u.session?.kind === 'data' && u.demandMbps !== null) u.session.demandMbps = u.demandMbps;
      after();
    } });

    const nameRow = row('Name', (() => {
      const i = h('input', { type: 'text', value: u.name ?? '', onchange: () => {
        u.name = i.value;
        after();
      } });
      return i;
    })());

    const details = h('details', { open: this.editOpen, ontoggle: () => (this.editOpen = details.open) }, h('summary', null, h('h4', { style: 'display:inline' }, 'Edit device & behaviour')));
    this.editHost.append(details);
    details.append(
      nameRow,
      row('Operator', selectEl(store.scenario.operators.map((o, i) => [String(i), o.name] as [string, string]), () => String(u.opIdx), (v) => {
        engine.setOperator(u, +v);
        after();
      })),
      row('Supports', techBoxes),
      row('Phone Rx antennas', selectEl(
        [['auto', `Auto (${engine.defaultUeRx(u)}, device default)`], ['1', '1'], ['2', '2'], ['4', '4'], ['8', '8']] as [string, string][],
        () => (u.ueRxOverride === null ? 'auto' : String(u.ueRxOverride)),
        (v) => {
          engine.setUeRx(u, v === 'auto' ? null : +v);
          after();
        },
      )),
      row('Mobility', selectEl(MOBILITY, () => u.mode, (v) => {
        engine.setMobility(u, v);
        after();
      })),
      row('Speed (km/h)', speed),
      row('Traffic', selectEl(TRAFFIC, () => u.traffic, (v) => {
        engine.setTraffic(u, v);
        after();
      })),
      row('Data demand (Mbps)', demand),
      h('div', { class: 'row' },
        button('Start voice', () => {
          engine.startSessionNow(u, 'voice');
          after();
        }),
        button('Start data', () => {
          engine.startSessionNow(u, 'data');
          after();
        }),
        button('End session', () => {
          engine.endSessionNow(u);
          after();
        }),
      ),
      h('div', { class: 'row' },
        h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: this.follow, onchange: (e: Event) => (this.follow = (e.target as HTMLInputElement).checked) }), h('span', null, 'Follow on map')),
      ),
      h('div', { class: 'row' },
        button('Delete user', () => {
          if (u.specId) this.app.deleteUsers([u.specId]);
          else {
            engine.removeUser(u.id);
            this.app.mapView.renderUsers(engine);
          }
          this.close();
        }, 'danger'),
      ),
      h('p', { class: 'hint' }, 'Changes are saved in the scenario. Drag the user on the map to move its start position.'),
    );
  }

  // ---------------------------------------------------------------- live data

  renderLive() {
    const u = this.user();
    if (!u) {
      this.close();
      return;
    }
    const { engine, store } = this.app;
    const ctx = this.app.ctx();
    const op = store.scenario.operators[u.opIdx];
    this.titleEl.innerHTML = '';
    this.titleEl.append(
      h('span', { class: 'dot', style: `background:${op?.color ?? '#888'}` }),
      h('b', null, u.name ?? `UE${u.id}`),
      h('span', { class: 'muted' }, ` · ${op?.name ?? '?'}`),
    );
    if (this.follow) {
      const p = this.app.mapView.map.latLngToContainerPoint([u.lat, u.lng]);
      const size = this.app.mapView.map.getSize();
      if (p.x < size.x * 0.25 || p.x > size.x * 0.75 || p.y < size.y * 0.25 || p.y > size.y * 0.75) this.app.mapView.map.panTo([u.lat, u.lng]);
    }

    const c = u.serving >= 0 ? ctx.cells[u.serving] : null;
    const th = c ? store.scenario.settings.thresholds[c.tech] : null;
    const s = u.session;
    const kv = (k: string, v: string, cls = '') => h('div', { class: `kv ${cls}` }, h('span', null, k), h('b', null, v));
    const state = s
      ? `${s.kind} · ${fmtTime(engine.t - s.start)} elapsed${Number.isFinite(s.end) ? ` · ${fmtTime(Math.max(0, s.end - engine.t))} left` : ' · continuous'}`
      : u.serving < 0 ? 'no service' : 'idle (camped)';

    const meas = engine.measurements(u).slice(0, 6);
    const servLvl = c ? u.rx : -Infinity;
    clear(this.liveHost);
    this.liveHost.append(
      h('div', { class: 'kv-grid' },
        kv('State', state),
        c && c.pathMap >= 0 ? kv('Path', PATH_COND_LABEL[pathCondition(this.app.ctx(), c, u.x, u.y)] + ' (building model)') : '',
        kv('Mobility', u.mode === 'static' ? 'static' : `${u.mode === 'walk' ? 'pedestrian' : 'vehicle'}, ${Math.round(u.speed * 3.6)} km/h${u.dragging ? ' (dragging)' : ''}`),
        kv('Device', `${techsOf(u.techMask).join(' / ')} · ${engine.ueRx(u)} Rx antenna${engine.ueRx(u) > 1 ? 's' : ''}${u.ueRxOverride === null ? '' : ' (set)'}`),
        kv('Position', `${u.lat.toFixed(5)}, ${u.lng.toFixed(5)}`),
        c
          ? h('div', { class: 'kv' }, h('span', null, 'Serving cell'), h('b', null,
              h('a', { href: '#', class: 'cell-link', title: 'Open this station', onclick: (e: Event) => e.preventDefault(), onmousedown: (e: Event) => {
                e.preventDefault();
                store.select(c.bsId);
              } }, c.name),
              ` · ${c.tech} · PCI ${c.pci} · ${c.freqMHz} MHz`))
          : kv('Serving cell', '—'),
        kv(c?.tech === 'GSM' ? 'RxLev' : 'RSRP', c ? `${fmt(u.rx)} dBm` : '—', c && th && u.rx < th.minRxDbm + 6 ? 'bad' : ''),
        kv(c?.tech === 'GSM' ? 'C/(I+N)' : 'SINR', c ? `${fmt(u.sinr)} dB` : '—', c && th && u.sinr < th.qOutSinrDb + 3 ? 'bad' : ''),
        kv('MIMO', c && c.tech !== 'GSM' ? (() => {
          const ant = `${c.ports}T`;
          const lk = linkRank(c, u.sinr, engine.ueRx(u), store.scenario.settings.radio);
          return `${lk.rank} layer${lk.rank > 1 ? 's' : ''} (cell ${ant}${c.maxLayers > 1 ? `, max ${Math.min(c.maxLayers, c.ports)}` : ''}${c.bfGainDb ? `, BF +${c.bfGainDb} dB` : ''} · UE ${engine.ueRx(u)}Rx)`;
        })() : '—'),
        kv('Modulation', c ? (() => {
          const m = linkModulation(c, linkRank(c, u.sinr, engine.ueRx(u), store.scenario.settings.radio));
          const cap = c.tech === 'GSM' ? '' : ` (cell max ${modulation(c.modulation).label})`;
          return `${m ? m.label : 'none (SINR too low)'}${cap}`;
        })() : '—'),
        kv('Carrier', c ? (c.tech === 'GSM' ? `${c.freqMHz} MHz · 200 kHz · ${c.tch} TCH` : `${c.freqMHz} MHz · ${c.rbs} RB (${fmt(c.occBwMHz, 1)} MHz used)`) : '—'),
        kv('Scheduler', c && c.tech !== 'GSM' ? `${schedulerInfo(engine.cellScheduler(u.serving))?.label} · cell load ${Math.round(engine.cells[u.serving].load * 100)}%` : '—'),
        kv('Max possible', c ? maxPossible(c, engine.ueRx(u), store.scenario.settings.radio.overhead) : '—'),
        kv('Peak here', c && c.tech !== 'GSM' ? `${fmt(peakRateMbps(c, u.sinr, store.scenario.settings.radio, engine.ueRx(u)), 1)} Mbps (alone in the cell)` : '—'),
        kv('Throughput', s?.kind === 'data' ? `${fmt(u.thrMbps, 2)} of ${fmt(s.demandMbps, 2)} Mbps` : s ? `${fmt(u.thrMbps * 1000, 0)} kbps (GBR)` : '—'),
        kv('HO candidate', u.hoCand >= 0 && ctx.cells[u.hoCand] ? `${ctx.cells[u.hoCand].name}, TTT ${Math.max(0, u.hoTimerMs).toFixed(0)}/${th?.tttMs ?? 0} ms` : u.hoTimerMs < 0 ? `back-off ${(-u.hoTimerMs).toFixed(0)} ms` : '—'),
        kv('RLF timer', u.rlfTimerMs > 0 ? `${u.rlfTimerMs.toFixed(0)}/${th?.rlfTimerMs ?? 0} ms` : '—', u.rlfTimerMs > 0 ? 'bad' : ''),
      ),
      h('h4', null, 'Measured cells'),
      h('table', { class: 'meas' },
        h('tr', null, h('th', null, 'Cell'), h('th', null, 'RAT'), h('th', null, 'Level'), h('th', null, 'Δ serving')),
        ...meas.map((m) => {
          const cell = ctx.cells[m.cell];
          const cls = m.cell === u.serving ? 'serving' : m.cell === u.hoCand ? 'cand' : '';
          return h('tr', { class: cls },
            h('td', null, h('span', { class: 'dot', style: `background:${cell.color}` }), ' ', cell.name),
            h('td', null, cell.tech),
            h('td', null, `${fmt(m.level)} dBm`),
            h('td', null, c && m.cell !== u.serving && cell.tech === c.tech ? `${m.level - servLvl >= 0 ? '+' : ''}${fmt(m.level - servLvl)} dB` : m.cell === u.serving ? 'serving' : ''),
          );
        }),
      ),
      h('h4', null, 'Recent events'),
      h('div', { class: 'ui-events' },
        ...(() => {
          const evs = engine.log.events.filter((e) => e.userId === u.id).slice(-6).reverse();
          if (!evs.length) return [h('div', { class: 'hint' }, 'None yet')];
          return evs.map((e) => h('div', { class: 'ui-ev' }, h('span', { class: 't' }, fmtTime(e.t)), h('span', { class: 'ty', style: `--c:${EVENT_COLOR[e.type]}` }, EVENT_LABEL[e.type]), h('span', { class: 'd' }, e.from && e.to ? `${e.from} → ${e.to}` : e.detail)));
        })(),
      ),
    );
  }
}
