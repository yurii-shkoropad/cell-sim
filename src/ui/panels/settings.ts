import { SCHEDULERS, schedulerInfo } from '../../sim/scheduler';
import { BUILDING_LEGEND } from '../../map/mapView';
import { RSRP_PALETTES } from '../../map/colors';
import { saveViewPrefs, SECTOR_PALETTES, SITE_BADGES, SITE_NAME_SIZES, USER_LABEL_FIELDS, USER_SIZES } from '../../state/store';
import { TECHS, type CalibratedModel, type CaSettings, type RadioSettings, type Tech, type TechThresholds } from '../../types';
import { CAL_REF_M } from '../../radio/cells';
import { ENV_RADIUS_M } from '../../radio/buildings';
import type { App } from '../app';
import { button, checkField, clear, h, numField, refreshFields, section, selectField, toast } from '../dom';

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
        selectField('Environment', [['auto', 'Auto – from OSM buildings around each site'], ['urban-large', 'Urban – large/metropolitan city'], ['urban-medium', 'Urban – medium/small city'], ['suburban', 'Suburban'], ['rural', 'Rural / open area']], () => r.environment, (v) => {
          r.environment = v;
          set();
          setTimeout(render, 150); // the per-site summary needs the rebuilt radio context
        }, 'Sets the Hata correction terms (and the metropolitan term of Walfisch–Ikegami)'),
        r.environment === 'auto' ? envSummary(app) : '',
        selectField('Path-loss model', [['auto', 'Auto (Hata ≤1500 MHz, COST-231 above)'], ['okumura-hata', 'Okumura-Hata'], ['cost231-hata', 'COST-231 Hata'], ['cost231-wi', 'COST-231 Walfisch–Ikegami + OSM buildings']], () => r.model, (v) => {
          r.model = v;
          set();
          render();
        }),
        h('p', { class: 'hint' }, 'OSM buildings, indoor (entry) loss and planned buildings: see the Buildings tab.'),
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
      calibrationSection(r, set),
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
      caSection(store.scenario.settings.ca, set, render),
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
      section('Defaults',
        h('p', { class: 'hint' }, 'Every setting (this tab, Layers, user generation, Wi-Fi offload) back to its default. The network, users and buildings stay.'),
        h('div', { class: 'row' }, resetSettingsButton(app)),
      ),
    );
  };
  render();
  store.on('scenario', render);
  store.on('model', render);
  return root;
}

/** "Reset all settings" button (Radio tab and Import/Export). */
export function resetSettingsButton(app: App): HTMLElement {
  return button('Reset all settings', () => {
    if (!confirm('Reset every setting to its default? Radio and propagation (incl. calibration), mobility thresholds, simulation, user generation, Wi-Fi offload, carrier aggregation, and the map layers and colours. Stations, users, Wi-Fi APs and buildings are kept.')) return;
    app.store.resetSettings();
    refreshFields();
    app.mapView.renderStations();
    app.mapView.renderSectors();
    toast('All settings reset to defaults.', 'ok');
  }, 'danger');
}

const CAL_LABEL: Record<CalibratedModel, string> = { 'okumura-hata': 'Okumura-Hata', 'cost231-hata': 'COST-231 Hata', 'cost231-wi': 'COST-231 WI (building model)' };

