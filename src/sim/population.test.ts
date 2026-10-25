import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../state/defaults';
import { migrateUsers } from '../state/store';
import { areaAround, generateUsers, mulberry32, templateFromSettings, zoneContains, type Zone } from './population';

describe('population generator', () => {
  const scn = defaultScenario();
  const tpl = templateFromSettings(scn);

  it('the demo has 150 generated users plus the probe, and is the same every time', () => {
    expect(scn.users).toHaveLength(151);
    const again = defaultScenario();
    expect(again.users!.map((u) => [u.lat, u.lng, u.mobility])).toEqual(scn.users!.map((u) => [u.lat, u.lng, u.mobility]));
  });

  it('places every user inside a rectangle or circle zone', () => {
    const rect: Zone = { kind: 'rect', south: 49.83, west: 24.01, north: 49.84, east: 24.02 };
    const circle: Zone = { kind: 'circle', lat: 49.835, lng: 24.014, radiusM: 250 };
    for (const z of [rect, circle]) for (const u of generateUsers(scn, { ...tpl, count: 200 }, z, mulberry32(1))) expect(zoneContains(z, u.lat, u.lng)).toBe(true);
  });

  it('honours the operator choice, mobility mix and template fields', () => {
    const list = generateUsers(scn, { ...tpl, count: 300, operator: 'op3', staticShare: 1, traffic: 'data', demandMbps: 7, ueRx: 4 }, areaAround(scn.center.lat, scn.center.lng), mulberry32(2));
    expect(list.every((u) => u.operatorId === 'op3' && u.mobility === 'static' && u.traffic === 'data' && u.demandMbps === 7 && u.ueRx === 4)).toBe(true);
    const mixed = generateUsers(scn, { ...tpl, count: 600 }, areaAround(scn.center.lat, scn.center.lng), mulberry32(3));
    expect(new Set(mixed.map((u) => u.operatorId)).size).toBe(3);
    expect(new Set(mixed.map((u) => u.mobility)).size).toBe(3);
  });

  it('continues UE numbering after the existing users', () => {
    const list = generateUsers(scn, { ...tpl, count: 2 }, areaAround(scn.center.lat, scn.center.lng), mulberry32(4));
    expect(list.map((u) => u.name)).toEqual(['UE-151', 'UE-152']);
  });

  it('migrates older scenarios: generated users from the settings plus the fixed ones', () => {
    const old = defaultScenario() as ReturnType<typeof defaultScenario>;
    const probe = old.users![0];
    delete old.users;
    old.fixedUsers = [probe];
    old.settings.users.count = 40;
    migrateUsers(old);
    expect(old.users).toHaveLength(41);
    expect(old.users![0].id).toBe('fu-main');
    expect(old.fixedUsers).toBeUndefined();
  });
});
