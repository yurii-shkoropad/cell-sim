/**
 * COST-231 Walfisch–Ikegami path loss (COST Action 231 final report, ch. 4.4),
 * fed with building geometry along each path, plus ITU-R P.2109 building entry loss.
 *
 * Validity as published: f 800–2000 MHz, h_base 4–50 m, h_mobile 1–3 m, d 0.02–5 km.
 */

export interface WiPath {
  /** Ground distance, km. */
  dKm: number;
  freqMHz: number;
  /** Base-station antenna height, m. */
  hb: number;
  /** UE height, m. */
  hm: number;
  /** True when no building cuts the direct ray (street-canyon LOS). */
  los: boolean;
  /** Mean roof height of buildings crossed by the path, m (multi-screen term). */
  hRoofMean: number;
  /** Roof height of the last building before the UE, m (rooftop-to-street term). */
  hRoofLast: number;
  /** Building separation (centre to centre), m. */
  b: number;
  /** Street width, m (COST-231 recommends b/2 when unknown). */
  w: number;
  /** Angle between the street and the direct path, degrees (90 when unknown). */
  phiDeg: number;
  metropolitan: boolean;
}

export const fsplDb = (dKm: number, fMHz: number) => 32.4 + 20 * Math.log10(dKm) + 20 * Math.log10(fMHz);

/** Street orientation correction L_ori. */
export function orientationLoss(phi: number): number {
  if (phi < 35) return -10 + 0.354 * phi;
  if (phi < 55) return 2.5 + 0.075 * (phi - 35);
  return 4.0 - 0.114 * (phi - 55);
}

/** Rooftop-to-street diffraction and scatter loss, L_rts. */
export function rooftopToStreet(fMHz: number, w: number, hRoof: number, hm: number, phi: number): number {
  const dhm = Math.max(hRoof - hm, 0.5);
  return -16.9 - 10 * Math.log10(w) + 10 * Math.log10(fMHz) + 20 * Math.log10(dhm) + orientationLoss(phi);
}

/** Multi-screen diffraction loss over rows of buildings, L_msd. */
export function multiScreen(dKm: number, fMHz: number, hb: number, hRoof: number, b: number, metropolitan: boolean): number {
  const dhb = hb - hRoof;
  const above = dhb > 0;
  const lbsh = above ? -18 * Math.log10(1 + dhb) : 0;
  const ka = above ? 54 : dKm >= 0.5 ? 54 - 0.8 * dhb : 54 - (0.8 * dhb * dKm) / 0.5;
  const kd = above ? 18 : 18 - (15 * dhb) / Math.max(hRoof, 1);
  const kf = -4 + (metropolitan ? 1.5 : 0.7) * (fMHz / 925 - 1);
  return lbsh + ka + kd * Math.log10(dKm) + kf * Math.log10(fMHz) - 9 * Math.log10(b);
}

/** COST-231 Walfisch–Ikegami path loss, dB. */
export function walfischIkegami(p: WiPath): number {
  const d = Math.max(p.dKm, 0.02);
  if (p.los) {
    // Street-canyon LOS; never below free space.
    return Math.max(42.6 + 26 * Math.log10(d) + 20 * Math.log10(p.freqMHz), fsplDb(d, p.freqMHz));
  }
  const l0 = fsplDb(d, p.freqMHz);
  const extra = rooftopToStreet(p.freqMHz, p.w, p.hRoofLast, p.hm, p.phiDeg) + multiScreen(d, p.freqMHz, p.hb, p.hRoofMean, p.b, p.metropolitan);
  return l0 + Math.max(extra, 0);
}

export type BuildingEntryType = 'none' | 'traditional' | 'thermal';

/**
 * Median building entry loss, ITU-R P.2109-1 (horizontal path, 50th percentile):
 * L = r + s·log10(f) + t·log10²(f), f in GHz.
 */
export function buildingEntryLossDb(freqMHz: number, type: BuildingEntryType): number {
  if (type === 'none') return 0;
  const lf = Math.log10(freqMHz / 1000);
  const [r, s, t] = type === 'traditional' ? [12.64, 3.72, 0.96] : [28.19, -3.0, 8.48];
  return r + s * lf + t * lf * lf;
}
