import type { HeatmapLayer } from '../map/heatmap';
import type { MapView } from '../map/mapView';
import type { RadioContext } from '../radio/cells';
import type { SimEngine, SimUser } from '../sim/engine';
import type { UserSpec } from '../types';
import type { RoadGraph } from '../sim/roads';
import type { Store } from '../state/store';
import type { BuildingModel } from '../radio/buildingModel';

/** Services shared by the UI panels. */
export interface App {
  store: Store;
  mapView: MapView;
  heatmap: HeatmapLayer;
  engine: SimEngine;
  ctx(): RadioContext;
  roads(): RoadGraph | null;
  loadRoads(): Promise<void>;
  buildings(): BuildingModel;
  loadBuildings(): Promise<void>;
  respawnUsers(): void;
  deleteAllUsers(): void;
  /** Add users to the scenario and the running simulation. */
  addUsers(specs: UserSpec[]): void;
  deleteUsers(specIds: string[]): void;
  /** Change fields of several users at once (scenario entries and live users). */
  editUsers(specIds: string[], patch: Partial<UserSpec>): void;
  /**
   * Save a live user's edited state back to its scenario entry. `position`: also make its
   * current position the start position (default: unless it is heading for a target, so
   * Reset replays the same walk).
   */
  saveUser(u: SimUser, position?: boolean): void;
  /** Highlight users on the map (Users list selection). */
  setUserSelection(specIds: Iterable<string>): void;
  /** Show a user in the inspector panel. */
  openUser(id: number): void;
  /** Register a callback refreshed ~1×/s with live simulation data. */
  onLiveTick(fn: () => void): void;
}
