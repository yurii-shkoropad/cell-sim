import { LocalProjection } from '../geo';
import type { BaseStation, Scenario } from '../types';
import { castStationPaths, type StationPaths } from './buildingPaths';
import { classifyEnvironment, rasterize, type BuildingRaster, type BuildingSet, type EnvironmentEstimate } from './buildings';
import type { IndoorMask, PathProvider, RadioContext } from './cells';

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
  private mask: IndoorMask | null = null;
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
    this.mask = null;
    this.cache.clear();
  }

  private ensureRaster(scn: Scenario): BuildingRaster {
    const r = scn.settings.radio;
    const rk = `${scn.center.lat}|${scn.center.lng}|${r.defaultBuildingHeightM}`;
    if (!this.raster || rk !== this.rasterKey) {
      this.raster = rasterize(this.set!, new LocalProjection(scn.center.lat, scn.center.lng), r.defaultBuildingHeightM);
      this.rasterKey = rk;
      this.mask = null;
      this.cache.clear();
    }
    return this.raster;
  }

  /**
   * Environment of a site from the buildings around it (Environment = Auto), cached per position;
   * null without building data or outside it (the caller falls back to a medium city).
   */
  environmentAt(scn: Scenario): ((x: number, y: number) => EnvironmentEstimate | null) | undefined {
    if (!this.set) return undefined;
    const raster = this.ensureRaster(scn);
    return (x, y) => {
      const k = `${x.toFixed(0)}|${y.toFixed(0)}|${raster.version}`;
      if (!this.envCache.has(k)) this.envCache.set(k, classifyEnvironment(raster, x, y));
      return this.envCache.get(k)!;
    };
  }
  private envCache = new Map<string, EnvironmentEstimate | null>();

  /** Building footprints for indoor loss on Hata paths (any model), or null without buildings. */
  indoorMask(scn: Scenario): IndoorMask | null {
    if (!this.set) return null;
    const raster = this.ensureRaster(scn);
    if (!this.mask) {
      const mask = new Uint8Array(raster.id.length);
      for (let k = 0; k < mask.length; k++) mask[k] = raster.id[k] !== 0 ? 1 : 0;
      this.mask = { x0: raster.x0, y0: raster.y0, res: raster.res, nx: raster.nx, ny: raster.ny, mask, version: raster.version };
    }
    return this.mask;
  }

  /** Path provider for buildRadioContext, or undefined when the building model isn't in use. */
  provider(scn: Scenario): PathProvider | undefined {
    const r = scn.settings.radio;
    if (!this.set || r.model !== 'cost231-wi') return undefined;
    const raster = this.ensureRaster(scn);
    const envAt = this.environmentAt(scn)!;
    this.usedKeys = [];
    this.lastComputeMs = 0;
    this.lastComputed = 0;
    return (bs: BaseStation, x: number, y: number) => {
      const f = (bs.sectors.find((s) => s.enabled) ?? bs.sectors[0])?.freqMHz ?? 1800;
      // Metropolitan correction of Walfisch–Ikegami: the global choice, or this site's own class.
      const metropolitan = (r.environment === 'auto' ? envAt(x, y)?.env : r.environment) === 'urban-large';
      const key = `${bs.id}|${x.toFixed(1)}|${y.toFixed(1)}|${bs.heightM}|${f}|${r.ueHeightM}|${r.buildingEntry}|${metropolitan}|${raster.version}`;
      this.usedKeys.push(key);
      let p = this.cache.get(key);
      if (!p) {
        const t0 = performance.now();
        p = castStationPaths(raster, x, y, { hb: bs.heightM, hm: r.ueHeightM, freqMHz: f, entry: r.buildingEntry, metropolitan });
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
