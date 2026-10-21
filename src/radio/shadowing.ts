/**
 * Spatially correlated log-normal shadowing.
 *
 * Independent N(0,1) samples sit on a square lattice with spacing equal to the
 * decorrelation distance, one lattice per site (sectors of a site share the
 * same obstacles). Values in between are interpolated with smoothstep weights
 * and renormalised by the weight norm, so every point has unit variance while
 * correlation falls to ~0 at one decorrelation distance.
 *
 * Because the field is deterministic in (site, x, y), the heatmap and the
 * moving users always see the same shadowing.
 */

function hash32(a: number, b: number, c: number): number {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function gaussAt(seed: number, i: number, j: number): number {
  const u1 = (hash32(seed, i, j) + 1) / 4294967297;
  const u2 = hash32(seed ^ 0x5bd1e995, j, i) / 4294967296;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Shadowing in dB at local coords (x,y) metres for the given site seed. */
export function shadowingDb(seed: number, x: number, y: number, sigmaDb: number, decorrM: number): number {
  const gx = x / decorrM;
  const gy = y / decorrM;
  const i = Math.floor(gx);
  const j = Math.floor(gy);
  const tx = smooth(gx - i);
  const ty = smooth(gy - j);
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  const v =
    w00 * gaussAt(seed, i, j) + w10 * gaussAt(seed, i + 1, j) + w01 * gaussAt(seed, i, j + 1) + w11 * gaussAt(seed, i + 1, j + 1);
  const norm = Math.sqrt(w00 * w00 + w10 * w10 + w01 * w01 + w11 * w11);
  return (sigmaDb * v) / norm;
}

/** Stable 32-bit seed from a string id. */
export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
