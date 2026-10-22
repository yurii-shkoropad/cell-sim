import { hexGrid, randomSites } from '../../planning/patterns';
import { cellColor } from '../../radio/cells';
import { antennaType, antennaTypesFor, bestRank, validAntennaFor } from '../../radio/mimo';
import { modulation, modulationsFor, validModulationFor } from '../../radio/modulation';
import { channelNumber, gsmTrafficChannels, makeSector, makeStation, newId, PRESETS, presetByKey, rbBandwidthHz, resourceBlocks } from '../../radio/presets';
import { verticalFootprint } from '../../radio/antenna';
import { validity } from '../../radio/propagation';
import type { BaseStation, Sector, Tech } from '../../types';
import type { App } from '../app';
import { beamProfile, fmtDist } from '../beamProfile';
import { button, checkField, clear, colorField, fmt, h, numField, section, selectEl, selectField, textField, toast } from '../dom';

const BW_OPTIONS: Record<Tech, number[]> = {
  GSM: [0.2],
  LTE: [1.4, 3, 5, 10, 15, 20],
  NR: [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100],
};

export function networkPanel(app: App): HTMLElement {
  const { store } = app;
  const root = h('div', { class: 'panel' });
  const editorHost = h('div');
  const listHost = h('div');
  const opsHost = h('div');

  // ---------------------------------------------------------------- add / generate
  const gen = { preset: 'lte1800', operatorId: store.scenario.operators[0]?.id ?? '', sectors: 3, rings: 1, isd: 800, azOff: 0, count: 10 };
  const opOptions = () => store.scenario.operators.map((o) => [o.id, o.name] as [string, string]);
  const presetOptions = PRESETS.map((p) => [p.key, p.label] as [string, string]);

  const addBtn = button('Click map to place', () => app.mapView.setPlaceMode(app.mapView.placeMode === 'site' ? null : 'site'), 'primary');
  app.mapView.onPlaceModeChange(() => {
    const on = app.mapView.placeMode === 'site';
    addBtn.classList.toggle('active', on);
    addBtn.textContent = on ? 'Placing… (click to stop)' : 'Click map to place';
  });

  app.mapView.onAddSite = (lat, lng) => {
    const p = presetByKey(gen.preset);
    const n = store.scenario.stations.filter((s) => s.operatorId === gen.operatorId).length + 1;
    const opName = store.scenario.operators.find((o) => o.id === gen.operatorId)?.name ?? 'BS';
    const bs = makeStation(p, lat, lng, gen.operatorId, `${opName.slice(0, 2).toUpperCase()}-${p.tech[0]}${String(n).padStart(2, '0')}`, { sectors: gen.sectors, pciBase: (n * 3) % 504 });
    store.addStations([bs]);
    store.select(bs.id);
  };

  const opSelHost = h('span');
  const renderOpSelect = () => {
    clear(opSelHost);
    if (!store.scenario.operators.some((o) => o.id === gen.operatorId)) gen.operatorId = store.scenario.operators[0]?.id ?? '';
    opSelHost.appendChild(selectField('Operator', opOptions(), () => gen.operatorId, (v) => (gen.operatorId = v)));
  };
  renderOpSelect();

  root.appendChild(
    section(
      'Add sites',
      selectField('Template', presetOptions, () => gen.preset, (v) => (gen.preset = v)),
      opSelHost,
      selectField('Sectors', [['1', 'Omni'], ['3', '3 sectors'], ['6', '6 sectors']], () => String(gen.sectors) as '1' | '3' | '6', (v) => (gen.sectors = +v)),
      h('div', { class: 'row' }, addBtn),
      h('details', null,
        h('summary', null, 'Patterns'),
        numField('Hex rings', () => gen.rings, (v) => (gen.rings = Math.round(v)), { min: 0, max: 6, step: 1, title: '0 = 1 site, 1 = 7 sites, 2 = 19 sites…' }),
        numField('Inter-site distance', () => gen.isd, (v) => (gen.isd = v), { min: 50, step: 50, unit: 'm' }),
        numField('Azimuth offset', () => gen.azOff, (v) => (gen.azOff = v), { min: 0, max: 359, unit: '°' }),
        h('div', { class: 'row' },
          button('Hex grid at map centre', () => {
            const c = app.mapView.map.getCenter();
            const p = presetByKey(gen.preset);
            const opName = store.scenario.operators.find((o) => o.id === gen.operatorId)?.name ?? 'BS';
            const list = hexGrid({ centerLat: c.lat, centerLng: c.lng, isdM: gen.isd, rings: gen.rings, sectors: gen.sectors, azimuthOffset: gen.azOff, operatorId: gen.operatorId, preset: p, namePrefix: `${opName.slice(0, 2).toUpperCase()}-H${p.tech[0]}` });
            store.addStations(list);
            toast(`Added ${list.length} sites`, 'ok');
          }),
        ),
        numField('Random count', () => gen.count, (v) => (gen.count = Math.round(v)), { min: 1, max: 200, step: 1 }),
        h('div', { class: 'row' },
          button('Scatter in view', () => {
            const b = app.mapView.map.getBounds();
            const p = presetByKey(gen.preset);
            const list = randomSites({ south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() }, gen.count, p, gen.operatorId, `R${p.tech[0]}`, gen.sectors);
            store.addStations(list);
            toast(`Added ${list.length} sites`, 'ok');
          }),
        ),
      ),
    ),
  );

  root.appendChild(editorHost);
  root.appendChild(opsHost);
  root.appendChild(listHost);

  // ---------------------------------------------------------------- operators
  const renderOperators = () => {
    clear(opsHost);
    const rows = store.scenario.operators.map((o) =>
      h('div', { class: 'op-row' },
        colorField('', () => o.color, (v) => {
          o.color = v;
          store.emit('network');
        }),
        textField('', () => o.name, (v) => {
          o.name = v;
          store.emit('network');
          renderOpSelect();
        }),
        textField('', () => o.plmn, (v) => (o.plmn = v), 'PLMN (MCC-MNC) used to match imported cells'),
        numField('', () => o.marketShare, (v) => {
          o.marketShare = v;
          store.emit('settings');
        }, { min: 0, step: 1, unit: '%', title: 'Subscriber share (relative weight)' }),
        button('×', () => {
          if (store.scenario.stations.some((s) => s.operatorId === o.id)) {
            toast('Remove or reassign this operator’s stations first', 'error');
            return;
          }
          store.scenario.operators = store.scenario.operators.filter((x) => x.id !== o.id);
          store.emit('network');
          renderOperators();
          renderOpSelect();
        }, 'icon', 'Delete operator'),
      ),
    );
    opsHost.appendChild(
      h('details', { class: 'sec' },
        h('summary', null, h('h3', { style: 'display:inline' }, `Operators (${store.scenario.operators.length})`)),
        h('div', { class: 'op-head' }, h('span', null, 'Colour'), h('span', null, 'Name'), h('span', null, 'PLMN'), h('span', null, 'Share')),
        ...rows,
        h('div', { class: 'row' }, button('+ Operator', () => {
          const n = store.scenario.operators.length;
          store.scenario.operators.push({ id: newId('op'), name: `Operator ${n + 1}`, plmn: '', color: cellColor(n + 4), marketShare: 10 });
          store.emit('network');
          renderOperators();
          renderOpSelect();
        })),
      ),
    );
  };

  // ---------------------------------------------------------------- station list
  let filter = '';
  const renderList = () => {
    clear(listHost);
    const ops = new Map(store.scenario.operators.map((o) => [o.id, o]));
    const q = filter.toLowerCase();
    const items = store.scenario.stations.filter((s) => !q || s.name.toLowerCase().includes(q) || s.band.toLowerCase().includes(q) || s.tech.toLowerCase().includes(q) || (ops.get(s.operatorId)?.name.toLowerCase().includes(q) ?? false));
    const search = h('input', { type: 'search', placeholder: 'Filter by name, tech, band, operator', value: filter, oninput: () => {
      filter = search.value;
      renderList();
      const el = listHost.querySelector('input[type=search]') as HTMLInputElement;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    } });
    listHost.appendChild(
      section(
        `Stations (${store.scenario.stations.length})`,
        search,
        h('div', { class: 'st-list' },
          ...items.map((s) =>
            h('div', { class: `st-item ${store.selectedStationId === s.id ? 'sel' : ''} ${s.enabled ? '' : 'off'}`, onclick: () => {
              store.select(s.id);
              app.mapView.focusStation(s.id);
            } },
              h('span', { class: 'dot', style: `background:${ops.get(s.operatorId)?.color ?? '#888'}` }),
              h('span', { class: 'nm' }, s.name),
              h('span', { class: 'meta' }, `${s.tech} ${s.band} · ${s.sectors.length}×`),
            ),
          ),
        ),
        store.scenario.stations.length
          ? h('div', { class: 'row' }, button('Delete all listed', () => {
              if (!confirm(`Delete ${items.length} stations?`)) return;
              const ids = new Set(items.map((s) => s.id));
              store.scenario.stations = store.scenario.stations.filter((s) => !ids.has(s.id));
              store.select(null);
              store.emit('network');
            }, 'danger'))
          : null,
      ),
    );
  };

  // ---------------------------------------------------------------- editor
  let liveHost: HTMLElement | null = null;
  let profileSector = 0;
  const renderEditor = () => {
    clear(editorHost);
    liveHost = null;
    const bs = store.station(store.selectedStationId);
    if (!bs) return;
    const changed = () => store.emit('network');
    const structural = () => {
      store.emit('network');
      renderEditor();
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
      if (profileSector >= bs.sectors.length) profileSector = 0;
      const ctx = app.ctx();
      const color = (id: string) => ctx.cells.find((c) => c.sectorId === id)?.color ?? '#2a78d6';
      const hm = store.scenario.settings.radio.ueHeightM;
      const s = bs.sectors[profileSector];
      const fp = verticalFootprint(bs.heightM, hm, s.tilt, s.vBeamwidth);
      profileHost.append(
        h('div', { class: 'bp-tabs' },
          ...bs.sectors.map((x, i) =>
            h('button', { type: 'button', class: `chip ${i === profileSector ? 'on' : ''}`, style: `--c:${color(x.id)}`, onclick: () => {
              profileSector = i;
              renderProfile();
            } }, `S${i + 1}`),
          ),
        ),
        beamProfile(bs, profileSector, hm, color(s.id)),
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

    const sectorRows = bs.sectors.map((s, i) => sectorRow(bs, s, i, ch, structural));
    liveHost = h('div', { class: 'live' });

    editorHost.appendChild(
      h('section', { class: 'sec editor' },
        h('div', { class: 'editor-head' },
          h('h3', null, `Edit ${bs.name}`),
          button('✕', () => store.select(null), 'icon', 'Close'),
        ),
        textField('Name', () => bs.name, (v) => {
          bs.name = v;
          changed();
        }),
        selectField('Operator', opOptions(), () => bs.operatorId, (v) => {
          bs.operatorId = v;
          changed();
        }),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Apply template'), h('span', { class: 'ctl' }, selectEl([['', '— choose —'], ...presetOptions], () => '', (v) => v && applyPreset(v)))),
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
          ...sectorRows,
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
        h('h4', null, 'Vertical beam (side view)'),
        profileHost,
        h('h4', null, 'Live sector stats'),
        liveHost,
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
      ),
    );
    renderProfile();
    renderLive();
  };

  const renderLive = () => {
    if (!liveHost) return;
    const bs = store.station(store.selectedStationId);
    if (!bs) return;
    const ctx = app.ctx();
    clear(liveHost);
    const rows = bs.sectors.map((s, i) => {
      const idx = ctx.cells.findIndex((c) => c.sectorId === s.id);
      const st = idx >= 0 ? app.engine.cells[idx] : undefined;
      if (!st) return h('div', { class: 'live-row' }, h('span', null, `S${i + 1}`), h('span', null, 'off air'));
      return h('div', { class: 'live-row' },
        h('span', { class: 'dot', style: `background:${ctx.cells[idx].color}` }),
        h('span', null, `S${i + 1}`),
        h('span', { title: 'PRB / TCH utilisation' }, `load ${(st.load * 100).toFixed(0)}%`),
        h('span', { title: 'active sessions / camped users' }, `${st.active}/${st.camped} UE`),
        h('span', { title: 'handovers in / out' }, `HO ${st.hoIn}↓ ${st.hoOut}↑`),
        h('span', { title: 'drops / blocks' }, `✖${st.drops} ⛔${st.blocks}`),
      );
    });
    liveHost.append(...rows);
  };

  app.onLiveTick(renderLive);
  store.on('selection', () => {
    renderEditor();
    renderList();
  });
  store.on('network', () => renderList());
  store.on('scenario', () => {
    renderOperators();
    renderOpSelect();
  });
  renderOperators();
  renderList();
  renderEditor();
  return root;
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
