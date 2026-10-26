import { verticalFootprint } from '../radio/antenna';
import { antennaType, antennaTypesFor, bestRank, validAntennaFor } from '../radio/mimo';
import { modulation, modulationsFor, validModulationFor } from '../radio/modulation';
import { channelNumber, gsmTrafficChannels, makeSector, newId, PRESETS, presetByKey, rbBandwidthHz, resourceBlocks } from '../radio/presets';
import { validity } from '../radio/propagation';
import { SCHEDULERS, schedulerInfo } from '../sim/scheduler';
import type { BaseStation, Sector, Tech } from '../types';
import type { App } from './app';
import { beamProfile, fmtDist } from './beamProfile';
import { button, checkField, clear, fmt, h, numField, selectEl, selectField, textField } from './dom';

const BW_OPTIONS: Record<Tech, number[]> = {
  GSM: [0.2],
  LTE: [1.4, 3, 5, 10, 15, 20],
  NR: [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100],
};

const presetOptions = () => PRESETS.map((p) => [p.key, p.label] as [string, string]);

/**
 * Full configuration form for one base station: radio parameters, sectors table,
 * vertical beam side view, duplicate/delete. Re-renders itself on structural edits
 * (technology, sector count …); plain value edits only emit 'network'.
 */
export function renderStationConfig(app: App, bs: BaseStation, host: HTMLElement, state: { profileSector: number }) {
  const { store } = app;
  clear(host);
  const opOptions = store.scenario.operators.map((o) => [o.id, o.name] as [string, string]);
  const changed = () => store.emit('network');
  const structural = () => {
    store.emit('network');
    renderStationConfig(app, bs, host, state);
  };

  const derived = h('div', { class: 'derived' });
  const renderDerived = () => {
    clear(derived);
    const s0 = bs.sectors[0];
    const ant = antennaType(validAntennaFor(bs.tech, bs.antennaType));
    const eirp = bs.txPowerDbm - bs.cableLossDb + (s0?.gain ?? 0) + ant.bfGainDb;
    const lines: string[] = [`EIRP ${fmt(eirp)} dBm (${fmt(Math.pow(10, (eirp - 30) / 10), 0)} W) per sector${ant.bfGainDb ? ` incl. +${ant.bfGainDb} dB beamforming` : ''}`];
    if (bs.tech === 'GSM') lines.push(`${gsmTrafficChannels(bs.trxCount)} TCH per sector (${bs.trxCount} TRX)`);
    else {
      const f = s0?.freqMHz ?? 0;
      const rb = resourceBlocks(bs.tech, bs.bandwidthMHz, f);
      lines.push(`${rb} RB · RS power/RE at antenna ${fmt(bs.txPowerDbm - bs.cableLossDb - 10 * Math.log10(12 * rb))} dBm`);
      // Single-UE peak at excellent radio conditions, for orientation.
      const r = store.scenario.settings.radio;
      const ueRx = bs.tech === 'NR' ? store.scenario.settings.users.ueRxNr : store.scenario.settings.users.ueRxLte;
      const mod = modulation(validModulationFor(bs.tech, bs.maxModulation));
      const best = bestRank(30, ant, ueRx, mod.seMax, r);
      const peak = (best.se * rbBandwidthHz(bs.tech, f) * (1 - r.overhead) * rb) / 1e6;
      // Absolute ceiling: every layer at the modulation's top efficiency.
      const layers = Math.min(ant.maxLayers, ant.ports, ueRx);
      const ceiling = (layers * mod.seMax * rbBandwidthHz(bs.tech, f) * (1 - r.overhead) * rb) / 1e6;
      lines.push(`${ant.label}: up to ${Math.min(ant.maxLayers, ant.ports)} layers${ant.maxMu > 1 ? `, MU-MIMO up to ${ant.maxMu} users/RB` : ''}`);
      lines.push(`${mod.label}: ≤ ${mod.seMax.toFixed(2)} b/s/Hz per layer (${mod.bitsPerSymbol} bits/symbol)`);
      lines.push(`Peak DL ≈ ${fmt(peak, 0)} Mbps @ 30 dB SINR, ceiling ${fmt(ceiling, 0)} Mbps (one ${ueRx}Rx UE, ${layers} layers)`);
    }
    const ch = s0 ? channelNumber(bs.tech, s0.freqMHz) : null;
    if (ch) lines.push(`${ch.label} ${ch.value} (sector 1)`);
    derived.appendChild(h('div', null, ...lines.map((l) => h('div', null, l))));
    for (const v of validity(s0?.freqMHz ?? 0, bs.heightM, store.scenario.settings.radio.ueHeightM, store.scenario.settings.radio.model)) derived.appendChild(h('div', { class: 'warn' }, '⚠ ' + v.message));
  };
  renderDerived();

  const profileHost = h('div', { class: 'beam-profile' });
  const renderProfile = () => {
    clear(profileHost);
    if (state.profileSector >= bs.sectors.length) state.profileSector = 0;
    const ctx = app.ctx();
    const color = (id: string) => ctx.cells.find((c) => c.sectorId === id)?.color ?? '#2a78d6';
    const hm = store.scenario.settings.radio.ueHeightM;
    const s = bs.sectors[state.profileSector];
    const fp = verticalFootprint(bs.heightM, hm, s.tilt, s.vBeamwidth);
    profileHost.append(
      h('div', { class: 'bp-tabs' },
        ...bs.sectors.map((x, i) =>
          h('button', { type: 'button', class: `chip ${i === state.profileSector ? 'on' : ''}`, style: `--c:${color(x.id)}`, onclick: () => {
            state.profileSector = i;
            renderProfile();
          } }, `S${i + 1}`),
        ),
      ),
      beamProfile(bs, state.profileSector, hm, color(s.id)),
      h('div', { class: 'hint' },
        Number.isFinite(fp.peak)
          ? `Boresight lands at ${fmtDist(fp.peak)}; −3 dB footprint ${fmtDist(fp.near)} – ${Number.isFinite(fp.far) ? fmtDist(fp.far) : 'horizon (upper edge never descends: overshoot risk)'}.`
          : 'Boresight is at or above the horizon: no ground footprint peak. Increase tilt.',
      ),
    );
  };
  // The colours come from the rebuilt radio context, which lags the edit by a debounce.
  const ch = () => {
    changed();
    renderDerived();
    renderProfile();
    setTimeout(renderProfile, 120);
  };

  const applyPreset = (key: string) => {
    const p = presetByKey(key);
    Object.assign(bs, { tech: p.tech, band: p.band, bandwidthMHz: p.bandwidthMHz, txPowerDbm: p.txPowerDbm, heightM: p.heightM, trxCount: p.trxCount, maxUsers: p.maxUsers, antennaType: p.antennaType, maxModulation: p.modulation });
    bs.sectors.forEach((s) => Object.assign(s, { freqMHz: p.freqMHz, gain: s.hBeamwidth >= 360 ? Math.max(p.gain - 7, 2) : p.gain, vBeamwidth: p.vBeamwidth, tilt: p.tilt, frontToBack: p.frontToBack, hBeamwidth: s.hBeamwidth >= 360 ? 360 : p.hBeamwidth }));
    structural();
  };

  host.append(
    textField('Name', () => bs.name, (v) => {
      bs.name = v;
      changed();
    }),
    selectField('Operator', opOptions, () => bs.operatorId, (v) => {
      bs.operatorId = v;
      changed();
    }),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Apply template'), h('span', { class: 'ctl' }, selectEl([['', '— choose —'], ...presetOptions()], () => '', (v) => v && applyPreset(v)))),
    selectField('Technology', [['GSM', 'GSM (2G)'], ['LTE', 'LTE (4G)'], ['NR', 'NR (5G)']], () => bs.tech, (v) => {
      bs.tech = v;
      if (v === 'GSM') bs.bandwidthMHz = 0.2;
      else if (!BW_OPTIONS[v].includes(bs.bandwidthMHz)) bs.bandwidthMHz = v === 'LTE' ? 20 : 100;
      bs.antennaType = validAntennaFor(v, bs.antennaType);
      bs.maxModulation = validModulationFor(v, bs.maxModulation);
      structural();
    }),
    h('label', { class: 'field', title: antennaType(validAntennaFor(bs.tech, bs.antennaType)).note },
      h('span', { class: 'lbl' }, 'Antenna / MIMO'),
      h('span', { class: 'ctl' }, selectEl(antennaTypesFor(bs.tech).map((a) => [a.key, a.label] as [string, string]), () => validAntennaFor(bs.tech, bs.antennaType), (v) => {
        bs.antennaType = v;
        structural();
      })),
    ),
    bs.tech === 'GSM'
      ? ''
      : h('label', { class: 'field', title: schedulerInfo(bs.scheduler)?.note ?? 'Uses the default from Radio → Scheduler' },
          h('span', { class: 'lbl' }, 'Scheduler'),
          h('span', { class: 'ctl' }, selectEl(
            [['default', `Default (${schedulerInfo(store.scenario.settings.radio.scheduler)?.label ?? 'Round Robin'})`], ...SCHEDULERS.map((x) => [x.key, x.label] as [string, string])],
            () => schedulerInfo(bs.scheduler)?.key ?? 'default',
            (v) => {
              bs.scheduler = v === 'default' ? undefined : v;
              structural();
            },
          )),
        ),
    h('label', { class: 'field', title: 'Highest downlink modulation the cell uses; caps the spectral efficiency per layer. Users only reach it at high SINR.' },
      h('span', { class: 'lbl' }, 'Max modulation'),
      h('span', { class: 'ctl' }, (() => {
        const sel = selectEl(modulationsFor(bs.tech).map((m) => [m.key, m.label] as [string, string]), () => validModulationFor(bs.tech, bs.maxModulation), (v) => {
          bs.maxModulation = v;
          ch();
        });
        sel.disabled = bs.tech === 'GSM';
        return sel;
      })()),
    ),
    textField('Band label', () => bs.band, (v) => {
      bs.band = v;
      changed();
    }),
    bs.tech === 'GSM'
      ? numField('TRX per sector', () => bs.trxCount, (v) => {
          bs.trxCount = Math.round(v);
          ch();
        }, { min: 1, max: 12, step: 1 })
      : selectField('Bandwidth', BW_OPTIONS[bs.tech].map((b) => [String(b), `${b} MHz`] as [string, string]), () => String(bs.bandwidthMHz), (v) => {
          bs.bandwidthMHz = +v;
          ch();
        }),
    numField('Tx power', () => bs.txPowerDbm, (v) => {
      bs.txPowerDbm = v;
      ch();
    }, { min: -10, max: 70, step: 0.5, unit: 'dBm', title: 'Per sector, at the radio output (before feeder loss)' }),
    numField('Antenna height', () => bs.heightM, (v) => {
      bs.heightM = v;
      ch();
    }, { min: 1, max: 300, unit: 'm' }),
    numField('Feeder/cable loss', () => bs.cableLossDb, (v) => {
      bs.cableLossDb = v;
      ch();
    }, { min: 0, max: 20, step: 0.1, unit: 'dB' }),
    numField('Max active users', () => bs.maxUsers, (v) => {
      bs.maxUsers = Math.round(v);
      changed();
    }, { min: 1, step: 1, unit: '/sector' }),
    numField('Latitude', () => bs.lat, (v) => {
      bs.lat = v;
      changed();
    }, { step: 0.0001 }),
    numField('Longitude', () => bs.lng, (v) => {
      bs.lng = v;
      changed();
    }, { step: 0.0001 }),
    checkField('Enabled (on air)', () => bs.enabled, (v) => {
      bs.enabled = v;
      changed();
    }),
    derived,
    h('h4', null, 'Sectors'),
    h('div', { class: 'sector-grid' },
      h('div', { class: 'sg-head' }, ...['On', 'Az°', 'H-BW°', 'V-BW°', 'Tilt°', 'Gain dBi', 'F/B dB', 'Freq MHz', bs.tech === 'GSM' ? 'BSIC' : 'PCI', ''].map((t) => h('span', null, t))),
      ...bs.sectors.map((s, i) => sectorRow(bs, s, i, ch, structural)),
    ),
    h('div', { class: 'row' },
      button('+ Sector', () => {
        const last = bs.sectors[bs.sectors.length - 1];
        const p = presetByKey(PRESETS.find((x) => x.tech === bs.tech)?.key ?? 'lte1800');
        const s = last ? { ...last, id: newId('s'), azimuth: (last.azimuth + 120) % 360, pci: last.pci + 1 } : makeSector(p, 0, 0);
        bs.sectors.push(s);
        structural();
      }),
      button('Make 3-sector', () => {
        const t = bs.sectors[0];
        bs.sectors = [0, 120, 240].map((az, i) => ({ ...(t ?? makeSector(presetByKey('lte1800'), 0, 0)), id: newId('s'), azimuth: (az + (t && t.hBeamwidth < 360 ? t.azimuth : 0)) % 360, hBeamwidth: t && t.hBeamwidth < 360 ? t.hBeamwidth : 65, gain: t && t.hBeamwidth >= 360 ? t.gain + 7 : (t?.gain ?? 17), pci: (t ? t.pci - (t.pci % 3) : 0) + i }));
        structural();
      }),
      button('Make omni', () => {
        const t = bs.sectors[0];
        bs.sectors = [{ ...t, id: newId('s'), azimuth: 0, hBeamwidth: 360, gain: t.hBeamwidth >= 360 ? t.gain : Math.max(t.gain - 7, 2) }];
        structural();
      }),
    ),
    h('h4', null, 'Handover parameters (per cell)'),
    hoTable(app, bs, changed),
    h('h4', null, 'Vertical beam (side view)'),
    profileHost,
    h('div', { class: 'row' },
      button('Duplicate', () => {
        const copy: BaseStation = JSON.parse(JSON.stringify(bs));
        copy.id = newId('bs');
        copy.name = bs.name + "'";
        copy.lat += 0.002;
        copy.sectors.forEach((s) => (s.id = newId('s')));
        store.addStations([copy]);
        store.select(copy.id);
      }),
      button('Delete station', () => store.removeStation(bs.id), 'danger'),
    ),
  );
  renderProfile();
}

