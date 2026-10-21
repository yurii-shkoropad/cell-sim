import type { BaseStation, Sector, Tech } from '../types';

export interface StationPreset {
  key: string;
  label: string;
  tech: Tech;
  band: string;
  freqMHz: number;
  bandwidthMHz: number;
  txPowerDbm: number;
  heightM: number;
  gain: number;
  hBeamwidth: number;
  vBeamwidth: number;
  tilt: number;
  frontToBack: number;
  trxCount: number;
  maxUsers: number;
}

export const PRESETS: StationPreset[] = [
  { key: 'gsm900', label: 'GSM 900', tech: 'GSM', band: 'GSM900', freqMHz: 947.4, bandwidthMHz: 0.2, txPowerDbm: 43, heightM: 30, gain: 15.5, hBeamwidth: 65, vBeamwidth: 10, tilt: 3, frontToBack: 25, trxCount: 2, maxUsers: 14 },
  { key: 'gsm1800', label: 'GSM 1800', tech: 'GSM', band: 'DCS1800', freqMHz: 1850.2, bandwidthMHz: 0.2, txPowerDbm: 43, heightM: 30, gain: 17, hBeamwidth: 65, vBeamwidth: 8, tilt: 4, frontToBack: 25, trxCount: 2, maxUsers: 14 },
  { key: 'lte800', label: 'LTE 800 (B20)', tech: 'LTE', band: 'B20', freqMHz: 806, bandwidthMHz: 10, txPowerDbm: 46, heightM: 35, gain: 15, hBeamwidth: 65, vBeamwidth: 12, tilt: 3, frontToBack: 25, trxCount: 1, maxUsers: 200 },
  { key: 'lte1800', label: 'LTE 1800 (B3)', tech: 'LTE', band: 'B3', freqMHz: 1815, bandwidthMHz: 20, txPowerDbm: 46, heightM: 30, gain: 17.5, hBeamwidth: 65, vBeamwidth: 7, tilt: 5, frontToBack: 25, trxCount: 1, maxUsers: 200 },
  { key: 'lte2100', label: 'LTE 2100 (B1)', tech: 'LTE', band: 'B1', freqMHz: 2140, bandwidthMHz: 15, txPowerDbm: 46, heightM: 30, gain: 18, hBeamwidth: 65, vBeamwidth: 6.5, tilt: 5, frontToBack: 25, trxCount: 1, maxUsers: 200 },
  { key: 'lte2600', label: 'LTE 2600 (B7)', tech: 'LTE', band: 'B7', freqMHz: 2655, bandwidthMHz: 20, txPowerDbm: 46, heightM: 28, gain: 18, hBeamwidth: 65, vBeamwidth: 6, tilt: 6, frontToBack: 25, trxCount: 1, maxUsers: 200 },
  { key: 'nr3500', label: 'NR 3500 (n78)', tech: 'NR', band: 'n78', freqMHz: 3550, bandwidthMHz: 100, txPowerDbm: 49, heightM: 28, gain: 24, hBeamwidth: 65, vBeamwidth: 8, tilt: 6, frontToBack: 30, trxCount: 1, maxUsers: 400 },
  { key: 'nr700', label: 'NR 700 (n28)', tech: 'NR', band: 'n28', freqMHz: 773, bandwidthMHz: 10, txPowerDbm: 46, heightM: 35, gain: 15, hBeamwidth: 65, vBeamwidth: 12, tilt: 3, frontToBack: 25, trxCount: 1, maxUsers: 200 },
];

export const presetByKey = (key: string) => PRESETS.find((p) => p.key === key) ?? PRESETS[3];

const LTE_PRB: Record<string, number> = { '1.4': 6, '3': 15, '5': 25, '10': 50, '15': 75, '20': 100 };
const NR_RB_30K: Record<string, number> = { '5': 11, '10': 24, '15': 38, '20': 51, '25': 65, '30': 78, '40': 106, '50': 133, '60': 162, '70': 189, '80': 217, '90': 245, '100': 273 };
const NR_RB_15K: Record<string, number> = { '5': 25, '10': 52, '15': 79, '20': 106, '25': 133, '30': 160, '40': 216, '50': 270 };

/** NR subcarrier spacing: 30 kHz in mid-band (>3 GHz), 15 kHz below. */
export const nrScsKHz = (freqMHz: number) => (freqMHz > 3000 ? 30 : 15);

/** Number of resource blocks for a carrier (rounded down to a valid table entry if needed). */
export function resourceBlocks(tech: Tech, bwMHz: number, freqMHz: number): number {
  if (tech === 'GSM') return 0;
  const table = tech === 'LTE' ? LTE_PRB : nrScsKHz(freqMHz) === 30 ? NR_RB_30K : NR_RB_15K;
  const exact = table[String(bwMHz)];
  if (exact) return exact;
  // Fallback: ~90% spectral occupancy.
  const rbBwMHz = tech === 'LTE' ? 0.18 : (12 * nrScsKHz(freqMHz)) / 1000;
  return Math.max(1, Math.floor((bwMHz * 0.9) / rbBwMHz));
}

