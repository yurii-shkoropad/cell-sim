import type { RadioSettings, Tech } from '../types';

export type AntennaTypeKey = 'siso' | '2t2r' | '4t4r' | '8t8r' | '32t32r' | '64t64r';

export interface AntennaType {
  key: AntennaTypeKey;
  label: string;
  /** Transmit antenna ports / TRX chains. */
  ports: number;
  /** Max spatial layers to one UE (SU-MIMO). */
  maxLayers: number;
  /**
   * Static array / beamforming gain on top of the panel gain, dB. Applied to the
   * whole link (reference signals are beam-swept too), so it extends coverage.
   */
  bfGainDb: number;
  /** Max users co-scheduled on the same RBs (MU-MIMO). */
  maxMu: number;
  techs: Tech[];
  /** Codebook (precoding) MIMO gets a transmit precoding gain; beamforming types have it in bfGainDb. */
  codebook: boolean;
  note: string;
}

export const ANTENNA_TYPES: AntennaType[] = [
  { key: 'siso', label: 'SISO (1T1R)', ports: 1, maxLayers: 1, bfGainDb: 0, maxMu: 1, techs: ['GSM', 'LTE', 'NR'], codebook: false, note: 'Single transmit path, one layer.' },
  { key: '2t2r', label: '2×2 MIMO (2T2R)', ports: 2, maxLayers: 2, bfGainDb: 0, maxMu: 1, techs: ['LTE', 'NR'], codebook: true, note: 'Most common LTE configuration: up to 2 layers.' },
  { key: '4t4r', label: '4×4 MIMO (4T4R)', ports: 4, maxLayers: 4, bfGainDb: 0, maxMu: 1, techs: ['LTE', 'NR'], codebook: true, note: 'Up to 4 layers to 4Rx devices; 2Rx devices get transmit precoding gain.' },
  { key: '8t8r', label: '8T8R beamforming', ports: 8, maxLayers: 4, bfGainDb: 3, maxMu: 2, techs: ['LTE', 'NR'], codebook: false, note: 'Beamforming array (LTE TM9 / NR): +3 dB, 2-user MU-MIMO.' },
  { key: '32t32r', label: 'Massive MIMO 32T32R', ports: 32, maxLayers: 4, bfGainDb: 6, maxMu: 4, techs: ['NR'], codebook: false, note: 'Active antenna unit: +6 dB beamforming gain, up to 4 users per RB.' },
  { key: '64t64r', label: 'Massive MIMO 64T64R', ports: 64, maxLayers: 4, bfGainDb: 7.5, maxMu: 8, techs: ['NR'], codebook: false, note: 'Active antenna unit: +7.5 dB beamforming gain, up to 8 users per RB.' },
];

export const antennaType = (key: string | undefined): AntennaType => ANTENNA_TYPES.find((a) => a.key === key) ?? ANTENNA_TYPES[0];

export const antennaTypesFor = (tech: Tech) => ANTENNA_TYPES.filter((a) => a.techs.includes(tech));

/** Fall back to SISO when a type isn't valid for the technology (e.g. after switching a station to GSM). */
export function validAntennaFor(tech: Tech, key: string | undefined): AntennaTypeKey {
  const t = antennaType(key);
  return t.techs.includes(tech) ? t.key : 'siso';
}

export interface MimoLink {
  /** Transmit ports at the cell. */
  ports: number;
  maxLayers: number;
  codebook: boolean;
}

export interface RankChoice {
  rank: number;
  /** Total spectral efficiency over all layers, bps/Hz. */
  se: number;
  /** Per-layer SINR at the chosen rank, dB. */
  layerSinrDb: number;
}

/**
 * Rank adaptation for SU-MIMO. For each rank r ≤ min(ports, UE Rx, maxLayers):
 *   SINR_layer(r) = SINR − 10·log10(r)                      (power split over layers)
 *                 + 10·log10(N_rx − r + 1)                  (receive combining, ZF/MMSE diversity order)
 *                 + η·10·log10(N_tx / r)   [codebook only]  (transmit precoding gain)
 *   SE(r) = r · min(α·log2(1 + SINR_layer), SE_max)          (0 if SINR_layer < SINR_min)
 * and the rank with the highest SE is used.
 */
export function bestRank(sinrDb: number, link: MimoLink, ueRx: number, seMax: number, r: RadioSettings): RankChoice {
  const L = Math.max(1, Math.min(link.ports, ueRx, link.maxLayers));
  let best: RankChoice = { rank: 1, se: 0, layerSinrDb: -Infinity };
  for (let rank = 1; rank <= L; rank++) {
    let s = sinrDb - 10 * Math.log10(rank) + 10 * Math.log10(Math.max(1, ueRx - rank + 1));
    if (link.codebook && link.ports > rank) s += r.precodingEfficiency * 10 * Math.log10(link.ports / rank);
    const perLayer = s < r.sinrMinDb ? 0 : Math.min(r.shannonAlpha * Math.log2(1 + Math.pow(10, s / 10)), seMax);
    const se = rank * perLayer;
    if (rank === 1 || se > best.se) best = { rank, se, layerSinrDb: s };
  }
  return best;
}

/**
 * MU-MIMO capacity multiplier on the RB pool when `n` data users share a cell:
 * 1 + (min(n, maxMu) − 1)·η, with η the pairing efficiency (imperfect user separation).
 */
export function muMimoGain(maxMu: number, n: number, efficiency: number): number {
  return 1 + (Math.min(Math.max(n, 1), maxMu) - 1) * efficiency;
}
