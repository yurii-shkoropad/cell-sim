import { WIFI_BANDS, WIFI_STANDARDS } from '../radio/wifi';
import type { Scenario, WifiAp, WifiBand, WifiStandard } from '../types';
import { checkField, h, numField, selectField, textField } from './dom';

/** Keep channel, width and standard valid for the AP's band. */
export function normaliseAp(ap: WifiAp) {
  const b = WIFI_BANDS[ap.band];
  if (!b.channels.includes(ap.channel)) ap.channel = b.defaultChannel;
  if (!b.widths.includes(ap.widthMHz)) ap.widthMHz = b.widths[Math.min(b.widths.length - 1, 2)];
  if (!WIFI_STANDARDS[ap.standard].bands.includes(ap.band)) ap.standard = 'ax';
  ap.streams = Math.max(1, Math.min(ap.streams, WIFI_STANDARDS[ap.standard].maxStreams));
}

/**
 * Editor for one AP's radio and access settings (the Wi-Fi tab template and the AP
 * inspector). `changed` is called after every edit; `rerender` when the form itself
 * must change (band → valid channels, widths and standards).
 */
export function apFields(scn: Scenario, ap: WifiAp, changed: () => void, rerender: () => void, withPosition = false): HTMLElement {
  const b = WIFI_BANDS[ap.band];
  const std = (Object.keys(WIFI_STANDARDS) as WifiStandard[]).filter((k) => WIFI_STANDARDS[k].bands.includes(ap.band));
  const set = (fn: () => void, form = false) => {
    fn();
    normaliseAp(ap);
    changed();
    if (form) rerender();
  };
  return h('div', null,
    withPosition ? textField('Name', () => ap.name, (v) => set(() => (ap.name = v.trim() || ap.name))) : null,
    selectField('Band', (Object.keys(WIFI_BANDS) as WifiBand[]).map((k) => [k, WIFI_BANDS[k].label] as [WifiBand, string]), () => ap.band, (v) => set(() => (ap.band = v), true)),
    selectField('Channel', b.channels.map((c) => [String(c), `${c} (${b.freq(c)} MHz)`] as [string, string]), () => String(ap.channel), (v) => set(() => (ap.channel = +v)), 'Primary 20 MHz channel; wider channels bond the channels above it. APs whose channels overlap interfere with each other.'),
    selectField('Channel width', b.widths.map((w) => [String(w), `${w} MHz`] as [string, string]), () => String(ap.widthMHz), (v) => set(() => (ap.widthMHz = +v))),
    selectField('Standard', std.map((k) => [k, WIFI_STANDARDS[k].label] as [WifiStandard, string]), () => ap.standard, (v) => set(() => (ap.standard = v), true), 'Sets the top MCS: 802.11n 64QAM 5/6, ac 256QAM 5/6, ax 1024QAM 5/6'),
    selectField('Spatial streams', ['1', '2', '3', '4'].map((n) => [n, `${n}×${n} MIMO`] as [string, string]), () => String(ap.streams), (v) => set(() => (ap.streams = +v))),
    numField('EIRP', () => ap.txPowerDbm, (v) => set(() => (ap.txPowerDbm = v)), { min: 0, max: 36, step: 1, unit: 'dBm', title: 'Transmit power plus antenna gain. Typical indoor 20–23 dBm, outdoor 26–30 dBm (regional limits apply).' }),
    checkField('Indoor AP', () => ap.indoor, (v) => set(() => (ap.indoor = v)), 'Indoor: path-loss slope for inside buildings; outdoor: street-level slope (Wi-Fi tab → Propagation)'),
    numField('Max associated users', () => ap.maxUsers, (v) => set(() => (ap.maxUsers = Math.round(v))), { min: 1, max: 500, step: 1 }),
    numField('Backhaul', () => ap.backhaulMbps, (v) => set(() => (ap.backhaulMbps = v)), { min: 1, step: 10, unit: 'Mbps', title: 'Internet uplink of the AP: caps the total throughput it can deliver' }),
    selectField('Access', [['public', 'Public (any subscriber)'], ...scn.operators.map((o) => [o.id, `${o.name} subscribers only`] as [string, string])], () => ap.access, (v) => set(() => (ap.access = v)), 'Operator Wi-Fi (e.g. carrier hotspots) accepts only that operator\'s subscribers'),
    withPosition
      ? h('div', null,
          numField('Latitude', () => ap.lat, (v) => set(() => (ap.lat = v)), { step: 0.0001 }),
          numField('Longitude', () => ap.lng, (v) => set(() => (ap.lng = v)), { step: 0.0001 }),
        )
      : null,
  );
}
