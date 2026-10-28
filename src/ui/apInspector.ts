import L from 'leaflet';
import { WIFI_BANDS, WIFI_STANDARDS, wifiRangeM, wifiRateMbps } from '../radio/wifi';
import { EVENT_COLOR, EVENT_LABEL } from '../sim/kpi';
import type { WifiAp } from '../types';
import { isolateFromMap } from '../map/mapView';
import { apFields } from './apConfig';
import type { App } from './app';
import { button, clear, fmt, h } from './dom';
import { fmtTime } from './kpiPanel';

type Tab = 'overview' | 'config';
const MAX_USER_ROWS = 60;

/** Floating panel over the map for the selected Wi-Fi AP: live statistics and configuration. */
export class ApInspector {
  private el: HTMLElement;
  private head = h('div', { class: 'ui-head' });
  private tabsEl = h('div', { class: 'si-tabs' });
  private body = h('div');
  private id: string | null = null;
  private tab: Tab = 'overview';
  private timer = 0;

  constructor(private app: App) {
    this.el = h('div', { class: 'user-inspector station-inspector', style: 'display:none' }, this.head, this.tabsEl, this.body);
    app.mapView.map.getContainer().appendChild(this.el);
    isolateFromMap(this.el);
    L.DomEvent.on(this.el, 'mousemove', L.DomEvent.stopPropagation);
  }

  get apId() {
    return this.id;
  }

