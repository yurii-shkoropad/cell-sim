import { newId } from '../../radio/presets';
import { TECHS, type FixedUser, type Mobility, type Tech, type TechThresholds, type TrafficMode } from '../../types';
import type { App } from '../app';
import { button, checkField, clear, h, numField, section, selectField } from '../dom';

/** Manually placed users: placement template, click-to-place, list. */
function fixedUsersSection(app: App): HTMLElement {
  const { store, engine, mapView } = app;
  const tpl: { operatorId: string; mobility: Mobility; traffic: TrafficMode } = { operatorId: store.scenario.operators[0]?.id ?? '', mobility: 'static', traffic: 'data' };
  const listHost = h('div', { class: 'st-list' });
  const placeBtn = button('Click map to place users', () => mapView.setPlaceMode(mapView.placeMode === 'user' ? null : 'user'), 'primary');
  mapView.onPlaceModeChange(() => {
    const on = mapView.placeMode === 'user';
    placeBtn.classList.toggle('active', on);
    placeBtn.textContent = on ? 'Placing… (click to stop)' : 'Click map to place users';
  });

  mapView.onAddUser = (lat, lng) => {
    const list = (store.scenario.fixedUsers ??= []);
    const f: FixedUser = { id: newId('fu'), name: `Fixed ${list.length + 1}`, lat, lng, operatorId: tpl.operatorId, techs: [...TECHS], mobility: tpl.mobility, traffic: tpl.traffic, demandMbps: tpl.traffic === 'data' ? 5 : null };
    list.push(f);
    const u = engine.addFixedUser(f);
    store.emit('users');
    mapView.renderUsers(engine);
    app.openUser(u.id);
  };

  const renderList = () => {
    clear(listHost);
    const list = store.scenario.fixedUsers ?? [];
    const ops = new Map(store.scenario.operators.map((o) => [o.id, o]));
    if (!list.length) listHost.appendChild(h('div', { class: 'hint', style: 'padding:6px 8px' }, 'No fixed users yet.'));
    for (const f of list) {
      listHost.appendChild(
        h('div', { class: 'st-item', onclick: (e: MouseEvent) => {
          if ((e.target as HTMLElement).closest('.btn')) return; // the × button
          const u = engine.users.find((x) => x.fixedId === f.id);
          if (!u) return;
          mapView.map.panTo([u.lat, u.lng]);
          app.openUser(u.id);
        } },
          h('span', { class: 'dot', style: `background:${ops.get(f.operatorId)?.color ?? '#888'}` }),
          h('span', { class: 'nm' }, f.name),
          h('span', { class: 'meta' }, `${f.mobility} · ${f.traffic}`),
          button('×', () => {
            store.scenario.fixedUsers = list.filter((x) => x.id !== f.id);
            const u = engine.users.find((x) => x.fixedId === f.id);
            if (u) engine.removeUser(u.id);
            store.emit('users');
            mapView.renderUsers(engine);
          }, 'icon', 'Delete fixed user'),
        ),
      );
    }
  };
  renderList();
  store.on('users', renderList);
  store.on('scenario', renderList);

  return section('Fixed users',
    h('p', { class: 'hint' }, 'Users you place by hand. They are saved in the scenario and survive resets, so they work as measurement probes (indoor UE, office, stadium). Drag any user on the map to move it, and click one to inspect or edit it.'),
    selectField('Operator', store.scenario.operators.map((o) => [o.id, o.name] as [string, string]), () => tpl.operatorId, (v) => (tpl.operatorId = v)),
    selectField('Mobility', [['static', 'Static'], ['walk', 'Pedestrian'], ['drive', 'Vehicle']], () => tpl.mobility, (v) => (tpl.mobility = v)),
    selectField('Traffic', [['data', 'Continuous data'], ['voice', 'Continuous voice'], ['random', 'Random (Poisson)'], ['idle', 'Idle']], () => tpl.traffic, (v) => (tpl.traffic = v)),
    h('div', { class: 'row' }, placeBtn),
    listHost,
  );
}

