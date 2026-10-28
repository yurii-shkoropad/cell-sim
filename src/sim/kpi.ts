export type SimEventType = 'HO' | 'HO_IRAT' | 'HO_FAIL' | 'PING_PONG' | 'DROP' | 'BLOCK' | 'CALL_START' | 'CALL_END' | 'WIFI_JOIN' | 'WIFI_LEAVE';

export const EVENT_TYPES: SimEventType[] = ['HO', 'HO_IRAT', 'HO_FAIL', 'PING_PONG', 'DROP', 'BLOCK', 'CALL_START', 'CALL_END', 'WIFI_JOIN', 'WIFI_LEAVE'];

export const EVENT_LABEL: Record<SimEventType, string> = {
  HO: 'Handover',
  HO_IRAT: 'Inter-RAT HO',
  HO_FAIL: 'HO failure',
  PING_PONG: 'Ping-pong',
  DROP: 'Drop',
  BLOCK: 'Block',
  CALL_START: 'Session start',
  CALL_END: 'Session end',
  WIFI_JOIN: 'Wi-Fi join',
  WIFI_LEAVE: 'Wi-Fi leave',
};

export const EVENT_COLOR: Record<SimEventType, string> = {
  HO: '#2a78d6',
  HO_IRAT: '#eb6834',
  HO_FAIL: '#1baf7a',
  PING_PONG: '#eda100',
  DROP: '#e87ba4',
  BLOCK: '#008300',
  CALL_START: '#8a8984',
  CALL_END: '#b5b4ae',
  WIFI_JOIN: '#7b5cd6',
  WIFI_LEAVE: '#c9a0dc',
};

export interface SimEvent {
  seq: number;
  /** Simulation time, s. */
  t: number;
  type: SimEventType;
  userId: number;
  /** Wi-Fi AP id, for Wi-Fi events. */
  ap?: string;
  from?: string;
  to?: string;
  lat: number;
  lng: number;
  detail: string;
}

export interface KpiCounters {
  voiceStarted: number;
  dataStarted: number;
  blockedCoverage: number;
  blockedCapacity: number;
  dropped: number;
  hoAttempts: number;
  hoSuccess: number;
  hoFail: number;
  hoIrat: number;
  pingPong: number;
  /** Sessions moved from cellular to Wi-Fi, and back (or dropped) when Wi-Fi was lost. */
  wifiOffloads: number;
  wifiFallbacks: number;
}

export interface KpiSample {
  t: number;
  activeVoice: number;
  activeData: number;
  /** Users with a serving cell / all users. */
  coverage: number;
  meanThrMbps: number;
  p5ThrMbps: number;
  meanSinrDb: number;
  /** Mean per-cell Jain's index over data users' satisfaction (throughput / demand). */
  fairness: number;
  byTech: { GSM: number; LTE: number; NR: number };
  /** Sums over all cells, Mbps. */
  servedMbps: number;
  demandMbps: number;
  capacityMbps: number;
  /** RB-weighted PRB utilisation of LTE/NR cells, 0..1. */
  prbUtil: number;
  /** Users associated to a Wi-Fi AP, and sessions carried over Wi-Fi. */
  wifiUsers: number;
  wifiSessions: number;
  /** Throughput carried by Wi-Fi APs and their estimated capacity, Mbps. */
  wifiServedMbps: number;
  wifiCapacityMbps: number;
}

/** One second of one cell's statistics (kept per sector id). */
export interface CellSample {
  t: number;
  voice: number;
  data: number;
  camped: number;
  servedMbps: number;
  demandMbps: number;
  capacityMbps: number;
  /** PRB (TCH for GSM) utilisation, 0..1. */
  load: number;
  /** RBs (TCH for GSM) of the cell, to weight utilisation when combining sectors. */
  resources: number;
  meanSinrDb: number;
  meanThrMbps: number;
  p5ThrMbps: number;
}

/** Seconds of per-cell history kept. */
export const CELL_HISTORY_S = 900;

export const TIMELINE_BUCKET_S = 10;

export function emptyCounters(): KpiCounters {
  return { voiceStarted: 0, dataStarted: 0, blockedCoverage: 0, blockedCapacity: 0, dropped: 0, hoAttempts: 0, hoSuccess: 0, hoFail: 0, hoIrat: 0, pingPong: 0, wifiOffloads: 0, wifiFallbacks: 0 };
}

/** Bounded event log plus per-bucket counts for the timeline chart. */
export class EventLog {
  readonly max: number;
  events: SimEvent[] = [];
  /** bucket index -> counts per type. */
  buckets = new Map<number, Partial<Record<SimEventType, number>>>();
  private seq = 0;
  private listeners = new Set<(e: SimEvent) => void>();

  constructor(max = 5000) {
    this.max = max;
  }

  push(e: Omit<SimEvent, 'seq'>) {
    const ev = { ...e, seq: ++this.seq };
    this.events.push(ev);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    const b = Math.floor(e.t / TIMELINE_BUCKET_S);
    const counts = this.buckets.get(b) ?? {};
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    this.buckets.set(b, counts);
    this.listeners.forEach((fn) => fn(ev));
  }

  onEvent(fn: (e: SimEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  clear() {
    this.events = [];
    this.buckets.clear();
  }
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const k = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[k];
}
