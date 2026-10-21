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
