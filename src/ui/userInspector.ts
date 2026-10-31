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
    // Keep the "Set target" button in step with the map's pick mode.
    app.mapView.onPlaceModeChange(() => {
      if (this.uid !== null) this.renderEdit();
    });
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
    if (this.app.mapView.placeMode === 'target') this.app.mapView.setPlaceMode(null);
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
    this.app.saveUser(u, true);
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
      this.targetControls(u, after),
      row('Traffic', selectEl(TRAFFIC, () => u.traffic, (v) => {
        engine.setTraffic(u, v);
        after();
      })),
      row('Data demand (Mbps)', demand),
      row('Wi-Fi', selectEl(
        [['auto', `Auto (${u.specId && engine.wifiDefault(u.specId) ? 'on' : 'off'}, by device share)`], ['on', 'On'], ['off', 'Off']] as [string, string][],
        () => {
          const spec = u.specId ? store.scenario.users?.find((x) => x.id === u.specId) : undefined;
          return spec?.wifi == null ? 'auto' : spec.wifi ? 'on' : 'off';
        },
        (v) => {
          const wifi = v === 'auto' ? null : v === 'on';
          if (u.specId) this.app.editUsers([u.specId], { wifi });
          else engine.setWifiOn(u, wifi ?? false);
          this.renderLive();
        },
      )),
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

  /** Pick / clear the user's destination, and replay the walk from its start position. */
  private targetControls(u: SimUser, after: () => void): HTMLElement {
    const { engine, mapView, store } = this.app;
    if (u.mode === 'static') return h('div', { class: 'hint' }, 'Target: set Mobility to Pedestrian or Vehicle to send this user somewhere.');
    const picking = mapView.placeMode === 'target';
    const pick = button(picking ? 'Click the map…' : u.target ? 'Change target' : 'Set target on map', () => {
      mapView.setPlaceMode(picking ? null : 'target');
      this.renderEdit();
    }, u.target ? '' : 'primary', 'Click a point on the map: the user goes there along the roads and stops');
    const spec = u.specId ? store.scenario.users?.find((x) => x.id === u.specId) : undefined;
    return h('div', { class: 'ui-target' },
      h('div', { class: 'row' },
        pick,
        u.target ? button('Clear target', () => {
          engine.setTarget(u, null);
          after();
        }, '', 'Back to random trips') : null,
        u.target && spec ? button('Restart from start', () => {
          engine.moveUserTo(u, spec.lat, spec.lng, true);
          this.renderLive();
          mapView.renderUsers(engine);
        }, '', 'Put the user back at its start position and walk to the target again') : null,
      ),
      h('p', { class: 'hint' }, u.target
        ? 'The walk starts where the user was when the target was set (or where you drop it). Reset and "Restart from start" replay it.'
        : 'Send the user to a point to test handovers and Wi-Fi switching along a known path.'),
    );
  }

  /** Carrier aggregation: PCell + SCells with what each carries. */
  private caRow(u: SimUser, kv: (k: string, v: string, cls?: string) => HTMLElement): HTMLElement | string {
    const ca = this.app.store.scenario.settings.ca;
    const ctx = this.app.ctx();
    if (!ca.enabled || u.serving < 0 || ctx.cells[u.serving].tech === 'GSM') return '';
    if (!u.scells.length) return kv('Carrier aggr.', u.session?.kind === 'data' && !this.app.engine.onWifi(u) ? 'PCell only (no other carrier above the SCell threshold)' : 'data sessions only');
    const scThr = u.scellThr.reduce((a, b) => a + b, 0);
    const parts = u.scells.map((i, k) => `${ctx.cells[i].name} ${ctx.cells[i].freqMHz} MHz, SINR ${fmt(u.scellSinr[k], 1)} dB, ${fmt(u.scellThr[k], 1)} Mbps`);
    return kv('Carrier aggr.', `${1 + u.scells.length} CC · PCell ${fmt(u.thrMbps - scThr, 1)} Mbps + ${parts.join(' + ')}`);
  }

  /** Other carriers of the PCell's RAT and why each is (not) aggregated. */
  private caTable(u: SimUser): HTMLElement | string {
    if (!this.app.store.scenario.settings.ca.enabled) return '';
    const rows = this.app.engine.caCarriers(u);
    if (!rows.length) return '';
    const ctx = this.app.ctx();
    return h('div', null,
      h('h4', null, 'Carrier aggregation candidates'),
      h('table', { class: 'meas' },
        h('tr', null, h('th', null, 'Cell'), h('th', null, 'MHz'), h('th', null, 'RSRP'), h('th', null, 'SINR'), h('th', null, 'Status')),
        ...rows.map((r) => {
          const c = ctx.cells[r.cell];
          return h('tr', { class: r.used ? 'serving' : '' },
            h('td', null, h('span', { class: 'dot', style: `background:${c.color}` }), ' ', c.name),
            h('td', null, String(c.freqMHz)),
            h('td', null, fmt(r.lvl, 0)),
            h('td', null, fmt(r.sinr, 1)),
            h('td', { class: r.used ? '' : 'muted' }, r.reason),
          );
        }),
      ),
    );
  }

  private targetRow(u: SimUser, kv: (k: string, v: string, cls?: string) => HTMLElement): HTMLElement | string {
    if (!u.target) return '';
    if (u.arrived) return kv('Target', 'reached · stopped');
    if (u.mode === 'static') return kv('Target', 'set, but the user is static');
    const left = this.app.engine.distanceToTarget(u);
    const eta = u.speed > 0 ? ` · ETA ${fmtTime(left / u.speed)}` : '';
    return kv('Target', `${left >= 1000 ? `${fmt(left / 1000, 2)} km` : `${Math.round(left)} m`} to go${eta}`);
  }

  // ---------------------------------------------------------------- live data

  /** Wi-Fi state: off, searching (best AP heard), or associated (AP link, RSSI/SINR, what it carries). */
  private wifiRow(u: SimUser, kv: (k: string, v: string, cls?: string) => HTMLElement): HTMLElement {
    const { engine, store } = this.app;
    const ws = store.scenario.settings.wifi;
    const ctx = this.app.ctx();
    if (!ws.enabled) return kv('Wi-Fi', 'offloading disabled');
    if (!u.wifiOn) return kv('Wi-Fi', 'off on this phone');
    if (u.wifiAp < 0) {
      const cand = u.wifiCand >= 0 ? ctx.wifi[u.wifiCand] : null;
      const speed = u.mode !== 'static' && u.speed * 3.6 > ws.maxSpeedKmh ? ` · too fast (> ${ws.maxSpeedKmh} km/h)` : '';
      return kv('Wi-Fi', cand ? `joining ${cand.name}, ${Math.round(u.wifiTimerMs)}/${ws.assocDelayMs} ms` : Number.isFinite(u.wifiRssi) ? `not associated · best AP ${fmt(u.wifiRssi, 0)} dBm (join ≥ ${ws.minRssiDbm + ws.hysteresisDb})${speed}` : `no AP in range${speed}`);
    }
    const ap = ctx.wifi[u.wifiAp];
    const carries = engine.onWifi(u) ? `${u.session!.kind} over Wi-Fi` : u.session ? `${u.session.kind} stays on cellular` : 'idle';
    return h('div', { class: 'kv' }, h('span', null, 'Wi-Fi'), h('b', null,
      h('a', { href: '#', class: 'cell-link', title: 'Open this AP', onclick: (e: Event) => e.preventDefault(), onmousedown: (e: Event) => {
        e.preventDefault();
        store.selectAp(ap.apId);
      } }, ap.name),
      ` · RSSI ${fmt(u.wifiRssi, 0)} dBm · SINR ${fmt(u.wifiSinr, 1)} dB · ${carries}`));
  }

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
        kv('Mobility', u.mode === 'static' ? 'static' : `${u.mode === 'walk' ? 'pedestrian' : 'vehicle'}, ${u.arrived ? 'stopped at target' : `${Math.round(u.speed * 3.6)} km/h`}${u.dragging ? ' (dragging)' : ''}`),
        kv('Device', `${techsOf(u.techMask).join(' / ')} · ${engine.ueRx(u)} Rx antenna${engine.ueRx(u) > 1 ? 's' : ''}${u.ueRxOverride === null ? '' : ' (set)'}`),
        kv('Position', `${u.lat.toFixed(5)}, ${u.lng.toFixed(5)}`),
        this.targetRow(u, kv),
        this.wifiRow(u, kv),
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
        this.caRow(u, kv),
        kv('Scheduler', c && c.tech !== 'GSM' ? `${schedulerInfo(engine.cellScheduler(u.serving))?.label} · cell load ${Math.round(engine.cells[u.serving].load * 100)}%` : '—'),
        kv('Max possible', c ? maxPossible(c, engine.ueRx(u), store.scenario.settings.radio.overhead) : '—'),
        kv('Peak here', c && c.tech !== 'GSM' ? `${fmt(peakRateMbps(c, u.sinr, store.scenario.settings.radio, engine.ueRx(u)), 1)} Mbps (alone in the cell)` : '—'),
        kv('Throughput', (s?.kind === 'data' ? `${fmt(u.thrMbps, 2)} of ${fmt(s.demandMbps, 2)} Mbps` : s ? `${fmt(u.thrMbps * 1000, 0)} kbps (GBR)` : '—') + (engine.onWifi(u) ? ' · over Wi-Fi' : '')),
        kv('HO candidate', u.hoCand >= 0 && ctx.cells[u.hoCand] && c ? `${ctx.cells[u.hoCand].name}, TTT ${Math.max(0, u.hoTimerMs).toFixed(0)}/${engine.hoParams(u.serving).tttMs} ms` : u.hoTimerMs < 0 ? `back-off ${(-u.hoTimerMs).toFixed(0)} ms` : '—'),
        kv('RLF timer', u.rlfTimerMs > 0 ? `${u.rlfTimerMs.toFixed(0)}/${th?.rlfTimerMs ?? 0} ms` : '—', u.rlfTimerMs > 0 ? 'bad' : ''),
      ),
      this.caTable(u),
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
