import { BUILDING_LEGEND } from '../../map/mapView';
import { newId } from '../../radio/presets';
import type { PathLossModel } from '../../types';
import type { App } from '../app';
import { button, checkField, clear, h, numField, section, selectField } from '../dom';

/** Height given to the next drawn building, m (kept while the page is open). */
let newBuildingHeightM = 30;

/**
 * Everything about buildings: which path-loss model uses them, the OSM footprints, indoor
 * (entry) loss, and planned buildings drawn by the user to forecast future coverage.
 */
export function buildingsPanel(app: App): HTMLElement {
  const { store, mapView } = app;
  const root = h('div', { class: 'panel' });
  const set = () => store.emit('settings');
  /** Refreshes the building status line (buildings load in the background). */
  let updStatus = () => {};

  const render = () => {
    clear(root);
    const r = store.scenario.settings.radio;
    const l = store.layers;
    const wi = r.model === 'cost231-wi';

    const status = h('div', { class: 'status-line' });
    const upd = () => {
      const b = app.buildings();
      status.textContent = !b.set
        ? 'No buildings loaded: every point is outdoor and Hata is used everywhere.'
        : wi
          ? `${b.set.count} buildings (${b.source}). Paths are traced up to 4 km from each site; beyond that, or outside the data, Hata is used.`
          : `${b.set.count} buildings (${b.source}): with Hata they only decide indoor / outdoor.`;
    };
    upd();
    updStatus = upd;
    const loadBtn = button('Load OSM buildings for current view', async () => {
      loadBtn.disabled = true;
      try {
        await app.loadBuildings();
      } finally {
        loadBtn.disabled = false;
        upd();
      }
    });

    root.append(
      section('Propagation through buildings',
        selectField('Path-loss model', [['auto', 'Auto (Hata ≤1500 MHz, COST-231 above)'], ['okumura-hata', 'Okumura-Hata'], ['cost231-hata', 'COST-231 Hata'], ['cost231-wi', 'COST-231 Walfisch–Ikegami + OSM buildings']] as [PathLossModel, string][], () => r.model, (v) => {
          r.model = v;
          set();
          store.emit('model'); // the Radio tab shows the same choice
          render();
        }),
        h('p', { class: 'hint' }, wi
          ? 'Each site casts rays through the building footprints and heights. A direct path not cut by any building is LOS (street-canyon formula); a blocked one adds rooftop-to-street and multi-screen diffraction from the actual roof heights. UEs inside a footprint get the entry loss. With buildings modelled explicitly, a smaller shadowing σ (≈ 4 dB, Radio tab) is appropriate.'
          : 'Hata ignores building geometry: buildings only decide whether a point is indoor (entry loss added). Choose Walfisch–Ikegami to see LOS / NLOS and the shadow of each building.'),
      ),
      section('OSM buildings',
        status,
        h('div', { class: 'row' }, loadBtn),
        numField('Default building height', () => r.defaultBuildingHeightM, (v) => {
          r.defaultBuildingHeightM = v;
          mapView.setBuildings(app.buildings().set, v);
          set();
        }, { min: 2, max: 100, step: 1, unit: 'm', title: 'For OSM buildings without height, levels or a recognised type' }),
        checkField('Show buildings on the map (by height, from zoom 15)', () => l.showBuildings, (v) => {
          l.showBuildings = v;
          mapView.renderBuildings();
          store.emit('layers');
          render();
        }, 'Footprints coloured by height; dashed outline = height unknown (default used)'),
        l.showBuildings
          ? h('div', { class: 'legend-users' }, ...BUILDING_LEGEND.map(([max, c], i) => h('span', null, h('i', { style: `background:${c};border-radius:2px` }), i === BUILDING_LEGEND.length - 1 ? `≥ ${BUILDING_LEGEND[i - 1][0]} m` : `< ${max} m`)))
          : '',
      ),
      section('Indoor loss',
        selectField('Building entry loss', [['traditional', 'Traditional building (ITU-R P.2109)'], ['thermal', 'Thermally efficient (P.2109)'], ['none', 'None (all outdoor)']], () => r.buildingEntry, (v) => {
          r.buildingEntry = v;
          set();
        }),
        h('p', { class: 'hint' }, 'Added at each cell’s frequency for UEs and heatmap points inside a footprint, with every path-loss model.'),
      ),
      plannedSection(app, render),
    );
  };

  render();
  app.onLiveTick(() => updStatus());
  store.on('scenario', render);
  store.on('model', render);
  // Drawing a planned building starts / ends on the map too (Done, Enter, Esc): refresh its button.
  let drawing = false;
  mapView.onPlaceModeChange(() => {
    const now = mapView.placeMode === 'building';
    if (now !== drawing) render();
    drawing = now;
  });
  return root;
}

