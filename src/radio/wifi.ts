import { LocalProjection } from '../geo';
import type { Scenario, WifiAp, WifiBand, WifiSettings, WifiStandard } from '../types';
import { seedFromString, shadowingDb } from './shadowing';

/**
 * Wi-Fi access-point radio model.
 *
 *  Path loss (ITU-R P.1238 / log-distance): L = 20·log10(f_MHz) − 27.55 + 10·n·log10(d_m),
 *    i.e. free space at 1 m plus slope n (indoor ≈ 3.0, outdoor street level ≈ 3.5).
 *  SINR over the channel width with co-channel APs (same band, overlapping channels)
 *    weighted by their airtime activity.
 *  Rate: per spatial stream SE = min(α·log2(1+SINR), SEmax(standard)), × streams,
 *    × channel width × MAC efficiency (CSMA/CA, ACKs, headers), capped by backhaul.
 */

/** Top-MCS PHY rate per 20 MHz and spatial stream (short GI), Mbps → SE cap in b/s/Hz. */
export const WIFI_STANDARDS: Record<WifiStandard, { label: string; seMax: number; maxStreams: number; bands: WifiBand[] }> = {
  n: { label: '802.11n (Wi-Fi 4)', seMax: 72.2 / 20, maxStreams: 4, bands: ['2.4', '5'] },
  ac: { label: '802.11ac (Wi-Fi 5)', seMax: 86.7 / 20, maxStreams: 4, bands: ['5'] },
  ax: { label: '802.11ax (Wi-Fi 6/6E)', seMax: 143.4 / 20, maxStreams: 4, bands: ['2.4', '5', '6'] },
};

export const WIFI_BANDS: Record<WifiBand, { label: string; widths: number[]; channels: number[]; freq: (ch: number) => number; defaultChannel: number }> = {
  '2.4': { label: '2.4 GHz', widths: [20, 40], channels: [1, 6, 11], freq: (ch) => 2407 + 5 * ch, defaultChannel: 6 },
  '5': { label: '5 GHz', widths: [20, 40, 80, 160], channels: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161], freq: (ch) => 5000 + 5 * ch, defaultChannel: 36 },
  '6': { label: '6 GHz', widths: [20, 40, 80, 160], channels: [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 69, 73, 77, 81, 85, 89, 93], freq: (ch) => 5950 + 5 * ch, defaultChannel: 37 },
};

/**
 * Primary channels that start a valid, non-overlapping block of `widthMHz` in the band
 * (5 GHz: 36/52/100/116/132/149 for 80 MHz …; 2.4 GHz: 1, 6, 11).
 */
export function alignedChannels(band: WifiBand, widthMHz: number): number[] {
  const list = WIFI_BANDS[band].channels;
  if (band === '2.4') return list;
  const k = Math.max(1, widthMHz / 20);
  const base = (c: number) => (band === '5' ? (c < 149 ? 36 : 149) : 1);
  return list.filter((c) => (c - base(c)) % (4 * k) === 0 && Array.from({ length: k }, (_, i) => c + 4 * i).every((x) => list.includes(x)));
}

/** Flattened, serialisable AP description with per-AP constants precomputed. */
export interface WifiRF {
  idx: number;
  apId: string;
  name: string;
  x: number;
  y: number;
  lat: number;
  lng: number;
  /** Centre frequency of the occupied channel, MHz. */
  freqMHz: number;
  widthMHz: number;
  fLo: number;
  fHi: number;
  /** EIRP, dBm. */
  eirpDbm: number;
  /** 20·log10(f) − 27.55: path loss at 1 m, dB. */
  pl1m: number;
  /** Path-loss slope n. */
  slope: number;
  noiseDbm: number;
  seMax: number;
  streams: number;
  macEff: number;
  backhaulMbps: number;
  maxUsers: number;
  /** Operator index allowed to associate, or −1 for public. */
  opIdx: number;
  seed: number;
}

/** Occupied channel of an AP: primary channel extended to the channel width. */
function channelSpan(ap: WifiAp): { fc: number; lo: number; hi: number } {
  const f0 = WIFI_BANDS[ap.band].freq(ap.channel); // 20 MHz primary channel centre
  // Bonded channels extend upwards from the primary (simplified 802.11 channelisation).
  const lo = f0 - 10;
  const hi = lo + ap.widthMHz;
  return { fc: (lo + hi) / 2, lo, hi };
}