  open(id: string) {
    this.id = id;
    this.el.style.display = '';
    this.app.mapView.map.getContainer().classList.add('inspector-open');
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

  private ap(): WifiAp | undefined {
    return this.app.store.ap(this.id);
  }

  render() {
    const ap = this.ap();
    if (!ap) return this.close();
    this.renderHead(ap);
    clear(this.tabsEl);
    for (const [t, label] of [['overview', 'Overview'], ['config', 'Configure']] as [Tab, string][]) {
      this.tabsEl.appendChild(h('button', { type: 'button', class: `si-tab ${this.tab === t ? 'active' : ''}`, onclick: () => {
        this.tab = t;
        this.render();
      } }, label));
    }
    if (this.tab === 'config') this.renderConfig(ap);
    else this.renderOverview();
  }

  /** After an edit elsewhere: keep the config form the user may be typing in. */
  refresh() {
    const ap = this.ap();
    if (!ap) return this.close();
    this.renderHead(ap);
    if (this.tab === 'overview') this.renderOverview();
  }

  private renderHead(ap: WifiAp) {
    const { store, mapView } = this.app;
    const onAir = h('input', { type: 'checkbox', checked: ap.enabled, onchange: () => {
      ap.enabled = onAir.checked;
      store.emit('network');
    } });
    const access = ap.access === 'public' ? 'public' : `${store.scenario.operators.find((o) => o.id === ap.access)?.name ?? '?'} only`;
    clear(this.head);
    this.head.append(
      h('div', { class: 'si-title' },
        h('div', { class: 'ui-title' }, h('span', { class: 'dot', style: `background:${mapView.apColor(ap)}` }), h('b', null, ap.name), h('span', { class: 'muted' }, ` · Wi-Fi ${access}`)),
        h('div', { class: 'si-sub' }, `${WIFI_STANDARDS[ap.standard].label} · ${WIFI_BANDS[ap.band].label} ch ${ap.channel} · ${ap.widthMHz} MHz · ${ap.streams}×${ap.streams} · ${ap.txPowerDbm} dBm · ${ap.indoor ? 'indoor' : 'outdoor'}`),
      ),
      h('div', { class: 'si-actions' },
        h('label', { class: 'si-onair', title: 'AP transmitting' }, onAir, 'On air'),
        button('⌖', () => mapView.focusAp(ap.id), 'icon', 'Centre the map on this AP'),
        button('✕', () => store.selectAp(null), 'icon', 'Close'),
      ),
    );
  }

  private renderConfig(ap: WifiAp) {
    const { store } = this.app;
    clear(this.body);
    this.body.append(
      apFields(store.scenario, ap, () => {
        store.emit('network');
        this.renderHead(ap);
      }, () => this.renderConfig(ap), true),
      h('div', { class: 'row' }, button('Delete AP', () => store.removeAps(new Set([ap.id])), 'danger')),
      h('p', { class: 'hint' }, 'Drag the AP on the map while "Add APs on map" (Wi-Fi tab) is active to move it.'),
    );
  }

  private renderOverview() {
    const ap = this.ap();
    if (!ap) return this.close();
    const { engine, store } = this.app;
    const ctx = this.app.ctx();
    const ws = store.scenario.settings.wifi;
    const j = ctx.wifi.findIndex((a) => a.apId === ap.id);
    clear(this.body);
    if (!ws.enabled) this.body.append(h('p', { class: 'callout' }, 'Wi-Fi offloading is switched off (Wi-Fi tab), so no phone associates.'));
    if (j < 0) {
      this.body.append(h('p', { class: 'hint' }, 'AP is off air: turn it on to see live statistics.'));
      return;
    }
    const rf = ctx.wifi[j];
    const st = engine.aps[j];
    const users = engine.users.filter((u) => u.wifiAp === j);
    const pct = Math.round(st.airtime * 100);
    const kv = (k: string, v: string, cls = '') => h('div', { class: `kv ${cls}` }, h('span', null, k), h('b', null, v));
    const peak = Math.min(wifiRateMbps(rf, 60, ws.ueStreams, ws.alpha), rf.backhaulMbps);
    this.body.append(
      h('div', { class: 'kv-grid' },
        kv('Users', `${users.length} associated (max ${ap.maxUsers}) · ${st.active} with a session over Wi-Fi`),
        kv('Served', st.active ? `${fmt(st.servedMbps, 1)} of ${fmt(st.demandMbps, 1)} Mbps (${Math.round((100 * st.servedMbps) / Math.max(st.demandMbps, 1e-9))}%)` : '—'),
        kv('Capacity', `${fmt(st.capacityMbps, 0)} Mbps at the users' mean rate · peak ${fmt(peak, 0)} Mbps · backhaul ${ap.backhaulMbps} Mbps`),
        kv('Range', `≈ ${Math.round(wifiRangeM(rf, ws.minRssiDbm))} m to ${ws.minRssiDbm} dBm (median, slope ${rf.slope})`),
        kv('Joins / leaves', `${st.joins} / ${st.leaves}`),
      ),
      h('div', { class: 'si-bar', title: 'Airtime in use' }, h('i', { style: `width:${Math.min(100, pct)}%;background:${pct >= 90 ? '#c0392b' : pct >= 70 ? '#eda100' : '#7b5cd6'}` }), h('span', null, `airtime ${pct}%`)),
    );

    const rows = [...users]
      .sort((a, b) => Number(engine.onWifi(b)) - Number(engine.onWifi(a)) || b.thrMbps - a.thrMbps)
      .slice(0, MAX_USER_ROWS)
      .map((u) => {
        const carried = engine.onWifi(u);
        const state = carried ? 'wifi' : u.session ? (u.session.kind === 'voice' ? 'voice' : 'data') : 'idle';
        const rate = wifiRateMbps(rf, u.wifiSinr, ws.ueStreams, ws.alpha);
        return h('tr', { class: `si-user ${carried ? '' : 'idle'}`, title: carried ? 'Session over Wi-Fi · open this user' : u.session ? `${u.session.kind} session on cellular` : 'Associated, no session', onmousedown: () => this.app.openUser(u.id) },
          h('td', null, h('span', { class: `st-dot ${state}` }), u.name ?? `UE${u.id}`),
          h('td', { class: u.wifiRssi < ws.minRssiDbm + 3 ? 'bad' : '' }, fmt(u.wifiRssi, 0)),
          h('td', { class: u.wifiSinr < 5 ? 'bad' : '' }, fmt(u.wifiSinr, 1)),
          h('td', null, fmt(rate, 0)),
          h('td', null, carried ? (u.session!.kind === 'data' ? fmt(u.thrMbps, 1) : 'VoWiFi') : ''),
        );
      });
    this.body.append(
      h('h4', null, `Associated users (${users.length})`),
      users.length
        ? h('table', { class: 'meas si-users' }, h('tr', null, ...['UE', 'RSSI', 'SINR', 'PHY Mbps', 'Mbps'].map((t) => h('th', null, t))), ...rows)
        : h('div', { class: 'hint' }, 'No phones associated.'),
      users.length > MAX_USER_ROWS ? h('div', { class: 'hint' }, `…and ${users.length - MAX_USER_ROWS} more`) : '',
    );

    const evs = engine.log.events.filter((e) => e.ap === ap.id).slice(-8).reverse();
    this.body.append(
      h('h4', null, 'Recent events'),
      h('div', { class: 'ui-events' },
        ...(evs.length
          ? evs.map((e) => h('div', { class: 'ui-ev', onmousedown: () => this.app.openUser(e.userId), style: 'cursor:pointer' },
              h('span', { class: 't' }, fmtTime(e.t)),
              h('span', { class: 'ty', style: `--c:${EVENT_COLOR[e.type]}` }, EVENT_LABEL[e.type]),
              h('span', { class: 'd' }, `UE${e.userId} ${e.detail}`),
            ))
          : [h('div', { class: 'hint' }, 'None yet')]),
      ),
    );
  }
}