/** Offset / slope per path-loss model, to match the predictions to measured (drive-test) levels. */
function calibrationSection(r: RadioSettings, set: () => void): HTMLElement {
  // The models the current choice actually uses: Auto and the building model fall back to Hata.
  const used: CalibratedModel[] =
    r.model === 'okumura-hata' || r.model === 'cost231-hata' ? [r.model] : r.model === 'cost231-wi' ? ['cost231-wi', 'okumura-hata', 'cost231-hata'] : ['okumura-hata', 'cost231-hata'];
  const rows = used.map((m) => {
    const c = r.calibration[m];
    return h('div', { class: 'cal-row' },
      h('div', { class: 'cal-name' }, CAL_LABEL[m], m !== 'cost231-wi' && r.model === 'cost231-wi' ? h('span', { class: 'muted' }, ' · fallback') : '', m !== 'cost231-wi' && r.model === 'auto' ? h('span', { class: 'muted' }, m === 'okumura-hata' ? ' · ≤1500 MHz' : ' · >1500 MHz') : ''),
      numField('Offset', () => c.offsetDb, (v) => {
        c.offsetDb = v;
        set();
      }, { min: -30, max: 40, step: 0.5, unit: 'dB', title: 'Extra loss at every distance. +6 dB makes every predicted level 6 dB weaker.' }),
      numField('Slope', () => c.slopeDb, (v) => {
        c.slopeDb = v;
        set();
      }, { min: -20, max: 30, step: 0.5, unit: 'dB/dec', title: `Extra loss per decade of distance beyond ${CAL_REF_M} m: +5 dB/dec adds 5 dB at ${CAL_REF_M * 10} m and 10 dB at ${CAL_REF_M * 100} m.` }),
    );
  });
  return section('Model calibration',
    h('p', { class: 'hint' }, `Tune the model to your measurements: extra loss = offset + slope · log₁₀(d / ${CAL_REF_M} m) beyond ${CAL_REF_M} m, offset only closer. Positive values give weaker signal. Compare the RSRP heatmap with the measured levels and raise the offset until the mean error is about 0; if far points are still too strong, add slope.`),
    ...rows,
    h('div', { class: 'row' }, button('Reset calibration', () => {
      for (const m of used) Object.assign(r.calibration[m], { offsetDb: 0, slopeDb: 0 });
      set();
      refreshFields();
    })),
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

/** Environment = Auto: how many sites fell in each class, and the rule. */
function envSummary(app: App): HTMLElement {
  const el = h('p', { class: 'hint' });
  const upd = () => {
    const per = new Map<string, { env: string; est: boolean }>();
    for (const c of app.ctx().cells) per.set(`${c.x.toFixed(0)}|${c.y.toFixed(0)}`, { env: c.environment, est: !!c.envEstimate });
    const n = new Map<string, number>();
    let noData = 0;
    for (const v of per.values()) {
      n.set(v.env, (n.get(v.env) ?? 0) + 1);
      if (!v.est) noData++;
    }
    const label: Record<string, string> = { 'urban-large': 'large city', 'urban-medium': 'medium city', suburban: 'suburban', rural: 'rural' };
    const parts = ['urban-large', 'urban-medium', 'suburban', 'rural'].filter((k) => n.get(k)).map((k) => `${n.get(k)} ${label[k]}`);
    el.textContent = `${per.size} sites: ${parts.join(', ') || '—'}${noData ? ` (${noData} without building data → medium city)` : ''}. From the buildings within ${ENV_RADIUS_M} m: ≥ 30 % built-up and ≥ 20 m high = large city, ≥ 18 % = medium city, ≥ 6 % = suburban, else rural. Each station shows its own in Configure.`;
  };
  upd();
  app.onLiveTick(upd);
  return el;
}

/** Carrier aggregation: SCells on other carriers of the same site for LTE/NR data sessions. */
function caSection(ca: CaSettings, set: () => void, render: () => void): HTMLElement {
  return section('Carrier aggregation (LTE / NR)',
    checkField('Carrier aggregation', () => ca.enabled, (v) => {
      ca.enabled = v;
      set();
      render();
    }, 'Data sessions also use secondary cells (SCells) on other carriers of the same RAT and operator'),
    ca.enabled
      ? h('div', null,
          selectField('Max component carriers', ['2', '3', '4', '5'].map((n) => [n, `${n} CC (PCell + ${+n - 1} SCell${+n > 2 ? 's' : ''})`] as [string, string]), () => String(ca.maxCc), (v) => {
            ca.maxCc = +v;
            set();
          }, 'Carriers a phone can aggregate (UE category / band combination)'),
          numField('SCell add threshold', () => ca.scellMinDbm, (v) => {
            ca.scellMinDbm = v;
            set();
          }, { min: -140, max: -60, step: 1, unit: 'dBm', title: 'RSRP needed to configure an SCell (A4-like); it is released 3 dB lower' }),
          checkField('Same site only', () => ca.coSitedOnly, (v) => {
            ca.coSitedOnly = v;
            set();
          }, 'Intra-eNB/gNB CA: SCells must be on the PCell’s site (within 50 m). Off: any cell of the operator (inter-site CA)'),
        )
      : '',
    h('p', { class: 'hint' }, 'Voice stays on the PCell. A data session’s demand is shared over the carriers in proportion to their rate, and moved to a carrier with room when one is congested. Add carriers to a site with Configure → “Add carrier on this site”.'),
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
          render(); // layer-specific options
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
        l.heatmap === 'rsrp'
          ? h('div', null,
              selectField('RSRP colours', RSRP_PALETTES, () => l.rsrpPalette, (v) => {
                l.rsrpPalette = v;
                saveViewPrefs(l);
                changed(false);
              }, 'Drive test: the same classes and colours as the students’ QGIS “RSRP main zone” layer. GSM RxLev keeps its own scale.'),
              checkField('Smooth gradient', () => l.rsrpSmooth, (v) => {
                l.rsrpSmooth = v;
                saveViewPrefs(l);
                changed(false);
              }, 'Off: flat colour classes (as in QGIS). On: colours blend continuously between the classes.'),
            )
          : '',
        l.heatmap === 'condition' && store.scenario.settings.radio.model !== 'cost231-wi' && !app.ctx().indoor
          ? h('div', { class: 'callout' },
              h('p', null, 'No building footprints are loaded, so Hata cannot tell indoor from outdoor; LOS / NLOS needs the building-aware model.'),
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
        checkField('Show values on mouse hover', () => l.showReadout, (v) => {
          l.showReadout = v;
          saveViewPrefs(l);
        }, 'The box with level, SINR, serving cell and peak rate under the mouse'),
        h('p', { class: 'hint' }, 'Signal level is the best cell of the selected operator/RAT. SINR counts interference from every cell on overlapping spectrum (all operators). Hover over the map to read values.'),
      ),
      section('Overlays',
        checkField('Sectors', () => l.showSectors, (v) => {
          l.showSectors = v;
          app.mapView.renderSectors();
        }),
        selectField('Site marker shows', SITE_BADGES, () => l.siteBadge, (v) => {
          l.siteBadge = v;
          saveViewPrefs(l);
          app.mapView.renderStations();
        }, 'A site groups the co-located stations (bands / RATs) of one operator'),
        checkField('Site names (from zoom 14)', () => l.showSiteNames, (v) => {
          l.showSiteNames = v;
          saveViewPrefs(l);
          app.mapView.renderStations();
        }, 'Name under each site marker'),
        selectField('Site name size', SITE_NAME_SIZES, () => String(l.siteNameSize), (v) => {
          l.siteNameSize = +v;
          saveViewPrefs(l);
          app.mapView.renderStations();
          app.mapView.renderSectors(); // PCI labels keep clear of the names
        }),
        checkField('PCI labels (from zoom 16)', () => l.showPci, (v) => {
          l.showPci = v;
          saveViewPrefs(l);
          app.mapView.renderSectors();
        }, 'PCI (BSIC for GSM) at each sector tip; co-located carriers pointing the same way share one label. Follows the operator / technology filter above.'),
        selectField('Sector colours', SECTOR_PALETTES, () => l.sectorPalette, (v) => {
          l.sectorPalette = v;
          saveViewPrefs(l);
          app.mapView.renderSectors();
          store.emit('selection'); // the open station editor re-colours its sector dots
        }, 'By sector: click a sector’s dot in Configure → Sectors to swap colours between the sectors of a station. Best-server heatmap: sectors always use the cell colours of the heatmap.'),
        checkField('Users', () => l.showUsers, (v) => {
          l.showUsers = v;
          app.mapView.renderUsers(app.engine);
        }),
        selectField('User marker size', USER_SIZES, () => String(l.userSize), (v) => {
          l.userSize = +v;
          saveViewPrefs(l);
          app.mapView.renderUsers(app.engine);
        }),
        h('div', { class: 'field', title: 'Label next to each user, framed in its serving cell’s colour' },
          h('span', { class: 'lbl' }, 'User labels (from zoom 15)'),
          h('span', { class: 'ctl label-fields' }, ...USER_LABEL_FIELDS.map(([k, label, title]) => {
            const cb = h('input', { type: 'checkbox', checked: l.userLabel[k], onchange: () => {
              l.userLabel[k] = cb.checked;
              saveViewPrefs(l);
              app.mapView.renderUsers(app.engine);
            } });
            return h('label', { title }, cb, label);
          })),
        ),
        checkField('Wi-Fi APs and association range', () => l.showWifi, (v) => {
          l.showWifi = v;
          app.mapView.renderWifi();
        }, 'Dashed circle: where the median RSSI equals the Wi-Fi min RSSI'),
        checkField('Links: active user → serving cell / Wi-Fi AP', () => l.showLinks, (v) => {
          l.showLinks = v;
          app.mapView.renderUsers(app.engine);
        }, 'Solid: serving cell (PCell). Dashed, in the cell\'s colour and shifted aside: carrier-aggregation secondary cells (SCells). The user open in the inspector always shows its links.'),
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
          h('span', null, h('i', { style: 'background:#7b5cd6' }), 'over Wi-Fi'),
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
