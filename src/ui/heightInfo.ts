import type { SiteBuildings } from '../radio/buildingModel';
import type { BaseStation } from '../types';
import type { App } from './app';
import { fmt, h, numField } from './dom';

/** Buildings at a station's mast, or null without building data there. */
export function buildingsAtMast(app: App, bs: BaseStation): SiteBuildings | null {
  return app.buildings().siteBuildings(app.store.scenario, bs.lat, bs.lng);
}

/**
 * Antenna height in context: the building the mast stands on and the tallest roof nearby,
 * with an "above roof" field that sets the height from the roof. `stations` all get the
 * new height (one carrier, or every carrier of a site); `changed` runs after an edit.
 */
export function heightInfo(app: App, stations: BaseStation[], changed: () => void): HTMLElement {
  const bs = stations[0];
  const b = buildingsAtMast(app, bs);
  if (!b) return h('p', { class: 'hint' }, 'Antenna height is above ground. Load OSM buildings (Buildings tab) to see the building under the mast and the roofs around it.');
  const hb = bs.heightM;
  const out = h('div', { class: 'height-info' });
  if (b.roofM !== null) {
    const roof = b.roofM;
    out.append(
      numField('Above roof', () => +(bs.heightM - roof).toFixed(1), (v) => {
        stations.forEach((s) => (s.heightM = Math.max(1, +(roof + v).toFixed(1))));
        changed();
      }, { step: 1, unit: 'm', title: `Mast height on the roof: antenna height = building ${fmt(roof, 0)} m + this` }),
      h('div', { class: 'hint' }, `Rooftop site: building ${fmt(roof, 0)} m + ${fmt(hb - roof, 1)} m mast = ${fmt(hb, 1)} m above ground.`),
    );
    if (hb <= roof) out.append(h('div', { class: 'warn' }, `⚠ The antenna is ${hb === roof ? 'at' : 'below'} the roof of its own building (${fmt(roof, 0)} m): raise it above the roof.`));
  } else {
    out.append(h('div', { class: 'hint' }, `Ground mast: no building under it, the antenna is ${fmt(hb, 1)} m above ground.`));
  }
  if (b.nearMaxM > 0) {
    const d = hb - b.nearMaxM;
    out.append(
      d >= 1
        ? h('div', { class: 'hint' }, `Tallest roof within ${b.radiusM} m: ${fmt(b.nearMaxM, 0)} m, the antenna is ${fmt(d, 1)} m above it.`)
        : h('div', { class: 'warn' }, d > -1
          ? `⚠ A roof within ${b.radiusM} m is ${fmt(b.nearMaxM, 0)} m high, level with the antenna: it shadows that direction.`
          : `⚠ A roof within ${b.radiusM} m is ${fmt(b.nearMaxM, 0)} m high, ${fmt(-d, 1)} m above the antenna: it shadows that direction.`),
    );
  }
  return out;
}
