import { hexGrid } from '../planning/patterns';
import { makeStation, presetByKey } from '../radio/presets';
import type { Operator, Scenario, Settings } from '../types';

/** Lviv Polytechnic National University, main building. */
export const DEFAULT_CENTER = { lat: 49.8356, lng: 24.0142, zoom: 15 };

export function defaultSettings(): Settings {
  return {
    radio: {
      environment: 'urban-medium',
      model: 'auto',
      ueHeightM: 1.5,
      ueNoiseFigureDb: 7,
      shadowingEnabled: true,
      shadowingSigmaDb: 8,
      shadowingDecorrM: 50,
      interferenceLoad: 'actual',
      minInterfererLoad: 0.15,
      shannonAlpha: 0.6,
      sinrMinDb: -10,
      overhead: 0.25,
      gsmAdjacentRejectionDb: 18,
      buildingEntry: 'traditional',
      defaultBuildingHeightM: 12,
      precodingEfficiency: 0.5,
      muMimoEfficiency: 0.5,
      scheduler: 'rr',
      pfDiversityEfficiency: 0.5,
    },
    users: {
      count: 150,
      staticShare: 0.15,
      pedestrianShare: 0.6,
      pedSpeedMin: 0.8,
      pedSpeedMax: 1.8,
      vehSpeedMin: 6,
      vehSpeedMax: 14,
      nrCapableShare: 0.4,
      lteCapableShare: 0.9,
      ueRxNr: 4,
      ueRxLte: 2,
      voiceCallsPerHour: 2,
      voiceMeanDurationS: 90,
      dataSessionsPerHour: 12,
      dataMeanDurationS: 60,
      dataMeanDemandMbps: 4,
    },
    sim: {
      stepMs: 200,
      pingPongWindowS: 5,
      neighbourRadiusM: 2000,
      seed: 1,
    },
    thresholds: {
      GSM: { minRxDbm: -104, a3OffsetDb: 4, hysteresisDb: 2, tttMs: 1000, b2ServingDbm: -100, qOutSinrDb: 9, rlfTimerMs: 2000, priority: 1 },
      LTE: { minRxDbm: -124, a3OffsetDb: 3, hysteresisDb: 1, tttMs: 320, b2ServingDbm: -118, qOutSinrDb: -8, rlfTimerMs: 1000, priority: 2 },
      NR: { minRxDbm: -120, a3OffsetDb: 3, hysteresisDb: 1, tttMs: 320, b2ServingDbm: -114, qOutSinrDb: -8, rlfTimerMs: 1000, priority: 3 },
    },
  };
}

export function defaultOperators(): Operator[] {
  return [
    { id: 'op1', name: 'Kyivstar', plmn: '255-03', color: '#1e6fd9', marketShare: 50 },
    { id: 'op2', name: 'Vodafone UA', plmn: '255-01', color: '#e60000', marketShare: 30 },
    { id: 'op3', name: 'lifecell', plmn: '255-06', color: '#f2b705', marketShare: 20 },
  ];
}

export function defaultScenario(): Scenario {
  const c = DEFAULT_CENTER;
  const lte1800 = presetByKey('lte1800');
  const gsm900 = presetByKey('gsm900');
  const nr3500 = presetByKey('nr3500');

  const ksLte = hexGrid({ centerLat: c.lat, centerLng: c.lng, isdM: 750, rings: 2, sectors: 3, azimuthOffset: 30, operatorId: 'op1', preset: lte1800, namePrefix: 'KS-L' });

  const ksGsm = hexGrid({ centerLat: c.lat, centerLng: c.lng, isdM: 1300, rings: 1, sectors: 3, azimuthOffset: 0, operatorId: 'op1', preset: gsm900, namePrefix: 'KS-G' }).slice(0, 4);
  // 4/12 reuse on four GSM sites: give each sector its own BCCH.
  ksGsm.forEach((bs, i) => bs.sectors.forEach((s, j) => (s.freqMHz = +(947.4 + 0.4 * (i * 3 + j)).toFixed(1))));

  const ksNr = [makeStation(nr3500, c.lat + 0.0008, c.lng - 0.0012, 'op1', 'KS-N01', { sectors: 3, azimuthOffset: 0, pciBase: 0 })];

  const vfLte = hexGrid({ centerLat: c.lat - 0.0021, centerLng: c.lng + 0.0035, isdM: 1000, rings: 1, sectors: 3, azimuthOffset: 0, operatorId: 'op2', preset: { ...lte1800, freqMHz: 1835 }, namePrefix: 'VF-L', pciStart: 60 }).slice(0, 5);

  const lcLte = hexGrid({ centerLat: c.lat + 0.003, centerLng: c.lng + 0.002, isdM: 1200, rings: 1, sectors: 3, azimuthOffset: 15, operatorId: 'op3', preset: { ...lte1800, freqMHz: 1860, bandwidthMHz: 15 }, namePrefix: 'LC-L', pciStart: 120 }).slice(0, 4);
  for (const bs of lcLte) bs.bandwidthMHz = 15;

  return {
    version: 1,
    name: 'Lviv Polytechnic demo',
    center: { ...c },
    operators: defaultOperators(),
    stations: [...ksLte, ...ksGsm, ...ksNr, ...vfLte, ...lcLte],
    fixedUsers: [
      { id: 'fu-main', name: 'Main building probe', lat: 49.8352, lng: 24.0152, operatorId: 'op1', techs: ['GSM', 'LTE', 'NR'], mobility: 'static', traffic: 'data', demandMbps: 10 },
    ],
    settings: defaultSettings(),
  };
}