export function usersPanel(app: App): HTMLElement {
  const { store } = app;
  const root = h('div', { class: 'panel' });
  const status = h('div', { class: 'status-line' });
  const updateStatus = () => {
    const g = app.roads();
    status.textContent = g
      ? `Road graph: ${g.wayCount} ways, ${g.walk.pool.length} walkable / ${g.drive.pool.length} drivable nodes`
      : 'No road graph loaded: users move by random waypoint inside the area';
  };
  updateStatus();
  app.onLiveTick(updateStatus);

  const loadBtn = button('Load OSM roads for current view', async () => {
    loadBtn.disabled = true;
    loadBtn.textContent = 'Loading roads from Overpass…';
    try {
      await app.loadRoads();
    } finally {
      loadBtn.disabled = false;
      loadBtn.textContent = 'Load OSM roads for current view';
      updateStatus();
    }
  }, 'primary');

  const fixedSection = fixedUsersSection(app);
  const render = () => {
    clear(root);
    const u = store.scenario.settings.users;
    const set = () => store.emit('settings');
    root.append(
      section('Mobility area',
        h('p', { class: 'hint' }, 'Users move along real OpenStreetMap streets: pedestrians on footways and streets, vehicles on drivable roads (one-ways respected). Each user picks random destinations and follows the shortest path (A*).'),
        h('div', { class: 'row' }, loadBtn),
        status,
      ),
      fixedSection,
      section('Population',
        numField('Users', () => u.count, (v) => {
          u.count = Math.round(v);
          set();
        }, { min: 0, max: 5000, step: 10, title: 'Randomly generated users (fixed users come on top)' }),
        numField('Static users', () => u.staticShare, (v) => {
          u.staticShare = v;
          set();
        }, { min: 0, max: 100, scale: 100, unit: '%', title: 'Share of random users that never move (indoor / stationary)' }),
        numField('Pedestrians (of moving)', () => u.pedestrianShare, (v) => {
          u.pedestrianShare = v;
          set();
        }, { min: 0, max: 100, scale: 100, unit: '%' }),
        numField('Walk speed min', () => u.pedSpeedMin, (v) => {
          u.pedSpeedMin = v;
          set();
        }, { min: 0.1, step: 0.1, unit: 'm/s' }),
        numField('Walk speed max', () => u.pedSpeedMax, (v) => {
          u.pedSpeedMax = v;
          set();
        }, { min: 0.1, step: 0.1, unit: 'm/s' }),
        numField('Vehicle speed min', () => u.vehSpeedMin, (v) => {
          u.vehSpeedMin = v;
          set();
        }, { min: 0.5, step: 0.5, unit: 'm/s' }),
        numField('Vehicle speed max', () => u.vehSpeedMax, (v) => {
          u.vehSpeedMax = v;
          set();
        }, { min: 0.5, step: 0.5, unit: 'm/s' }),
        numField('LTE-capable devices', () => u.lteCapableShare, (v) => {
          u.lteCapableShare = v;
          set();
        }, { min: 0, max: 100, scale: 100, unit: '%' }),
        numField('NR-capable devices', () => u.nrCapableShare, (v) => {
          u.nrCapableShare = v;
          set();
        }, { min: 0, max: 100, scale: 100, unit: '%', title: 'NR-capable devices are also LTE-capable' }),
        numField('Rx antennas: NR devices', () => u.ueRxNr, (v) => {
          u.ueRxNr = Math.round(v);
          set();
        }, { min: 1, max: 8, step: 1, title: 'Limits MIMO layers and sets receive-combining gain' }),
        numField('Rx antennas: LTE devices', () => u.ueRxLte, (v) => {
          u.ueRxLte = Math.round(v);
          set();
        }, { min: 1, max: 8, step: 1, title: 'GSM-only devices always have 1' }),
        h('p', { class: 'hint' }, 'Operator subscriber shares are set in Network → Operators.'),
      ),
      section('Traffic (per user, Poisson arrivals, exponential durations)',
        numField('Voice calls', () => u.voiceCallsPerHour, (v) => {
          u.voiceCallsPerHour = v;
          set();
        }, { min: 0, step: 0.5, unit: '/hour' }),
        numField('Mean call duration', () => u.voiceMeanDurationS, (v) => {
          u.voiceMeanDurationS = v;
          set();
        }, { min: 1, unit: 's' }),
        numField('Data sessions', () => u.dataSessionsPerHour, (v) => {
          u.dataSessionsPerHour = v;
          set();
        }, { min: 0, step: 1, unit: '/hour' }),
        numField('Mean session duration', () => u.dataMeanDurationS, (v) => {
          u.dataMeanDurationS = v;
          set();
        }, { min: 1, unit: 's' }),
        numField('Mean data demand', () => u.dataMeanDemandMbps, (v) => {
          u.dataMeanDemandMbps = v;
          set();
        }, { min: 0.01, step: 0.5, unit: 'Mbps' }),
        h('p', { class: 'hint' }, `Offered load ≈ ${(u.count * (u.voiceCallsPerHour * u.voiceMeanDurationS) / 3600).toFixed(1)} Erl voice, ${(u.count * (u.dataSessionsPerHour * u.dataMeanDurationS) / 3600 * u.dataMeanDemandMbps).toFixed(0)} Mbps data demand.`),
      ),
      h('div', { class: 'row' }, button('Respawn users with these settings', () => app.respawnUsers(), 'primary')),
    );
  };
  render();
  store.on('scenario', render);
  return root;
}

