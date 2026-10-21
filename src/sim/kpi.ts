export type SimEventType = 'HO' | 'HO_IRAT' | 'HO_FAIL' | 'PING_PONG' | 'DROP' | 'BLOCK' | 'CALL_START' | 'CALL_END';

export const EVENT_TYPES: SimEventType[] = ['HO', 'HO_IRAT', 'HO_FAIL', 'PING_PONG', 'DROP', 'BLOCK', 'CALL_START', 'CALL_END'];

export const EVENT_LABEL: Record<SimEventType, string> = {
  HO: 'Handover',
  HO_IRAT: 'Inter-RAT HO',
  HO_FAIL: 'HO failure',
  PING_PONG: 'Ping-pong',
  DROP: 'Drop',
  BLOCK: 'Block',
  CALL_START: 'Session start',
  CALL_END: 'Session end',
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
};

export interface SimEvent {
  seq: number;
  /** Simulation time, s. */
  t: number;
  type: SimEventType;
  userId: number;
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
  byTech: { GSM: number; LTE: number; NR: number };
}

export const TIMELINE_BUCKET_S = 10;

export function emptyCounters(): KpiCounters {
  return { voiceStarted: 0, dataStarted: 0, blockedCoverage: 0, blockedCapacity: 0, dropped: 0, hoAttempts: 0, hoSuccess: 0, hoFail: 0, hoIrat: 0, pingPong: 0 };
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
