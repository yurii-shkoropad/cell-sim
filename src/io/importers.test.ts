import { describe, expect, it } from 'vitest';
import { presetByKey } from '../radio/presets';
import { defaultScenario } from '../state/defaults';
import { importOpenCellId } from './importers';

const CSV = `radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal
LTE,255,3,10101,25600257,0,24.0150,49.8362,500,10,1,0,0,0
LTE,255,3,10101,25600258,0,24.0158,49.8350,500,10,1,0,0,0
LTE,255,3,10101,25600259,0,24.0135,49.8352,500,10,1,0,0,0
GSM,255,1,301,12341,0,24.0200,49.8300,500,10,1,0,0,0
GSM,255,1,301,12342,0,24.0201,49.8301,500,10,1,0,0,0
UMTS,255,6,1,5555,0,24.0100,49.8300,500,10,1,0,0,0
LTE,255,99,1,256,0,24.0100,49.8300,500,10,1,0,0,0
LTE,255,3,1,512,0,30.5,50.45,500,10,1,0,0,0`;

describe('OpenCelliD import', () => {
  it('groups LTE cells by eNB and GSM cells by proximity, matching operators by PLMN', () => {
    const scn = defaultScenario();
    const b = { south: 49.8, north: 49.87, west: 23.98, east: 24.05 };
    const r = importOpenCellId(CSV, scn, b, { GSM: presetByKey('gsm900'), LTE: presetByKey('lte1800'), NR: presetByKey('nr3500') });
    const lte = r.stations.filter((s) => s.tech === 'LTE');
    const gsm = r.stations.filter((s) => s.tech === 'GSM');
    expect(lte).toHaveLength(2); // eNB 100001 (3 cells) + one unknown-operator eNB
    expect(lte.find((s) => s.sectors.length === 3)?.operatorId).toBe('op1'); // 255-03 Kyivstar
    expect(gsm).toHaveLength(1);
    expect(gsm[0].sectors).toHaveLength(2);
    expect(gsm[0].operatorId).toBe('op2'); // 255-01 Vodafone
    expect(r.newOperators.map((o) => o.plmn)).toEqual(['255-99']);
    expect(r.skipped['UMTS (not modelled)']).toBe(1);
    expect(r.skipped['outside view']).toBe(1);
  });
});
