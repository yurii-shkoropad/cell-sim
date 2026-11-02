import type { BaseStation, Tech } from '../types';

/**
 * A site: every station of one operator on the same mast (same position). Each station is one
 * carrier / band / RAT; the UI manages them together, the simulation keeps them separate.
 */
export interface Site {
  key: string;
  name: string;
  lat: number;
  lng: number;
  operatorId: string;
  stations: BaseStation[];
}

/** Stations closer than ~1 m (5 decimals) of the same operator are one site. */
export const siteKeyOf = (bs: BaseStation) => `${bs.operatorId}|${bs.lat.toFixed(5)}|${bs.lng.toFixed(5)}`;

/** Sites in the order their first station appears. */
export function sitesOf(stations: BaseStation[]): Site[] {
  const out = new Map<string, Site>();
  for (const bs of stations) {
    const k = siteKeyOf(bs);
    let s = out.get(k);
    if (!s) out.set(k, (s = { key: k, name: '', lat: bs.lat, lng: bs.lng, operatorId: bs.operatorId, stations: [] }));
    s.stations.push(bs);
  }
  for (const s of out.values()) s.name = siteName(s.stations);
  return [...out.values()];
}

export function siteOfStation(stations: BaseStation[], id: string | null): Site | undefined {
  const bs = id ? stations.find((s) => s.id === id) : undefined;
  if (!bs) return undefined;
  const k = siteKeyOf(bs);
  const list = stations.filter((s) => siteKeyOf(s) === k);
  return { key: k, name: siteName(list), lat: bs.lat, lng: bs.lng, operatorId: bs.operatorId, stations: list };
}

/**
 * The site's name: an explicit `siteName`, else the common start of its station names
 * ("140847-L3x", "140847-L4x" → "140847"), else the first station's name.
 */
export function siteName(list: BaseStation[]): string {
  const explicit = list.find((s) => s.siteName?.trim())?.siteName?.trim();
  if (explicit) return explicit;
  if (list.length === 1) return list[0].name;
  let p = list[0].name;
  for (const s of list) while (p && !s.name.startsWith(p)) p = p.slice(0, -1);
  // Don't cut a word in half ("140847-L" from "140847-L3x" / "140847-L4x"): back to a separator.
  const sep = /[\s\-_.·]/;
  const midWord = list.some((s) => s.name.length > p.length && !sep.test(s.name[p.length]) && p.length && !sep.test(p[p.length - 1]));
  if (midWord) p = p.slice(0, Math.max(...[...' -_.·'].map((c) => p.lastIndexOf(c)), 0));
  p = p.replace(/[\s\-_.·]+$/, '');
  return p.length >= 2 ? p : list[0].name;
}

/** Short label of one carrier inside its site: the part of its name after the site name, or its band. */
export function carrierLabel(bs: BaseStation, site: string): string {
  const rest = bs.name.startsWith(site) ? bs.name.slice(site.length).replace(/^[\s\-_.·]+/, '') : '';
  return rest || bs.band || bs.name;
}

/** RATs present on a site, with how many stations (carriers) each. */
export function siteRats(s: Site): [Tech, number][] {
  const n = new Map<Tech, number>();
  for (const bs of s.stations) n.set(bs.tech, (n.get(bs.tech) ?? 0) + 1);
  return (['GSM', 'LTE', 'NR'] as Tech[]).filter((t) => n.has(t)).map((t) => [t, n.get(t)!]);
}
