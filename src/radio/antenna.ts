import { wrap180 } from '../geo';

/** Vertical side-lobe attenuation limit, dB (3GPP TR 36.814). */
export const SLA_V = 20;

/**
 * 3GPP TR 36.814 / 38.901 parabolic antenna pattern.
 *   A_H(φ) = -min(12 (φ/φ3dB)^2, Am)
 *   A_V(θ) = -min(12 ((θ-θtilt)/θ3dB)^2, SLAv)
 *   A(φ,θ) = -min(-(A_H + A_V), Am)
 * Returns the attenuation relative to boresight (<= 0 dB).
 *
 * @param relAzimuth  bearing to UE minus antenna azimuth, degrees
 * @param elevation   depression angle from antenna to UE, degrees (positive = below horizon)
 */
export function antennaAttenuation(
  relAzimuth: number,
  elevation: number,
  hBeamwidth: number,
  vBeamwidth: number,
  tilt: number,
  frontToBack: number,
): number {
  const ah = hBeamwidth >= 360 ? 0 : -Math.min(12 * (wrap180(relAzimuth) / hBeamwidth) ** 2, frontToBack);
  const av = -Math.min(12 * ((elevation - tilt) / vBeamwidth) ** 2, SLA_V);
  return -Math.min(-(ah + av), frontToBack);
}

export interface VerticalFootprint {
  /** Ground distance where the lower −3 dB edge (tilt + V-BW/2) reaches UE height, m. */
  near: number;
  /** Ground distance where the boresight (tilt) reaches UE height, m; Infinity if tilt ≤ 0. */
  peak: number;
  /** Ground distance where the upper −3 dB edge (tilt − V-BW/2) reaches UE height, m; Infinity if it never descends. */
  far: number;
}

/** Where the vertical main beam lands: d = (h_b − h_m) / tan(angle below horizon). */
export function verticalFootprint(hb: number, hm: number, tilt: number, vBeamwidth: number): VerticalFootprint {
  const dh = Math.max(hb - hm, 0.1);
  const at = (deg: number) => (deg <= 0 ? Infinity : deg >= 90 ? 0 : dh / Math.tan((deg * Math.PI) / 180));
  return { near: at(tilt + vBeamwidth / 2), peak: at(tilt), far: at(tilt - vBeamwidth / 2) };
}
