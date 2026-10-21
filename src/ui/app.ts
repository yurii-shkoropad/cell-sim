import type { HeatmapLayer } from '../map/heatmap';
import type { MapView } from '../map/mapView';
import type { RadioContext } from '../radio/cells';
import type { SimEngine } from '../sim/engine';
import type { RoadGraph } from '../sim/roads';
import type { Store } from '../state/store';

/** Services shared by the UI panels. */
export interface App {
  store: Store;
  mapView: MapView;
  heatmap: HeatmapLayer;
  engine: SimEngine;
  ctx(): RadioContext;
  roads(): RoadGraph | null;
  loadRoads(): Promise<void>;
  respawnUsers(): void;
  /** Register a callback refreshed ~1×/s with live simulation data. */
  onLiveTick(fn: () => void): void;
}
