import { SCHEDULERS, schedulerInfo } from '../../sim/scheduler';
import { BUILDING_LEGEND } from '../../map/mapView';
import { TECHS, type Tech, type TechThresholds } from '../../types';
import type { App } from '../app';
import { button, checkField, clear, h, numField, section, selectField } from '../dom';

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
        selectField('Path-loss model', [['auto', 'Auto (Hata ≤1500 MHz, COST-231 above)'], ['okumura-hata', 'Okumura-Hata'], ['cost231-hata', 'COST-231 Hata'], ['cost231-wi', 'COST-231 Walfisch–Ikegami + OSM buildings']], () => r.model, (v) => {
          r.model = v;
          set();
          render();
        }),
        r.model === 'cost231-wi' ? buildingsBlock(app, set) : '',
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
      section('Scheduler (LTE / NR downlink)',
        selectField('Default scheduler', SCHEDULERS.map((x) => [x.key, x.label] as [string, string]), () => (schedulerInfo(r.scheduler)?.key ?? 'rr'), (v) => {
          r.scheduler = v;
          set();
          render();
        }),
        h('p', { class: 'hint' }, schedulerInfo(r.scheduler)?.note ?? ''),
        numField('PF diversity efficiency', () => r.pfDiversityEfficiency, (v) => {
          r.pfDiversityEfficiency = v;
          set();
        }, { min: 0, max: 1, step: 0.05, title: 'Share (in dB) of the ideal Rayleigh multi-user diversity gain 10·log10(H_n) that Proportional Fair achieves' }),
        h('p', { class: 'hint' }, 'Stations can override the scheduler in the station editor. Compare the Fairness and throughput tiles to see the trade-off.'),
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
  store.on('model', render);
  return root;
}

/** Building model options and data status (shown when the Walfisch–Ikegami model is selected). */
function buildingsBlock(app: App, changed: () => void): HTMLElement {
  const r = app.store.scenario.settings.radio;
  const status = h('div', { class: 'status-line' });
  const upd = () => {
    const b = app.buildings();
    status.textContent = b.set ? `${b.set.count} OSM buildings loaded (${b.source}). Paths are traced up to 4 km from each site; beyond that, or outside the data, Hata is used.` : 'No buildings loaded: Hata is used everywhere until you load them.';
  };
  upd();
  app.onLiveTick(upd);
  const btn = button('Load OSM buildings for current view', async () => {
    btn.disabled = true;
    try {
      await app.loadBuildings();
    } finally {
      btn.disabled = false;
      upd();
    }
  });
  return h('div', { class: 'sub-block' },
    h('p', { class: 'hint' }, 'Each site casts rays through OSM building footprints and heights. A direct path not cut by any building is LOS (street-canyon formula); a blocked one adds rooftop-to-street diffraction from the last building’s height and multi-screen diffraction over the buildings crossed. UEs inside a footprint get building entry loss. With buildings modelled explicitly, a smaller shadowing σ (≈ 4 dB) is appropriate.'),
    selectField('Building entry loss', [['traditional', 'Traditional building (ITU-R P.2109)'], ['thermal', 'Thermally efficient (P.2109)'], ['none', 'None']], () => r.buildingEntry, (v) => {
      r.buildingEntry = v;
      changed();
    }),
    numField('Default building height', () => r.defaultBuildingHeightM, (v) => {
      r.defaultBuildingHeightM = v;
      app.mapView.setBuildings(app.buildings().set, v);
      changed();
    }, { min: 2, max: 100, step: 1, unit: 'm', title: 'For OSM buildings without height, levels or a recognised type' }),
    status,
    h('div', { class: 'row' }, btn),
  );
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
        selectField('Layer', [['none', 'Off'], ['rsrp', 'Signal level (RSRP / RxLev)'], ['server', 'Best server'], ['sinr', 'SINR / C/(I+N)'], ['throughput', 'Peak DL throughput'], ['modulation', 'Modulation reached'], ['condition', 'Propagation condition (LOS / NLOS / indoor)']], () => l.heatmap, (v) => {
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
        l.heatmap === 'condition' && store.scenario.settings.radio.model !== 'cost231-wi'
          ? h('div', { class: 'callout' },
              h('p', null, 'This layer needs the building-aware path-loss model: with Hata there are no buildings, so there is no LOS / NLOS / indoor to show.'),
              button('Use building model', () => {
                store.useBuildingModel();
                render();
              }, 'primary'),
            )
          : '',
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
        checkField('Buildings (by height, from zoom 15)', () => l.showBuildings, (v) => {
          l.showBuildings = v;
          app.mapView.renderBuildings();
          render(); // show/hide the height legend
        }, 'OSM footprints coloured by height; dashed outline = height unknown (default used)'),
        l.showBuildings
          ? h('div', { class: 'legend-users' }, ...BUILDING_LEGEND.map(([max, c], i) => h('span', null, h('i', { style: `background:${c};border-radius:2px` }), i === BUILDING_LEGEND.length - 1 ? `≥ ${BUILDING_LEGEND[i - 1][0]} m` : `< ${max} m`)))
          : '',
        h('div', { class: 'legend-users' },
          h('span', null, h('i', { style: 'background:#9e9e9e' }), 'idle'),
          h('span', null, h('i', { style: 'background:#1565c0' }), 'voice'),
          h('span', null, h('i', { style: 'background:#2e7d32' }), 'data'),
          h('span', null, h('i', { style: 'background:#000' }), 'no service'),
          h('span', null, h('i', { style: 'background:#fff;border:2px solid #222' }), 'vehicle'),
          h('span', null, h('i', { style: 'background:#fff;border:2px solid #f2b705' }), 'static'),
          h('span', null, h('i', { style: 'background:#fff;border:2px solid #2a78d6' }), 'selected in Users list'),
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