/**
 * Per-sector A3 parameters. Empty = the global value for the RAT (Radio → thresholds),
 * shown as the placeholder.
 */
function hoTable(app: App, bs: BaseStation, changed: () => void): HTMLElement {
  const th = app.store.scenario.settings.thresholds[bs.tech];
  const cols: { key: 'hysteresisDb' | 'a3OffsetDb' | 'tttMs' | 'cioDb'; label: string; def: number; step: number; min: number; max: number; title: string }[] = [
    { key: 'hysteresisDb', label: 'Hyst dB', def: th.hysteresisDb, step: 0.5, min: 0, max: 15, title: 'Hysteresis: how much stronger a neighbour must be before UEs leave this cell' },
    { key: 'a3OffsetDb', label: 'A3 off dB', def: th.a3OffsetDb, step: 0.5, min: -15, max: 15, title: 'A3 offset: extra margin on top of the hysteresis' },
    { key: 'tttMs', label: 'TTT ms', def: th.tttMs, step: 40, min: 0, max: 5120, title: 'Time to trigger: how long the condition must hold' },
    { key: 'cioDb', label: 'CIO dB', def: 0, step: 0.5, min: -24, max: 24, title: 'Cell individual offset: + makes this cell more attractive as a handover target, − less' },
  ];
  return h('div', { class: 'ho-grid' },
    h('div', { class: 'ho-head' }, h('span', null, ''), ...cols.map((c) => h('span', { title: c.title }, c.label))),
    ...bs.sectors.map((s, i) =>
      h('div', { class: 'ho-row' },
        h('span', null, `S${i + 1}`),
        ...cols.map((c) => {
          const cur = s.ho?.[c.key];
          const input = h('input', { type: 'number', step: String(c.step), placeholder: String(c.def), value: cur === undefined ? '' : String(cur), title: `${c.title} (empty = default ${c.def})`, onchange: () => {
            const v = parseFloat(input.value);
            s.ho ??= {};
            if (input.value.trim() === '' || !Number.isFinite(v)) delete s.ho[c.key];
            else s.ho[c.key] = Math.min(c.max, Math.max(c.min, v));
            if (!Object.keys(s.ho).length) delete s.ho;
            input.classList.toggle('set', s.ho?.[c.key] !== undefined);
            changed();
          } });
          if (cur !== undefined) input.classList.add('set');
          return input;
        }),
      ),
    ),
    h('div', { class: 'hint' }, `Handover when neighbour + its CIO > this cell + its CIO + A3 offset + hysteresis, for the TTT. Empty = ${bs.tech} default (Radio tab).`),
  );
}