export function radioPanel(app: App): HTMLElement {
  const { store } = app;
  const root = h('div', { class: 'panel' });
  const render = () => {
    clear(root);
    const r = store.scenario.settings.radio;
    const s = store.scenario.settings.sim;
    const set = () => store.emit('settings');
    root.append(
      section('Propagation',
        selectField('Environment', [['urban-large', 'Urban – large/metropolitan city'], ['urban-medium', 'Urban – medium/small city'], ['suburban', 'Suburban'], ['rural', 'Rural / open area']], () => r.environment, (v) => {
          r.environment = v;
          set();
        }),
        selectField('Path-loss model', [['auto', 'Auto (Hata ≤1500 MHz, COST-231 above)'], ['okumura-hata', 'Okumura-Hata'], ['cost231-hata', 'COST-231 Hata']], () => r.model, (v) => {
          r.model = v;
          set();
        }),
        numField('UE antenna height', () => r.ueHeightM, (v) => {
          r.ueHeightM = v;
          set();
        }, { min: 1, max: 10, step: 0.1, unit: 'm' }),
        checkField('Log-normal shadowing', () => r.shadowingEnabled, (v) => {
          r.shadowingEnabled = v;
          set();
        }),
        numField('Shadowing σ', () => r.shadowingSigmaDb, (v) => {
          r.shadowingSigmaDb = v;
          set();
        }, { min: 0, max: 20, step: 0.5, unit: 'dB' }),
        numField('Decorrelation distance', () => r.shadowingDecorrM, (v) => {
          r.shadowingDecorrM = v;
          set();
        }, { min: 5, max: 500, step: 5, unit: 'm' }),
      ),
      section('Receiver & interference',
        numField('UE noise figure', () => r.ueNoiseFigureDb, (v) => {
          r.ueNoiseFigureDb = v;
          set();
        }, { min: 0, max: 20, step: 0.5, unit: 'dB' }),
        selectField('Interferer load', [['actual', 'Simulated cell load'], ['full', '100% (worst case)']], () => r.interferenceLoad, (v) => {
          r.interferenceLoad = v;
          set();
        }),
        numField('Minimum interferer load', () => r.minInterfererLoad, (v) => {
          r.minInterfererLoad = v;
          set();
        }, { min: 0, max: 100, scale: 100, unit: '%', title: 'Reference signals and control channels always radiate' }),
        numField('GSM adjacent-channel rejection', () => r.gsmAdjacentRejectionDb, (v) => {
          r.gsmAdjacentRejectionDb = v;
          set();
        }, { min: 0, max: 60, unit: 'dB' }),
      ),
      section('Throughput (truncated Shannon)',
        h('p', { class: 'hint' }, 'The per-layer efficiency cap comes from each station’s max modulation (Network → station editor).'),
        numField('Attenuation α', () => r.shannonAlpha, (v) => {
          r.shannonAlpha = v;
          set();
        }, { min: 0.1, max: 1, step: 0.05 }),
        numField('SINR min', () => r.sinrMinDb, (v) => {
          r.sinrMinDb = v;
          set();
        }, { min: -20, max: 10, step: 0.5, unit: 'dB' }),
        numField('Overhead', () => r.overhead, (v) => {
          r.overhead = v;
          set();
        }, { min: 0, max: 60, scale: 100, unit: '%' }),
        numField('Precoding efficiency', () => r.precodingEfficiency, (v) => {
          r.precodingEfficiency = v;
          set();
        }, { min: 0, max: 1, step: 0.05, title: 'Share (in dB) of the ideal codebook precoding gain 10·log10(Ntx/rank) that is realised' }),
        numField('MU-MIMO pairing efficiency', () => r.muMimoEfficiency, (v) => {
          r.muMimoEfficiency = v;
          set();
        }, { min: 0, max: 1, step: 0.05, title: 'Capacity added by each extra co-scheduled user on massive-MIMO / 8T8R cells' }),
      ),
      section('Mobility management thresholds', thresholdTable(store.scenario.settings.thresholds, set)),
      section('Simulation',
        numField('Time step', () => s.stepMs, (v) => {
          s.stepMs = v;
          set();
        }, { min: 50, max: 2000, step: 50, unit: 'ms' }),
        numField('Ping-pong window', () => s.pingPongWindowS, (v) => {
          s.pingPongWindowS = v;
          set();
        }, { min: 0.5, max: 60, step: 0.5, unit: 's' }),
        numField('Neighbour radius', () => s.neighbourRadiusM, (v) => {
          s.neighbourRadiusM = v;
          set();
        }, { min: 100, step: 100, unit: 'm', title: 'Used by planning checks' }),
        numField('Random seed', () => s.seed, (v) => {
          s.seed = Math.round(v);
          set();
        }, { step: 1, title: 'Applied on reset' }),
      ),
    );
  };
  render();
  store.on('scenario', render);
  return root;
}

