import type { Tech } from '../types';

export type ModulationKey = 'gmsk' | 'qpsk' | '16qam' | '64qam' | '256qam' | '1024qam';

export interface Modulation {
  key: ModulationKey;
  label: string;
  bitsPerSymbol: number;
  /**
   * Highest spectral efficiency of this modulation, bps/Hz per layer: the top CQI
   * entry that uses it (TS 36.213 / 38.214 CQI tables 1, 2 and 4).
   */
  seMax: number;
  techs: Tech[];
  /** Map colour for the modulation heatmap. */
  color: string;
}

export const MODULATIONS: Modulation[] = [
  { key: 'gmsk', label: 'GMSK (GSM)', bitsPerSymbol: 1, seMax: 0, techs: ['GSM'], color: '#888888' },
  { key: 'qpsk', label: 'QPSK', bitsPerSymbol: 2, seMax: 1.1758, techs: ['LTE', 'NR'], color: '#e34948' },
  { key: '16qam', label: '16QAM', bitsPerSymbol: 4, seMax: 2.7305, techs: ['LTE', 'NR'], color: '#eda100' },
  { key: '64qam', label: '64QAM', bitsPerSymbol: 6, seMax: 5.5547, techs: ['LTE', 'NR'], color: '#1baf7a' },
  { key: '256qam', label: '256QAM', bitsPerSymbol: 8, seMax: 7.4063, techs: ['LTE', 'NR'], color: '#2a78d6' },
  { key: '1024qam', label: '1024QAM', bitsPerSymbol: 10, seMax: 9.2578, techs: ['NR'], color: '#4a3aa7' },
];

const byKey = new Map(MODULATIONS.map((m) => [m.key, m]));

export const modulationsFor = (tech: Tech) => MODULATIONS.filter((m) => m.techs.includes(tech));

/** Default when a station has none (older files): 64QAM for LTE, 256QAM for NR. */
export const defaultModulation = (tech: Tech): ModulationKey => (tech === 'GSM' ? 'gmsk' : tech === 'NR' ? '256qam' : '64qam');

/** The station's max modulation, falling back to the RAT default if missing or unsupported. */
export function validModulationFor(tech: Tech, key: string | undefined): ModulationKey {
  const m = key ? byKey.get(key as ModulationKey) : undefined;
  return m && m.techs.includes(tech) ? m.key : defaultModulation(tech);
}

export const modulation = (key: ModulationKey): Modulation => byKey.get(key)!;

/**
 * Modulation a link runs at for a given per-layer spectral efficiency: the lowest
 * order whose top CQI efficiency reaches it. Returns null when nothing can be sent.
 */
export function modulationForSe(sePerLayer: number, max: ModulationKey): Modulation | null {
  if (sePerLayer <= 0) return null;
  const cap = modulation(max);
  for (const m of MODULATIONS) {
    if (m.key === 'gmsk') continue;
    if (sePerLayer <= m.seMax + 1e-9 || m.key === cap.key) return m;
  }
  return cap;
}

/** Index into MODULATIONS for compact storage (heatmap); -1 = none. */
export const modulationIndex = (m: Modulation | null) => (m ? MODULATIONS.indexOf(m) : -1);
