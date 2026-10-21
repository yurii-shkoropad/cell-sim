import type { Environment, PathLossModel } from '../types';

/**
 * Okumura-Hata and COST-231 Hata median path loss.
 *
 * Both models have the form  L(d) = A + B * log10(d_km), so we precompute A and B
 * once per cell and evaluate cheaply for every pixel / user.
 *
 * Validity (as published):
 *   Okumura-Hata  f 150-1500 MHz, hb 30-200 m, hm 1-10 m, d 1-20 km
 *   COST-231 Hata f 1500-2000 MHz, same height/distance ranges
 * Outside those ranges the formulas are extrapolated; `validity()` reports which
 * limits are exceeded so the UI can warn about it.
 */

export interface PathLossCoeffs {
  A: number;
  B: number;
  model: 'okumura-hata' | 'cost231-hata';
  freqMHz: number;
}

/** Mobile antenna height correction a(hm), dB. */
export function mobileCorrection(freqMHz: number, hm: number, env: Environment): number {
  const lf = Math.log10(freqMHz);
  if (env === 'urban-large') {
    if (freqMHz <= 200) return 8.29 * Math.log10(1.54 * hm) ** 2 - 1.1;
    return 3.2 * Math.log10(11.75 * hm) ** 2 - 4.97;
  }
  return (1.1 * lf - 0.7) * hm - (1.56 * lf - 0.8);
}

export function resolveModel(model: PathLossModel, freqMHz: number): 'okumura-hata' | 'cost231-hata' {
  if (model !== 'auto') return model;
  return freqMHz <= 1500 ? 'okumura-hata' : 'cost231-hata';
}

export function pathLossCoeffs(
  freqMHz: number,
  hb: number,
  hm: number,
  env: Environment,
  model: PathLossModel,
): PathLossCoeffs {
  const m = resolveModel(model, freqMHz);
  const lf = Math.log10(freqMHz);
  // Guard against log of non-positive heights from bad input.
  const lhb = Math.log10(Math.max(hb, 1));
  const ahm = mobileCorrection(freqMHz, hm, env);
  const B = 44.9 - 6.55 * lhb;

  let A: number;
  if (m === 'okumura-hata') {
    A = 69.55 + 26.16 * lf - 13.82 * lhb - ahm;
  } else {
    const cm = env === 'urban-large' ? 3 : 0;
    A = 46.3 + 33.9 * lf - 13.82 * lhb - ahm + cm;
  }

  // Environment corrections relative to the urban formula (Hata 1980). They are
  // applied to COST-231 too, which is common practice in planning tools.
  if (env === 'suburban') {
    A -= 2 * Math.log10(freqMHz / 28) ** 2 + 5.4;
  } else if (env === 'rural') {
    A -= 4.78 * lf ** 2 - 18.33 * lf + 40.94;
  }
  return { A, B, model: m, freqMHz };
}

/** Free-space path loss, dB. */
export function fspl(freqMHz: number, dKm: number): number {
  return 32.45 + 20 * Math.log10(freqMHz) + 20 * Math.log10(dKm);
}

/** Minimum evaluation distance; avoids the log singularity at the mast. */
export const MIN_DISTANCE_KM = 0.01;

/**
 * Median path loss at distance d (km). Below the model's 1 km lower limit the
 * empirical curve can drop under free space, so we never return less than FSPL.
 */
export function pathLoss(c: PathLossCoeffs, dKm: number): number {
  const d = Math.max(dKm, MIN_DISTANCE_KM);
  const ld = Math.log10(d);
  const hata = c.A + c.B * ld;
  const fs = 32.45 + 20 * Math.log10(c.freqMHz) + 20 * ld;
  return hata > fs ? hata : fs;
}

export interface ValidityIssue {
  param: string;
  message: string;
}

export function validity(freqMHz: number, hb: number, hm: number, model: PathLossModel): ValidityIssue[] {
  const m = resolveModel(model, freqMHz);
  const issues: ValidityIssue[] = [];
  const [fLo, fHi] = m === 'okumura-hata' ? [150, 1500] : [1500, 2000];
  if (freqMHz < fLo || freqMHz > fHi) {
    issues.push({ param: 'frequency', message: `${freqMHz} MHz is outside ${m} range ${fLo}-${fHi} MHz (extrapolated)` });
  }
  if (hb < 30 || hb > 200) {
    issues.push({ param: 'height', message: `Antenna height ${hb} m outside 30-200 m (extrapolated)` });
  }
  if (hm < 1 || hm > 10) {
    issues.push({ param: 'ue height', message: `UE height ${hm} m outside 1-10 m` });
  }
  return issues;
}