function thresholdTable(th: Record<Tech, TechThresholds>, changed: () => void): HTMLElement {
  const rows: [keyof TechThresholds, string, string][] = [
    ['minRxDbm', 'Min level (camp/serve)', 'dBm'],
    ['a3OffsetDb', 'A3 offset', 'dB'],
    ['hysteresisDb', 'Hysteresis', 'dB'],
    ['tttMs', 'Time to trigger', 'ms'],
    ['b2ServingDbm', 'Inter-RAT (B2) serving below', 'dBm'],
    ['qOutSinrDb', 'RLF SINR (Qout)', 'dB'],
    ['rlfTimerMs', 'RLF timer (T310)', 'ms'],
    ['priority', 'Selection priority', ''],
  ];
  return h('div', { class: 'th-grid' },
    h('span', null, ''),
    ...TECHS.map((t) => h('span', { class: 'th-h' }, t)),
    ...rows.flatMap(([k, label, unit]) => [
      h('span', { class: 'th-l' }, unit ? `${label} (${unit})` : label),
      ...TECHS.map((t) => {
        const input = h('input', { type: 'number', value: String(th[t][k]), step: 'any', onchange: () => {
          const v = parseFloat(input.value);
          if (!Number.isFinite(v)) return;
          th[t][k] = v;
          changed();
        } });
        return input;
      }),
    ]),
  );
}

