import { LocalProjection } from '../geo';
import type { BaseStation, Scenario } from '../types';
import { castStationPaths, type StationPaths } from './buildingPaths';
import { rasterize, type BuildingRaster, type BuildingSet } from './buildings';
import type { PathProvider, RadioContext } from './cells';

/**
 * Loaded OSM buildings, their raster, and a cache of per-station path maps.
 * A station's map is recomputed only when something it depends on changes
 * (position, height, frequency, UE height, entry-loss type, raster).
 */
export class BuildingModel {
  set: BuildingSet | null = null;
  source = '';
  private raster: BuildingRaster | null = null;
  private rasterKey = '';
  private cache = new Map<string, StationPaths>();
  private usedKeys: string[] = [];
  private lastSignature = '';
  private version = 0;
  /** Time spent casting paths in the last build, ms. */
  lastComputeMs = 0;
  lastComputed = 0;

  setBuildings(set: BuildingSet | null, source: string) {
    this.set = set;
    this.source = source;
    this.raster = null;
    this.rasterKey = '';
    this.cache.clear();
  }

  /** Path provider for buildRadioContext, or undefined when the building model isn't in use. */
  provider(scn: Scenario): PathProvider | undefined {
    const r = scn.settings.radio;
    if (!this.set || r.model !== 'cost231-wi') return undefined;
    const rk = `${scn.center.lat}|${scn.center.lng}|${r.defaultBuildingHeightM}`;
    if (!this.raster || rk !== this.rasterKey) {
      this.raster = rasterize(this.set, new LocalProjection(scn.center.lat, scn.center.lng), r.defaultBuildingHeightM);
      this.rasterKey = rk;
      this.cache.clear();
    }
    const raster = this.raster;
    this.usedKeys = [];
    this.lastComputeMs = 0;
    this.lastComputed = 0;
    return (bs: BaseStation, x: number, y: number) => {
      const f = (bs.sectors.find((s) => s.enabled) ?? bs.sectors[0])?.freqMHz ?? 1800;
      const key = `${bs.id}|${x.toFixed(1)}|${y.toFixed(1)}|${bs.heightM}|${f}|${r.ueHeightM}|${r.buildingEntry}|${r.environment}|${raster.version}`;
      this.usedKeys.push(key);
      let p = this.cache.get(key);
      if (!p) {
        const t0 = performance.now();
        p = castStationPaths(raster, x, y, { hb: bs.heightM, hm: r.ueHeightM, freqMHz: f, entry: r.buildingEntry, metropolitan: r.environment === 'urban-large' });
        this.lastComputeMs += performance.now() - t0;
        this.lastComputed++;
        this.cache.set(key, p);
      }
      return p;
    };
  }

  /**
   * Call after buildRadioContext: drops maps no station uses any more and gives
   * the context a version that changes only when its set of maps changed.
   */
  finish(ctx: RadioContext) {
    const used = new Set(this.usedKeys);
    for (const k of this.cache.keys()) if (!used.has(k)) this.cache.delete(k);
    const sig = this.usedKeys.join(';');
    if (sig !== this.lastSignature) {
      this.lastSignature = sig;
      this.version++;
    }
    if (ctx.paths) ctx.paths.version = this.version;
  }
}
