export type Tech = 'GSM' | 'LTE' | 'NR';
export const TECHS: Tech[] = ['GSM', 'LTE', 'NR'];

export type Environment = 'urban-large' | 'urban-medium' | 'suburban' | 'rural';
export type PathLossModel = 'auto' | 'okumura-hata' | 'cost231-hata';

export interface Operator {
  id: string;
  name: string;
  /** "MCC-MNC", used to match imported cell data. */
  plmn: string;
  color: string;
  /** Share of simulated subscribers on this operator (relative weight). */
  marketShare: number;
}

export interface Sector {
  id: string;
  /** Degrees clockwise from north. */
  azimuth: number;
  /** Horizontal 3 dB beamwidth in degrees; >= 360 means omnidirectional. */
  hBeamwidth: number;
  /** Vertical 3 dB beamwidth in degrees. */
  vBeamwidth: number;
  /** Total (mechanical + electrical) downtilt in degrees. */
  tilt: number;
  /** Boresight gain, dBi. */
  gain: number;
  /** Max horizontal attenuation (front-to-back ratio), dB. */
  frontToBack: number;
  /** Downlink carrier centre frequency, MHz. Sectors may differ for frequency planning. */
  freqMHz: number;
  /** LTE/NR PCI, or GSM BSIC (0..63). */
  pci: number;
  enabled: boolean;
}

export interface BaseStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  operatorId: string;
  tech: Tech;
  /** Band label, e.g. "B3 1800". Informational. */
  band: string;
  /** Channel bandwidth, MHz. GSM is always 0.2 per carrier. */
  bandwidthMHz: number;
  /** Transmit power per sector at the antenna connector before cable loss, dBm. */
  txPowerDbm: number;
  /** Antenna height above ground, m. */
  heightM: number;
  /** Feeder / cable / connector loss, dB. */
  cableLossDb: number;
  /** GSM: number of TRX per sector. */
  trxCount: number;
  /** Antenna / MIMO configuration (see radio/mimo.ts); missing = SISO for older files. */
  antennaType?: string;
  /** Highest downlink modulation (see radio/modulation.ts); missing = 64QAM LTE / 256QAM NR. */
  maxModulation?: string;
  /** Downlink scheduler override (see sim/scheduler.ts); missing = the global setting. */
  scheduler?: string;
  /** Admission limit on simultaneously connected (active) users per sector. */
  maxUsers: number;
  sectors: Sector[];
  enabled: boolean;
}

export interface TechThresholds {
  /** Minimum RSRP / RxLev to camp or be served, dBm. */
  minRxDbm: number;
  /** A3 offset, dB. */
  a3OffsetDb: number;
  /** Handover hysteresis, dB. */
  hysteresisDb: number;
  /** Time to trigger, ms. */
  tttMs: number;
  /** Serving level below which inter-RAT handover (B2) is considered, dBm. */
  b2ServingDbm: number;
  /** Radio link failure threshold: SINR (C/I for GSM) below this starts the T310 timer, dB. */
  qOutSinrDb: number;
  /** T310 equivalent, ms. */
  rlfTimerMs: number;
  /** Higher value = preferred technology for cell selection. */
  priority: number;
}

export type Mobility = 'walk' | 'drive' | 'static';
/** 'random': Poisson sessions; 'voice'/'data': continuous session (re-established after drops/blocks); 'idle': never starts sessions. */
export type TrafficMode = 'random' | 'voice' | 'data' | 'idle';

/** Manually placed user, persisted in the scenario. */
export interface FixedUser {
  id: string;
  name: string;
  lat: number;
  lng: number;
  operatorId: string;
  techs: Tech[];
  mobility: Mobility;
  traffic: TrafficMode;
  /** Data demand, Mbps; null = drawn at random per session. */
  demandMbps: number | null;
  /** Phone receive antennas; null/missing = default for its device type. */
  ueRx?: number | null;
}

export interface UserSettings {
  count: number;
  /** Fraction of random users that never move (indoor / stationary). */
  staticShare: number;
  /** Fraction of moving users that are pedestrians (rest are vehicles). */
  pedestrianShare: number;
  pedSpeedMin: number;
  pedSpeedMax: number;
  vehSpeedMin: number;
  vehSpeedMax: number;
  /** Fraction of devices that support NR / LTE. All devices support GSM. */
  nrCapableShare: number;
  lteCapableShare: number;
  /** Receive antennas of NR-capable / LTE-only devices (GSM-only devices have 1). */
  ueRxNr: number;
  ueRxLte: number;
  voiceCallsPerHour: number;
  voiceMeanDurationS: number;
  dataSessionsPerHour: number;
  dataMeanDurationS: number;
  dataMeanDemandMbps: number;
}

export interface RadioSettings {
  environment: Environment;
  model: PathLossModel;
  ueHeightM: number;
  ueNoiseFigureDb: number;
  shadowingEnabled: boolean;
  shadowingSigmaDb: number;
  shadowingDecorrM: number;
  /** 'full': every interferer transmits at 100% load; 'actual': use simulated PRB utilisation. */
  interferenceLoad: 'full' | 'actual';
  /** Lower bound on interferer load in 'actual' mode (reference signals, control channels). */
  minInterfererLoad: number;
  /** Shannon attenuation factor (3GPP TR 36.942). */
  shannonAlpha: number;
  sinrMinDb: number;
  /** Control / reference-signal overhead fraction removed from PRB capacity. */
  overhead: number;
  /** GSM adjacent channel rejection, dB. */
  gsmAdjacentRejectionDb: number;
  /** Fraction (in dB) of the ideal transmit precoding gain 10·log10(Ntx/rank) realised by codebook MIMO. */
  precodingEfficiency: number;
  /** MU-MIMO pairing efficiency: each extra co-scheduled user adds this fraction of a cell's capacity. */
  muMimoEfficiency: number;
  /** Default LTE/NR downlink scheduler: 'rr' | 'pf' | 'maxci' | 'maxmin'. */
  scheduler: string;
  /** Fraction (in dB) of the ideal Rayleigh multi-user diversity gain realised by Proportional Fair. */
  pfDiversityEfficiency: number;
}

export interface SimSettings {
  stepMs: number;
  pingPongWindowS: number;
  /** Cells closer than this count as neighbours for planning checks, m. */
  neighbourRadiusM: number;
  seed: number;
}

export interface Settings {
  radio: RadioSettings;
  users: UserSettings;
  sim: SimSettings;
  thresholds: Record<Tech, TechThresholds>;
}

export interface Scenario {
  version: 1;
  name: string;
  center: { lat: number; lng: number; zoom: number };
  operators: Operator[];
  stations: BaseStation[];
  /** Manually placed users (static probes etc.); optional for older files. */
  fixedUsers?: FixedUser[];
  settings: Settings;
}