export function layersPanel(app: App): HTMLElement {
  const { store } = app;
  const root = h('div', { class: 'panel' });
  const render = () => {
    clear(root);
    const l = store.layers;
    const changed = (recompute: boolean) => {
      store.emit('layers');
      if (recompute) app.heatmap.schedule(0);
      else app.heatmap.redraw();
    };
    root.append(
      section('Coverage heatmap',
        selectField('Layer', [['none', 'Off'], ['rsrp', 'Signal level (RSRP / RxLev)'], ['server', 'Best server'], ['sinr', 'SINR / C/(I+N)'], ['throughput', 'Peak DL throughput'], ['modulation', 'Modulation reached']], () => l.heatmap, (v) => {
          l.heatmap = v;
          changed(true);
          app.mapView.renderSectors();
        }),
        selectField('Operator', [['all', 'All operators'], ...store.scenario.operators.map((o) => [o.id, o.name] as [string, string])], () => l.operatorFilter, (v) => {
          l.operatorFilter = v;
          changed(true);
          app.mapView.renderSectors();
        }),
        selectField('Technology', [['all', 'All RATs'], ['GSM', 'GSM'], ['LTE', 'LTE'], ['NR', 'NR']], () => l.techFilter, (v) => {
          l.techFilter = v;
          changed(true);
          app.mapView.renderSectors();
        }),
        rangeOpacity(app),
        selectField('Resolution', [['2', 'Fine (2 px)'], ['4', 'Normal (4 px)'], ['8', 'Coarse (8 px)'], ['16', 'Draft (16 px)']], () => String(l.resolutionPx) as '2' | '4' | '8' | '16', (v) => {
          l.resolutionPx = +v;
          changed(true);
        }),
        h('p', { class: 'hint' }, 'Signal level is the best cell of the selected operator/RAT. SINR counts interference from every cell on overlapping spectrum (all operators). Hover over the map to read values.'),
      ),
      section('Overlays',
        checkField('Sectors', () => l.showSectors, (v) => {
          l.showSectors = v;
          app.mapView.renderSectors();
        }),
        checkField('Users', () => l.showUsers, (v) => {
          l.showUsers = v;
          app.mapView.renderUsers(app.engine);
        }),
        checkField('Links: active user → serving cell', () => l.showLinks, (v) => {
          l.showLinks = v;
          app.mapView.renderUsers(app.engine);
        }),
        checkField('Road graph', () => l.showRoads, (v) => {
          l.showRoads = v;
          app.mapView.setRoadsVisible(v);
        }),
        h('div', { class: 'legend-users' },
          h('span', null, h('i', { style: 'background:#9e9e9e' }), 'idle'),
          h('span', null, h('i', { style: 'background:#1565c0' }), 'voice'),
          h('span', null, h('i', { style: 'background:#2e7d32' }), 'data'),
          h('span', null, h('i', { style: 'background:#000' }), 'no service'),
          h('span', null, h('i', { style: 'background:#fff;border:2px solid #222' }), 'vehicle'),
          h('span', null, h('i', { style: 'background:#fff;border:2px solid #f2b705' }), 'static'),
          h('span', null, 'larger dot = fixed user'),
        ),
      ),
    );
  };
  render();
  store.on('scenario', render);
  store.on('network', () => {
    // Operator list may have changed.
    if (root.isConnected) render();
  });
  // Filters can also change from elsewhere (auto-follow on new stations, legend button).
  store.on('layers', render);
  return root;
}

function rangeOpacity(app: App): HTMLElement {
  const l = app.store.layers;
  const out = h('span', { class: 'unit' }, `${Math.round(l.opacity * 100)}%`);
  const input = h('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(l.opacity), oninput: () => {
    l.opacity = +input.value;
    out.textContent = `${Math.round(l.opacity * 100)}%`;
    app.heatmap.setOpacity(l.opacity);
  } });
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Opacity'), h('span', { class: 'ctl' }, input, out));
}