export function buildWifiRF(scn: Scenario): WifiRF[] {
  const ws = scn.settings.wifi;
  const proj = new LocalProjection(scn.center.lat, scn.center.lng);
  const ops = new Map(scn.operators.map((o, i) => [o.id, i]));
  const out: WifiRF[] = [];
  for (const ap of scn.wifi ?? []) {
    if (!ap.enabled) continue;
    const { x, y } = proj.toXY(ap.lat, ap.lng);
    const { fc, lo, hi } = channelSpan(ap);
    const std = WIFI_STANDARDS[ap.standard];
    out.push({
      idx: out.length,
      apId: ap.id,
      name: ap.name,
      x,
      y,
      lat: ap.lat,
      lng: ap.lng,
      freqMHz: fc,
      widthMHz: ap.widthMHz,
      fLo: lo,
      fHi: hi,
      eirpDbm: ap.txPowerDbm,
      pl1m: 20 * Math.log10(fc) - 27.55,
      slope: ap.indoor ? ws.indoorSlope : ws.outdoorSlope,
      noiseDbm: -174 + 10 * Math.log10(ap.widthMHz * 1e6) + scn.settings.radio.ueNoiseFigureDb,
      seMax: std.seMax,
      streams: Math.max(1, Math.min(ap.streams, std.maxStreams)),
      macEff: ws.macEfficiency,
      backhaulMbps: ap.backhaulMbps,
      maxUsers: ap.maxUsers,
      opIdx: ap.access === 'public' ? -1 : (ops.get(ap.access) ?? -1),
      seed: seedFromString(ap.id),
    });
  }
  return out;
}

/** Received power from an AP at local (x,y), dBm (EIRP − path loss − shadowing). */
export function wifiRssi(ap: WifiRF, x: number, y: number, ws: WifiSettings): number {
  const d = Math.max(Math.hypot(x - ap.x, y - ap.y), 1);
  const sh = ws.shadowingSigmaDb > 0 ? shadowingDb(ap.seed, x, y, ws.shadowingSigmaDb, 20) : 0;
  return ap.eirpDbm - (ap.pl1m + 10 * ap.slope * Math.log10(d)) - sh;
}

/** Distance at which the median RSSI falls to `rssiDbm`, m (association range circle). */
export function wifiRangeM(ap: WifiRF, rssiDbm: number): number {
  return Math.pow(10, (ap.eirpDbm - ap.pl1m - rssiDbm) / (10 * ap.slope));
}

/** Fraction of interferer b's channel that overlaps victim a's channel. */
export function wifiOverlap(a: WifiRF, b: WifiRF): number {
  const ov = Math.min(a.fHi, b.fHi) - Math.max(a.fLo, b.fLo);
  return ov > 0 ? ov / b.widthMHz : 0;
}

/**
 * SINR on AP i given RSSIs from all APs at the point and each AP's airtime
 * activity (co-channel APs only interfere while they transmit).
 */
export function wifiSinrDb(aps: WifiRF[], rssi: Float64Array, i: number, activity: Float32Array): number {
  const s = Math.pow(10, rssi[i] / 10);
  let interf = 0;
  for (let j = 0; j < aps.length; j++) {
    if (j === i || rssi[j] === -Infinity) continue;
    const f = wifiOverlap(aps[i], aps[j]);
    if (f > 0) interf += Math.pow(10, rssi[j] / 10) * f * activity[j];
  }
  return 10 * Math.log10(s / (interf + Math.pow(10, aps[i].noiseDbm / 10)));
}

/** PHY+MAC rate a user would get with the whole airtime of AP `ap`, Mbps. */
export function wifiRateMbps(ap: WifiRF, sinrDb: number, ueStreams: number, alpha: number): number {
  if (sinrDb < -2) return 0; // below the lowest MCS (BPSK 1/2 needs ~ +2 dB; allow a little margin)
  const streams = Math.max(1, Math.min(ap.streams, ueStreams));
  // More streams than the SINR supports would not be used: per-stream SINR drops by 10·log10(streams).
  let best = 0;
  for (let r = 1; r <= streams; r++) {
    const s = sinrDb - 10 * Math.log10(r);
    const se = Math.min(alpha * Math.log2(1 + Math.pow(10, s / 10)), ap.seMax);
    best = Math.max(best, r * se);
  }
  return best * ap.widthMHz * ap.macEff;
}

