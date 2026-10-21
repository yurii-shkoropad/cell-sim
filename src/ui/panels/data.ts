import { exportScenario, importOpenCellId, importOsmTowers, parseScenario, type ImportResult } from '../../io/importers';
import { autoAssignGsm, autoAssignPci, checkPlan, type PlanIssue } from '../../planning/check';
import { PRESETS, presetByKey } from '../../radio/presets';
import { defaultScenario } from '../../state/defaults';
import { clearSaved } from '../../state/store';
import type { Tech } from '../../types';
import type { App } from '../app';
import { button, clear, h, numField, section, selectField, textField, toast } from '../dom';

function bounds(app: App) {
  const b = app.mapView.map.getBounds();
  return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
}

function applyImport(app: App, r: ImportResult, source: string) {
  const { store } = app;
  store.scenario.operators.push(...r.newOperators);
  store.addStations(r.stations);
  const skipped = Object.entries(r.skipped).map(([k, v]) => `${v} ${k}`).join(', ');
  toast(`${source}: imported ${r.stations.length} sites${r.newOperators.length ? `, ${r.newOperators.length} new operators` : ''}${skipped ? ` (skipped: ${skipped})` : ''}`, r.stations.length ? 'ok' : 'info');
  if (r.newOperators.length) store.emit('scenario');
}

