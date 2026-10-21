import { verticalFootprint } from '../radio/antenna';
import type { BaseStation } from '../types';

const NS = 'http://www.w3.org/2000/svg';
const W = 320;
const H = 150;
const M = { l: 30, r: 10, t: 22, b: 30 };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

export const fmtDist = (m: number) => (!Number.isFinite(m) ? '∞' : m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);

/**
 * Side view of one sector's vertical main beam: mast, boresight (tilt) and the
 * −3 dB edges (tilt ± V-BW/2), down to UE height. The vertical axis is
 * exaggerated (heights are tens of metres, distances are hundreds), but the
 * ground intersection distances are exact.
 */
export function beamProfile(bs: BaseStation, sectorIdx: number, hm: number, color: string): SVGSVGElement {
  const s = bs.sectors[sectorIdx];
  const fp = verticalFootprint(bs.heightM, hm, s.tilt, s.vBeamwidth);
  const hb = bs.heightM;

  // Horizontal range: show the whole footprint, or 3× the boresight distance when the upper edge never lands.
  const reach = Number.isFinite(fp.far) ? fp.far * 1.15 : Number.isFinite(fp.peak) ? fp.peak * 3 : 2000;
  const xMax = Math.min(Math.max(reach, 300), 8000);
  const yMax = hb * 1.35;
  const px = (x: number) => M.l + (Math.min(x, xMax) / xMax) * (W - M.l - M.r);
  const py = (y: number) => H - M.b - (Math.max(Math.min(y, yMax), 0) / yMax) * (H - M.t - M.b);
  /** Height of a ray leaving the antenna at `deg` below horizon, at ground distance x. */
  const rayY = (deg: number, x: number) => hb - x * Math.tan((deg * Math.PI) / 180);
  /** End point of a ray: where it reaches UE height, or where it leaves the chart. */
  const rayEnd = (deg: number, d: number): [number, number] => {
    if (d <= xMax) return [px(d), py(hm)];
    let x = xMax;
    const y = rayY(deg, x);
    if (y > yMax) x = (hb - yMax) / Math.tan((deg * Math.PI) / 180); // exits through the top
    return [px(x), py(rayY(deg, x))];
  };

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'beam-svg', role: 'img', 'aria-label': `Side view of sector ${sectorIdx + 1} vertical beam` });
  const ant: [number, number] = [px(0), py(hb)];
  const lower = rayEnd(s.tilt + s.vBeamwidth / 2, fp.near);
  const upper = rayEnd(s.tilt - s.vBeamwidth / 2, fp.far);
  const bore = rayEnd(s.tilt, fp.peak);

  // Axes and ground
  root.append(
    svg('line', { x1: M.l, y1: py(0), x2: W - M.r, y2: py(0), class: 'bp-ground' }),
    svg('line', { x1: M.l, y1: py(hm), x2: W - M.r, y2: py(hm), class: 'bp-ue' }),
    svg('text', { x: W - M.r, y: py(hm) - 3, 'text-anchor': 'end', class: 'bp-note' }, `UE height ${hm} m`),
  );

  // −3 dB beam wedge
  const poly = [ant, lower];
  if (upper[1] < py(hm) - 0.5) poly.push([px(xMax), py(hm)], [px(xMax), upper[1]], upper);
  else poly.push(upper);
  root.append(svg('polygon', { points: poly.map((p) => p.join(',')).join(' '), fill: color, 'fill-opacity': 0.2, stroke: 'none' }));
  for (const [end, dash] of [[lower, ''], [upper, ''], [bore, '5 3']] as const) {
    root.append(svg('line', { x1: ant[0], y1: ant[1], x2: end[0], y2: end[1], stroke: color, 'stroke-width': dash ? 1.5 : 2, 'stroke-dasharray': dash }));
  }

  // Mast + antenna
  root.append(
    svg('line', { x1: px(0), y1: py(0), x2: px(0), y2: py(hb), class: 'bp-mast' }),
    svg('circle', { cx: ant[0], cy: ant[1], r: 3.5, fill: color, stroke: '#fff', 'stroke-width': 1.5 }),
    svg('text', { x: M.l - 4, y: py(hb) + 3, 'text-anchor': 'end', class: 'bp-note' }, `${hb} m`),
  );

  // Distance markers on the ground axis; boresight label wins when labels would collide.
  const marks: [number, string][] = [[fp.peak, 'boresight'], [fp.near, 'near'], [fp.far, 'far']];
  const placed: number[] = [];
  for (const [d, label] of marks) {
    if (!Number.isFinite(d) || d > xMax) continue;
    const x = px(d);
    root.append(svg('line', { x1: x, y1: py(0), x2: x, y2: py(0) + 4, class: 'bp-tick' }));
    if (placed.some((p) => Math.abs(p - x) < 40)) continue;
    const anchor = x < M.l + 20 ? 'start' : x > W - M.r - 20 ? 'end' : 'middle';
    root.append(svg('text', { x, y: py(0) + 14, 'text-anchor': anchor, class: 'bp-dist' }, fmtDist(d)), svg('text', { x, y: py(0) + 24, 'text-anchor': anchor, class: 'bp-note' }, label));
    placed.push(x);
  }

  root.append(svg('text', { x: M.l, y: 12, class: 'bp-title' }, `Sector ${sectorIdx + 1}: tilt ${s.tilt}°, V-BW ${s.vBeamwidth}°`));
  root.append(svg('text', { x: W - M.r, y: 12, 'text-anchor': 'end', class: 'bp-note' }, 'height exaggerated'));
  return root;
}
