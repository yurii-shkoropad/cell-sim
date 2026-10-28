import { newId } from '../../radio/presets';
import { alignedChannels, WIFI_BANDS, wifiRangeM } from '../../radio/wifi';
import type { OffloadPolicy, WifiAp } from '../../types';
import { apFields } from '../apConfig';
import type { App } from '../app';
import { button, checkField, clear, fmt, h, numField, section, selectField, toast } from '../dom';

const POLICIES: [OffloadPolicy, string][] = [
  ['prefer-wifi', 'Always prefer Wi-Fi'],
  ['better-throughput', 'Only when Wi-Fi is faster'],
  ['cell-load', 'Only when the cell is loaded'],
];

const POLICY_NOTE: Record<OffloadPolicy, string> = {
  'prefer-wifi': 'Like a phone by default: data moves to any usable AP (RSSI ≥ min + hysteresis).',
  'better-throughput': 'Joins only if the estimated Wi-Fi throughput (AP rate shared by its active users, capped by backhaul) beats the current cellular throughput by the margin.',
  'cell-load': 'Network-steered (ANDSF / ATSSS-like): joins only while the serving cell\'s PRB load is at or above the threshold.',
};

/** Wi-Fi tab: offload settings, AP template and placement, AP list with live statistics. */
export function wifiPanel(app: App): HTMLElement {
  const { store } = app;
  const root = h('div', { class: 'panel' });
  const ws = () => store.scenario.settings.wifi;
  const changed = () => store.emit('settings');

  // ---------------------------------------------------------------- summary
  const summary = h('div', { class: 'kv-grid' });
  const renderSummary = () => {
    const { engine } = app;
    const kv = (k: string, v: string) => h('div', { class: 'kv' }, h('span', null, k), h('b', null, v));
    clear(summary);
    if (!ws().enabled) {
      summary.append(h('p', { class: 'hint' }, 'Wi-Fi offloading is off: every session uses the cellular network.'));
      return;
    }
    const assoc = engine.users.filter((u) => u.wifiAp >= 0).length;
    const carried = engine.users.filter((u) => engine.onWifi(u)).length;
    const wifiOn = engine.users.filter((u) => u.wifiOn).length;
    const wifiMbps = engine.aps.reduce((a, x) => a + x.servedMbps, 0);
    const cellMbps = engine.cells.reduce((a, x) => a + x.servedMbps, 0);
    summary.append(
      kv('Phones', `${wifiOn} of ${engine.users.length} with Wi-Fi on · ${assoc} associated`),
      kv('Sessions', `${carried} over Wi-Fi`),
      kv('Throughput', `${fmt(wifiMbps, 1)} Mbps Wi-Fi · ${fmt(cellMbps, 1)} Mbps cellular (${wifiMbps + cellMbps > 0 ? Math.round((100 * wifiMbps) / (wifiMbps + cellMbps)) : 0}% offloaded)`),
      kv('Moves', `${engine.counters.wifiOffloads} offloaded · ${engine.counters.wifiFallbacks} back to cellular`),
    );
  };

  root.appendChild(section('Wi-Fi offload', summary));

  // ---------------------------------------------------------------- policy
  const policyNote = h('p', { class: 'hint' }, POLICY_NOTE[ws().policy]);
  const policyExtra = h('div');
  const renderPolicyExtra = () => {
    clear(policyExtra);
    policyNote.textContent = POLICY_NOTE[ws().policy];
    if (ws().policy === 'cell-load') policyExtra.append(numField('Cell load threshold', () => ws().loadThreshold, (v) => ((ws().loadThreshold = v), changed()), { min: 0, max: 100, step: 5, unit: '%', scale: 100 }));
    if (ws().policy === 'better-throughput') policyExtra.append(numField('Wi-Fi must be faster by', () => ws().throughputMargin, (v) => ((ws().throughputMargin = v), changed()), { min: 0, max: 500, step: 5, unit: '%', scale: 100, title: '120% = Wi-Fi estimate must be at least 1.2 × the cellular throughput' }));
  };
  renderPolicyExtra();
  root.appendChild(
    section('Offload policy',
      checkField('Wi-Fi offloading enabled', () => ws().enabled, (v) => ((ws().enabled = v), changed())),
      selectField('Policy', POLICIES, () => ws().policy, (v) => {
        ws().policy = v;
        renderPolicyExtra();
        changed();
      }),
      policyNote,
      policyExtra,
      numField('Phones with Wi-Fi on', () => ws().deviceShare, (v) => ((ws().deviceShare = v), changed()), { min: 0, max: 100, step: 5, unit: '%', scale: 100, title: 'For users without their own setting (user inspector → Wi-Fi). Stable per user.' }),
      numField('Min RSSI', () => ws().minRssiDbm, (v) => ((ws().minRssiDbm = v), changed()), { min: -95, max: -40, step: 1, unit: 'dBm', title: 'Leave the AP below this; the dashed circles on the map show where the median RSSI equals it' }),
      numField('Hysteresis', () => ws().hysteresisDb, (v) => ((ws().hysteresisDb = v), changed()), { min: 0, max: 20, step: 1, unit: 'dB', title: 'Join at min RSSI + hysteresis; roam to another AP when it is stronger by this' }),
      numField('Association delay', () => ws().assocDelayMs, (v) => ((ws().assocDelayMs = v), changed()), { min: 0, max: 30000, step: 500, unit: 'ms', title: 'Scan, authentication and DHCP: the join condition must hold this long' }),
      numField('Max speed on Wi-Fi', () => ws().maxSpeedKmh, (v) => ((ws().maxSpeedKmh = v), changed()), { min: 0, max: 200, step: 1, unit: 'km/h', title: 'Faster users (vehicles) stay on cellular' }),
      checkField('Voice over Wi-Fi (VoWiFi)', () => ws().voiceOverWifi, (v) => ((ws().voiceOverWifi = v), changed()), 'Off: voice calls always use cellular, only data moves to Wi-Fi'),
    ),
  );

  root.appendChild(
    section('Wi-Fi propagation & PHY',
      h('details', null,
        h('summary', null, 'Model parameters'),
        numField('Path-loss slope indoor', () => ws().indoorSlope, (v) => ((ws().indoorSlope = v), changed()), { min: 2, max: 5, step: 0.1, title: 'n in L = 20·log f − 27.55 + 10·n·log d (ITU-R P.1238 office ≈ 3.0–3.1)' }),
        numField('Path-loss slope outdoor', () => ws().outdoorSlope, (v) => ((ws().outdoorSlope = v), changed()), { min: 2, max: 5, step: 0.1, title: 'Street level, mostly LOS: ≈ 2.5–3' }),
        numField('Shadowing σ', () => ws().shadowingSigmaDb, (v) => ((ws().shadowingSigmaDb = v), changed()), { min: 0, max: 12, step: 0.5, unit: 'dB' }),
        numField('MAC efficiency', () => ws().macEfficiency, (v) => ((ws().macEfficiency = v), changed()), { min: 10, max: 100, step: 5, unit: '%', scale: 100, title: 'Share of the PHY rate left after CSMA/CA, ACKs, headers (≈ 60–70%)' }),
        numField('Shannon α', () => ws().alpha, (v) => ((ws().alpha = v), changed()), { min: 0.3, max: 1, step: 0.05 }),
        numField('Phone spatial streams', () => ws().ueStreams, (v) => ((ws().ueStreams = Math.round(v)), changed()), { min: 1, max: 4, step: 1 }),
      ),
    ),
  );

  // ---------------------------------------------------------------- add APs
  const tpl: WifiAp = { id: '', name: '', lat: 0, lng: 0, band: '5', channel: 36, widthMHz: 80, standard: 'ax', streams: 2, txPowerDbm: 23, indoor: true, maxUsers: 50, backhaulMbps: 500, access: 'public', enabled: true };
  const tplHost = h('div');
  const renderTpl = () => {
    clear(tplHost);
    tplHost.append(apFields(store.scenario, tpl, () => app.mapView.refreshBanner(), renderTpl));
  };
  renderTpl();
  const scatter = { count: 10 };

  /** Next channel for a new AP: cycle the non-overlapping channels of the band. */
  const nextChannel = () => {
    const usable = alignedChannels(tpl.band, tpl.widthMHz);
    if (!usable.length) return WIFI_BANDS[tpl.band].defaultChannel;
    const n = (store.scenario.wifi ?? []).filter((a) => a.band === tpl.band).length;
    return usable[n % usable.length];
  };
  const makeAp = (lat: number, lng: number): WifiAp => {
    const n = (store.scenario.wifi ?? []).length + 1;
    return { ...tpl, id: newId('ap'), name: `AP-${n}`, lat, lng, channel: nextChannel() };
  };
  const addAps = (list: WifiAp[]) => {
    (store.scenario.wifi ??= []).push(...list);
    store.emit('network');
  };

  const addBtn = button('Add APs on map', () => app.mapView.setPlaceMode(app.mapView.placeMode === 'wifi' ? null : 'wifi'), 'primary', 'Click the map to place APs and drag existing ones; Esc or Done to finish');
  app.mapView.onPlaceModeChange(() => {
    const on = app.mapView.placeMode === 'wifi';
    addBtn.classList.toggle('active', on);
    addBtn.textContent = on ? 'Done adding' : 'Add APs on map';
  });
  app.mapView.placeHint.wifi = () => `Adding ${WIFI_BANDS[tpl.band].label} ${tpl.widthMHz} MHz ${tpl.standard} AP · ${tpl.txPowerDbm} dBm · ${tpl.access === 'public' ? 'public' : (store.scenario.operators.find((o) => o.id === tpl.access)?.name ?? '?') + ' only'}`;
  app.mapView.onAddAp = (lat, lng) => addAps([makeAp(lat, lng)]);

  root.appendChild(
    section('Add access points',
      tplHost,
      h('div', { class: 'row' }, addBtn),
      h('details', null,
        h('summary', null, 'Scatter in view'),
        numField('Count', () => scatter.count, (v) => (scatter.count = Math.round(v)), { min: 1, max: 200, step: 1 }),
        h('div', { class: 'row' },
          button('Scatter APs in current view', () => {
            const b = app.mapView.map.getBounds().pad(-0.1);
            const list: WifiAp[] = [];
            for (let i = 0; i < scatter.count; i++) {
              const ap = makeAp(b.getSouth() + Math.random() * (b.getNorth() - b.getSouth()), b.getWest() + Math.random() * (b.getEast() - b.getWest()));
              (store.scenario.wifi ??= []).push(ap); // so nextChannel / names see it
              list.push(ap);
            }
            store.emit('network');
            toast(`Added ${list.length} APs`, 'ok');
          }),
        ),
      ),
      h('p', { class: 'hint' }, 'New APs take the next non-overlapping channel of the band. Click an AP on the map to inspect or edit it.'),
    ),
  );

  // ---------------------------------------------------------------- AP list
  const listHost = h('div');
  const renderList = () => {
    clear(listHost);
    const aps = store.scenario.wifi ?? [];
    const { engine } = app;
    const ctx = app.ctx();
    const idx = new Map(ctx.wifi.map((a, i) => [a.apId, i]));
    if (!aps.length) {
      listHost.append(h('p', { class: 'hint' }, 'No access points. Add some on the map.'));
      return;
    }
    listHost.append(
      h('div', { class: 'ul-list' },
        h('table', { class: 'meas ul-table' },
          h('tr', null, ...['', 'AP', 'Band/ch', 'Users', 'Air', 'Mbps', ''].map((t) => h('th', null, t))),
          ...aps.map((ap) => {
            const i = idx.get(ap.id);
            const st = i !== undefined ? engine.aps[i] : undefined;
            const on = h('input', { type: 'checkbox', checked: ap.enabled, title: 'On air', onchange: () => {
              ap.enabled = on.checked;
              store.emit('network');
            } });
            const range = i !== undefined ? Math.round(wifiRangeM(ctx.wifi[i], ws().minRssiDbm)) : null;
            return h('tr', { class: `ul-row ${store.selectedApId === ap.id ? 'sel' : ''}`, title: range !== null ? `Association range ≈ ${range} m` : 'Off air' },
              h('td', { onmousedown: (e: Event) => e.stopPropagation() }, on),
              h('td', { class: 'ul-name', onmousedown: () => store.selectAp(ap.id) }, h('span', { class: 'dot', style: `background:${app.mapView.apColor(ap)}` }), ' ', ap.name),
              h('td', { onmousedown: () => store.selectAp(ap.id) }, `${ap.band} · ${ap.channel} · ${ap.widthMHz}`),
              h('td', { onmousedown: () => store.selectAp(ap.id) }, st ? `${st.active}/${st.assoc}` : '—'),
              h('td', { onmousedown: () => store.selectAp(ap.id) }, st ? `${Math.round(st.airtime * 100)}%` : '—'),
              h('td', { onmousedown: () => store.selectAp(ap.id) }, st ? fmt(st.servedMbps, 1) : '—'),
              h('td', null, button('×', () => store.removeAps(new Set([ap.id])), 'icon ghost', 'Delete this AP')),
            );
          }),
        ),
      ),
      h('div', { class: 'row' },
        button('Delete all APs', () => {
          if (confirm(`Delete all ${aps.length} access points?`)) store.removeAps(new Set(aps.map((a) => a.id)));
        }, 'danger'),
      ),
      h('p', { class: 'hint' }, 'Users = sessions over Wi-Fi / associated phones · Air = airtime in use.'),
    );
  };
  renderList();
  root.appendChild(section('Access points', listHost));

  store.on('network', renderList);
  store.on('selection', renderList);
  store.on('scenario', () => {
    renderPolicyExtra();
    renderList();
  });
  app.onLiveTick(() => {
    if (root.offsetParent === null) return; // tab hidden
    renderSummary();
    renderList();
  });
  renderSummary();
  return root;
}