export function dataPanel(app: App): HTMLElement {
  const { store } = app;
  const root = h('div', { class: 'panel' });
  const presetsFor = (t: Tech) => PRESETS.filter((p) => p.tech === t).map((p) => [p.key, p.label] as [string, string]);
  const opt = { gsm: 'gsm900', lte: 'lte1800', nr: 'nr3500', osm: 'lte1800', osmOp: store.scenario.operators[0]?.id ?? '' };

  const csvInput = h('input', { type: 'file', accept: '.csv,.txt,text/csv', onchange: async () => {
    const f = csvInput.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const r = importOpenCellId(text, store.scenario, bounds(app), { GSM: presetByKey(opt.gsm), LTE: presetByKey(opt.lte), NR: presetByKey(opt.nr) });
      applyImport(app, r, 'OpenCelliD');
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`, 'error');
    }
    csvInput.value = '';
  } });

  const osmBtn = button('Import towers in current view', async () => {
    osmBtn.disabled = true;
    osmBtn.textContent = 'Querying Overpass…';
    try {
      const r = await importOsmTowers(store.scenario, bounds(app), presetByKey(opt.osm), opt.osmOp);
      applyImport(app, r, 'OSM');
    } catch (e) {
      toast(`Overpass request failed: ${(e as Error).message}`, 'error');
    } finally {
      osmBtn.disabled = false;
      osmBtn.textContent = 'Import towers in current view';
    }
  });

  const jsonInput = h('input', { type: 'file', accept: '.json,application/json', onchange: async () => {
    const f = jsonInput.files?.[0];
    if (!f) return;
    try {
      store.replaceScenario(parseScenario(await f.text()));
      const c = store.scenario.center;
      app.mapView.map.setView([c.lat, c.lng], c.zoom);
      app.respawnUsers();
      toast(`Loaded scenario “${store.scenario.name}”`, 'ok');
    } catch (e) {
      toast(`Could not load scenario: ${(e as Error).message}`, 'error');
    }
    jsonInput.value = '';
  } });

  root.append(
    section('Scenario file',
      textField('Name', () => store.scenario.name, (v) => (store.scenario.name = v)),
      h('div', { class: 'row' },
        button('Export JSON', () => {
          store.scenario.center = { ...store.scenario.center, zoom: app.mapView.map.getZoom() };
          exportScenario(store.scenario);
        }, 'primary'),
        h('label', { class: 'btn file' }, 'Import JSON…', jsonInput),
      ),
      h('div', { class: 'row' },
        button('Reset to demo scenario', () => {
          if (!confirm('Replace the current scenario with the Lviv Polytechnic demo?')) return;
          clearSaved();
          store.replaceScenario(defaultScenario());
          const c = store.scenario.center;
          app.mapView.map.setView([c.lat, c.lng], c.zoom);
          app.respawnUsers();
        }, 'danger'),
        button('Clear all stations', () => {
          if (!confirm('Remove all stations?')) return;
          store.scenario.stations = [];
          store.select(null);
          store.emit('network');
        }, 'danger'),
      ),
      h('p', { class: 'hint' }, 'The scenario is also saved automatically in this browser.'),
    ),
    section('OpenCelliD CSV',
      h('p', { class: 'hint' }, 'Cells inside the current map view are imported from an OpenCelliD export (radio,mcc,net,area,cell,unit,lon,lat,…). LTE cells are grouped into sites by eNB ID, NR by gNB ID, and GSM by proximity. Sector azimuths point towards each cell’s estimated position. Operators are matched by PLMN. UMTS/CDMA cells are skipped. Radio parameters come from the templates below.'),
      selectField('GSM template', presetsFor('GSM'), () => opt.gsm, (v) => (opt.gsm = v)),
      selectField('LTE template', presetsFor('LTE'), () => opt.lte, (v) => (opt.lte = v)),
      selectField('NR template', presetsFor('NR'), () => opt.nr, (v) => (opt.nr = v)),
      h('div', { class: 'row' }, h('label', { class: 'btn file primary' }, 'Choose CSV…', csvInput)),
    ),
    section('OpenStreetMap towers',
      h('p', { class: 'hint' }, 'Imports masts and towers tagged for communication or mobile phone service in the current view. OSM rarely records radio parameters, so the template below is applied, and the operator is taken from the operator tag when it exists.'),
      selectField('Template', PRESETS.map((p) => [p.key, p.label] as [string, string]), () => opt.osm, (v) => (opt.osm = v)),
      selectField('Fallback operator', store.scenario.operators.map((o) => [o.id, o.name] as [string, string]), () => opt.osmOp, (v) => (opt.osmOp = v)),
      h('div', { class: 'row' }, osmBtn),
    ),
  );
  return root;
}

export function planningPanel(app: App): HTMLElement {
  const { store } = app;
  const root = h('div', { class: 'panel' });
  const list = h('div', { class: 'issues' });
  const opt = { op: 'all', gsmFirst: 947.4, gsmCount: 12 };
  let filter: 'all' | 'error' | 'warning' | 'info' = 'all';

  const run = () => {
    clear(list);
    const issues = checkPlan(store.scenario);
    const counts = { error: 0, warning: 0, info: 0 };
    issues.forEach((i) => counts[i.severity]++);
    list.appendChild(h('div', { class: 'issue-summary' }, `${counts.error} errors · ${counts.warning} warnings · ${counts.info} notes`));
    const shown = issues.filter((i) => filter === 'all' || i.severity === filter);
    if (!shown.length) list.appendChild(h('p', { class: 'hint' }, issues.length ? 'Nothing at this severity.' : 'No issues found.'));
    for (const i of shown.slice(0, 300)) list.appendChild(issueRow(app, i));
    if (shown.length > 300) list.appendChild(h('p', { class: 'hint' }, `…and ${shown.length - 300} more`));
  };

  const render = () => {
    clear(root);
    root.append(
    section('Plan check',
      h('p', { class: 'hint' }, 'Checks PCI collisions, confusion and mod-3 conflicts; GSM co-channel and adjacent-channel BCCH reuse; spectrum overlap between operators; parameter ranges; and Hata model validity. Cells count as neighbours within the neighbour radius (Radio → Simulation).'),
      selectField('Show', [['all', 'All'], ['error', 'Errors'], ['warning', 'Warnings'], ['info', 'Notes']], () => filter, (v) => {
        filter = v;
        run();
      }),
      h('div', { class: 'row' }, button('Run check', run, 'primary')),
      list,
    ),
    section('Auto-assign',
      selectField('Operator', [['all', 'All operators'], ...store.scenario.operators.map((o) => [o.id, o.name] as [string, string])], () => opt.op, (v) => (opt.op = v)),
      h('div', { class: 'row' }, button('Auto PCI (LTE/NR)', () => {
        const n = autoAssignPci(store.scenario, opt.op);
        store.emit('network');
        toast(`PCI plan updated: ${n} sectors changed`, 'ok');
        run();
      })),
      numField('GSM first BCCH', () => opt.gsmFirst, (v) => (opt.gsmFirst = v), { step: 0.2, unit: 'MHz' }),
      numField('GSM channels', () => opt.gsmCount, (v) => (opt.gsmCount = Math.round(v)), { min: 3, max: 60, step: 1 }),
      h('div', { class: 'row' }, button('Auto GSM BCCH plan', () => {
        const n = autoAssignGsm(store.scenario, opt.op, opt.gsmFirst, opt.gsmCount);
        store.emit('network');
        toast(`Frequency plan updated: ${n} sectors changed`, 'ok');
        run();
      })),
    ),
    );
  };
  render();
  store.on('scenario', render);
  return root;
}

function issueRow(app: App, i: PlanIssue): HTMLElement {
  return h('div', { class: `issue ${i.severity}`, onclick: () => {
    const id = i.stationIds[0];
    if (!id) return;
    app.store.select(id);
    app.mapView.focusStation(id);
  } },
    h('span', { class: 'sev' }, i.severity === 'error' ? '●' : i.severity === 'warning' ? '▲' : 'i'),
    h('span', { class: 'kind' }, i.kind),
    h('span', { class: 'msg' }, i.message),
  );
}