/** Bandwidth of one resource block in Hz. */
export function rbBandwidthHz(tech: Tech, freqMHz: number): number {
  if (tech === 'LTE') return 180e3;
  if (tech === 'NR') return 12 * nrScsKHz(freqMHz) * 1e3;
  return 200e3;
}

/**
 * Number of power-sharing units the total sector power is divided into:
 * resource elements (subcarriers) for LTE/NR, 1 for a GSM BCCH carrier.
 * RSRP = P_tx - 10*log10(units) + gains - losses.
 */
export function powerUnits(tech: Tech, bwMHz: number, freqMHz: number): number {
  return tech === 'GSM' ? 1 : 12 * resourceBlocks(tech, bwMHz, freqMHz);
}

/** Effective occupied bandwidth used for noise and interference overlap, MHz. */
export function occupiedBandwidthMHz(tech: Tech, bwMHz: number, freqMHz: number): number {
  if (tech === 'GSM') return 0.2;
  return (resourceBlocks(tech, bwMHz, freqMHz) * rbBandwidthHz(tech, freqMHz)) / 1e6;
}

/** GSM traffic channels per sector: 8 timeslots per TRX, minus BCCH and SDCCH on the first. */
export const gsmTrafficChannels = (trx: number) => Math.max(0, 8 * trx - 2);

// ---------- Channel numbers (display only) ----------

const LTE_BANDS: { band: number; fLow: number; fHigh: number; nOffs: number }[] = [
  { band: 1, fLow: 2110, fHigh: 2170, nOffs: 0 },
  { band: 3, fLow: 1805, fHigh: 1880, nOffs: 1200 },
  { band: 7, fLow: 2620, fHigh: 2690, nOffs: 2750 },
  { band: 8, fLow: 925, fHigh: 960, nOffs: 3450 },
  { band: 20, fLow: 791, fHigh: 821, nOffs: 6150 },
  { band: 38, fLow: 2570, fHigh: 2620, nOffs: 37750 },
  { band: 40, fLow: 2300, fHigh: 2400, nOffs: 38650 },
];

/** ARFCN / EARFCN / NR-ARFCN for a downlink frequency, or null if not in a known band. */
export function channelNumber(tech: Tech, freqMHz: number): { label: string; value: number } | null {
  if (tech === 'GSM') {
    if (freqMHz >= 935.2 && freqMHz <= 959.8) return { label: 'ARFCN', value: Math.round((freqMHz - 935) / 0.2) };
    if (freqMHz >= 925.2 && freqMHz < 935.2) return { label: 'ARFCN', value: Math.round((freqMHz - 935) / 0.2) + 1024 };
    if (freqMHz >= 1805.2 && freqMHz <= 1879.8) return { label: 'ARFCN', value: Math.round((freqMHz - 1805.2) / 0.2) + 512 };
    return null;
  }
  if (tech === 'LTE') {
    const b = LTE_BANDS.find((x) => freqMHz >= x.fLow && freqMHz <= x.fHigh);
    return b ? { label: 'EARFCN', value: Math.round(b.nOffs + (freqMHz - b.fLow) * 10) } : null;
  }
  if (freqMHz < 3000) return { label: 'NR-ARFCN', value: Math.round(freqMHz / 0.005) };
  if (freqMHz < 24250) return { label: 'NR-ARFCN', value: Math.round(600000 + (freqMHz - 3000) / 0.015) };
  return null;
}

// ---------- Factories ----------

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function makeSector(p: StationPreset, azimuth: number, pci: number, omni = false): Sector {
  return {
    id: newId('s'),
    azimuth,
    hBeamwidth: omni ? 360 : p.hBeamwidth,
    vBeamwidth: p.vBeamwidth,
    tilt: p.tilt,
    gain: omni ? Math.max(p.gain - 7, 2) : p.gain,
    frontToBack: p.frontToBack,
    freqMHz: p.freqMHz,
    pci,
    enabled: true,
  };
}

export function makeStation(
  p: StationPreset,
  lat: number,
  lng: number,
  operatorId: string,
  name: string,
  opts: { sectors?: number; azimuthOffset?: number; pciBase?: number } = {},
): BaseStation {
  const n = opts.sectors ?? 3;
  const off = opts.azimuthOffset ?? 0;
  const base = opts.pciBase ?? 0;
  const sectors =
    n <= 1 ? [makeSector(p, 0, base, true)] : Array.from({ length: n }, (_, i) => makeSector(p, (off + (360 / n) * i) % 360, base + i));
  return {
    id: newId('bs'),
    name,
    lat,
    lng,
    operatorId,
    tech: p.tech,
    band: p.band,
    bandwidthMHz: p.bandwidthMHz,
    txPowerDbm: p.txPowerDbm,
    heightM: p.heightM,
    cableLossDb: 2,
    trxCount: p.trxCount,
    maxUsers: p.maxUsers,
    sectors,
    enabled: true,
  };
}