function sectorRow(bs: BaseStation, s: Sector, i: number, changed: () => void, structural: () => void): HTMLElement {
  const num = (get: () => number, set: (v: number) => void, step = 1, min?: number, max?: number) => {
    const input = h('input', {
      type: 'number',
      value: String(get()),
      step: String(step),
      onchange: () => {
        let v = parseFloat(input.value);
        if (!Number.isFinite(v)) return;
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        input.value = String(v);
        set(v);
        changed();
        chLabel.textContent = chText();
      },
    });
    return input;
  };
  const chText = () => {
    const c = channelNumber(bs.tech, s.freqMHz);
    return c ? `${c.label} ${c.value}` : '';
  };
  const chLabel = h('span', { class: 'chnum' }, chText());
  const on = h('input', { type: 'checkbox', checked: s.enabled, onchange: () => {
    s.enabled = on.checked;
    changed();
  } });
  return h('div', { class: 'sg-row' },
    on,
    num(() => s.azimuth, (v) => (s.azimuth = ((v % 360) + 360) % 360), 5),
    num(() => s.hBeamwidth, (v) => (s.hBeamwidth = v), 5, 10, 360),
    num(() => s.vBeamwidth, (v) => (s.vBeamwidth = v), 1, 1, 90),
    num(() => s.tilt, (v) => (s.tilt = v), 0.5, -10, 30),
    num(() => s.gain, (v) => (s.gain = v), 0.5, -10, 35),
    num(() => s.frontToBack, (v) => (s.frontToBack = v), 1, 0, 50),
    h('span', { class: 'freq' }, num(() => s.freqMHz, (v) => (s.freqMHz = v), bs.tech === 'GSM' ? 0.2 : 0.1, 100, 6000), chLabel),
    num(() => s.pci, (v) => (s.pci = Math.round(v)), 1, 0, bs.tech === 'GSM' ? 63 : bs.tech === 'LTE' ? 503 : 1007),
    h('button', { class: 'btn icon', type: 'button', title: 'Remove sector', onclick: () => {
      if (bs.sectors.length <= 1) return;
      bs.sectors.splice(i, 1);
      structural();
    } }, '×'),
  );
}
