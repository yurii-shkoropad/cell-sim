import type { BaseStation } from '../types';

/** "By sector" palette: S1 red, S2 blue, S3 green, then orange, purple, teal. */
export const SECTOR_RGB = ['#e53935', '#1e5bd8', '#2e9e44', '#f39c12', '#8e44ad', '#16a2a6'];
export const SECTOR_RGB_NAMES = ['red', 'blue', 'green', 'orange', 'purple', 'teal'];

/** Palette slot of sector `i` of a station: its chosen one, else its position (S1 → red). */
export const slotOf = (bs: BaseStation, i: number): number => bs.sectors[i]?.colorSlot ?? i;

/**
 * Give sector `i` palette colour `slot`. The sector that had that colour takes over sector i's
 * old one, so a station never shows two sectors in the same colour.
 */
export function setSectorSlot(bs: BaseStation, i: number, slot: number) {
  const old = slotOf(bs, i);
  if (old === slot) return;
  const j = bs.sectors.findIndex((_, k) => k !== i && slotOf(bs, k) === slot);
  const assign = (k: number, v: number) => {
    if (v === k) delete bs.sectors[k].colorSlot;
    else bs.sectors[k].colorSlot = v;
  };
  if (j >= 0) assign(j, old);
  assign(i, slot);
}