/**
 * Planned (future) buildings drawn on the map: they join the OSM buildings in the
 * propagation model, so coverage can be forecast before and after they are built.
 */
function plannedSection(app: App, render: () => void): HTMLElement {
  const { store, mapView } = app;
  const list = (store.scenario.plannedBuildings ??= []);
  const wi = store.scenario.settings.radio.model === 'cost231-wi';
  mapView.onAddBuilding = (ring) => {
    const n = (store.scenario.plannedBuildings ??= []).length + 1;
    store.scenario.plannedBuildings.push({ id: newId('pb'), name: `Planned ${n}`, heightM: newBuildingHeightM, ring, enabled: true });
    app.plannedBuildingsChanged();
    render();
  };
  const drawing = mapView.placeMode === 'building';
  const drawBtn = button(drawing ? 'Finish drawing' : 'Draw building on map', () => {
    mapView.setPlaceMode(drawing ? null : 'building');
    render();
  }, drawing ? '' : 'primary', 'Click the corners on the map; click the first corner, Enter or Done to finish');
  const changed = () => app.plannedBuildingsChanged();
  const rows = list.map((b) => {
    const name = h('input', { type: 'text', value: b.name, onchange: () => {
      b.name = name.value.trim() || b.name;
      changed();
    } });
    const height = h('input', { type: 'number', min: '1', max: '500', step: '1', value: String(b.heightM), title: 'Height above ground, m', onchange: () => {
      const v = parseFloat(height.value);
      if (Number.isFinite(v) && v > 0) b.heightM = Math.min(500, v);
      height.value = String(b.heightM);
      changed();
    } });
    const on = h('input', { type: 'checkbox', checked: b.enabled, title: 'Built: included in propagation. Off: not built yet (compare before / after)', onchange: () => {
      b.enabled = on.checked;
      changed();
    } });
    return h('div', { class: 'pb-row' },
      on,
      name,
      h('span', { class: 'pb-h' }, height, 'm'),
      button('⌖', () => mapView.map.fitBounds(b.ring, { maxZoom: 18, padding: [40, 40] }), 'icon', 'Show on the map'),
      button('×', () => {
        store.scenario.plannedBuildings = list.filter((x) => x !== b);
        changed();
        render();
      }, 'icon', 'Delete this building'),
    );
  });
  return section('Planned buildings',
    h('p', { class: 'hint' }, 'Draw a future building and set its height: with the Walfisch–Ikegami model sites trace their paths through it like any OSM building (shadow behind it, indoor loss inside). Untick it to see coverage before it is built.'),
    !wi && list.some((b) => b.enabled)
      ? h('div', { class: 'callout' },
          h('p', null, 'The Hata model in use ignores building geometry: these buildings only add indoor loss inside their footprint and cast no shadow. Switch to the building model to forecast their effect.'),
          button('Use building model', () => {
            store.useBuildingModel();
            render();
          }, 'primary'),
        )
      : '',
    numField('Height of new buildings', () => newBuildingHeightM, (v) => (newBuildingHeightM = Math.max(1, v)), { min: 1, max: 500, step: 1, unit: 'm' }),
    h('div', { class: 'row' }, drawBtn),
    ...rows,
    list.length ? h('p', { class: 'hint' }, 'Saved with the scenario (Export / Import). Tick = built, untick = not built yet.') : '',
  );
}
