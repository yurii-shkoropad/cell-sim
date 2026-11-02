import { hexGrid, randomSites } from '../../planning/patterns';
import { cellColor } from '../../radio/cells';
import { makeStation, newId, PRESETS, presetByKey } from '../../radio/presets';
import { carrierLabel, sitesOf, siteRats } from '../../state/sites';
import type { BaseStation } from '../../types';
import type { App } from '../app';
import { button, clear, colorField, h, numField, section, selectField, textField, toast } from '../dom';

export function networkPanel(app: App): HTMLElement {
  const { store } = app;
  const root = h('div', { class: 'panel' });
  const listHost = h('div');
  const opsHost = h('div');

  // ---------------------------------------------------------------- add / generate
  const gen = { preset: 'lte1800', operatorId: store.scenario.operators[0]?.id ?? '', sectors: 3, rings: 1, isd: 800, azOff: 0, count: 10 };
  const opOptions = () => store.scenario.operators.map((o) => [o.id, o.name] as [string, string]);
  const presetOptions = PRESETS.map((p) => [p.key, p.label] as [string, string]);

  const addBtn = button('Add sites on map', () => app.mapView.setPlaceMode(app.mapView.placeMode === 'site' ? null : 'site'), 'primary', 'Click the map to place sites and drag existing ones; Esc or Done to finish');
  app.mapView.onPlaceModeChange(() => {
    const on = app.mapView.placeMode === 'site';
    addBtn.classList.toggle('active', on);
    addBtn.textContent = on ? 'Done adding' : 'Add sites on map';
  });
  app.mapView.placeHint.site = () => {
    const op = store.scenario.operators.find((o) => o.id === gen.operatorId)?.name ?? '?';
    const sec = gen.sectors === 1 ? 'omni' : `${gen.sectors} sectors`;
    return `Adding ${presetByKey(gen.preset).label} · ${op} · ${sec}`;
  };
  const hintChanged = () => app.mapView.refreshBanner();

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
    opSelHost.appendChild(selectField('Operator', opOptions(), () => gen.operatorId, (v) => {
      gen.operatorId = v;
      hintChanged();
    }));
  };
  renderOpSelect();

  root.appendChild(
    section(
      'Add sites',
      selectField('Template', presetOptions, () => gen.preset, (v) => {
        gen.preset = v;
        hintChanged();
      }),
      opSelHost,
      selectField('Sectors', [['1', 'Omni'], ['3', '3 sectors'], ['6', '6 sectors']], () => String(gen.sectors) as '1' | '3' | '6', (v) => {
        gen.sectors = +v;
        hintChanged();
      }),
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
    const match = (st: BaseStation) => !q || st.name.toLowerCase().includes(q) || st.band.toLowerCase().includes(q) || st.tech.toLowerCase().includes(q) || (ops.get(st.operatorId)?.name.toLowerCase().includes(q) ?? false);
    // One row per site (co-located stations of an operator); its carriers unfold under the open site.
    const sites = sitesOf(store.scenario.stations).filter((site) => (q && site.name.toLowerCase().includes(q)) || site.stations.some(match));
    const items = sites.flatMap((site) => site.stations);
    const search = h('input', { type: 'search', placeholder: 'Filter by name, tech, band, operator', value: filter, oninput: () => {
      filter = search.value;
      renderList();
      const el = listHost.querySelector('input[type=search]') as HTMLInputElement;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    } });
    const open = (id: string) => {
      app.mapView.setPlaceMode(null); // picking an existing site ends placement
      store.select(id);
      app.mapView.focusStation(id);
    };
    listHost.appendChild(
      section(
        `Sites (${sitesOf(store.scenario.stations).length}) · ${store.scenario.stations.length} stations`,
        search,
        h('div', { class: 'st-list' },
          ...sites.flatMap((site) => {
            const isOpen = site.stations.some((b) => b.id === store.selectedStationId);
            const rats = siteRats(site).map(([t, n]) => `${t}${n > 1 ? ` ×${n}` : ''}`).join(' + ');
            const bands = [...new Set(site.stations.map((b) => b.band.replace(/ \(assumed\)$/, '')))].join(', ');
            const row = h('div', { class: `st-item ${isOpen ? 'sel' : ''} ${site.stations.every((b) => !b.enabled) ? 'off' : ''}`, title: bands, onclick: () => open(isOpen ? store.selectedStationId! : site.stations[0].id) },
              h('span', { class: 'dot', style: `background:${ops.get(site.operatorId)?.color ?? '#888'}` }),
              h('span', { class: 'nm' }, site.name),
              h('span', { class: 'meta' }, site.stations.length > 1 ? `${rats} · ${site.stations.length} carriers` : `${site.stations[0].tech} ${site.stations[0].band} · ${site.stations[0].sectors.length}×`),
            );
            if (!isOpen || site.stations.length < 2) return [row];
            return [row, ...site.stations.map((b) => h('div', { class: `st-item sub ${b.id === store.selectedStationId ? 'sel' : ''} ${b.enabled ? '' : 'off'}`, onclick: () => open(b.id) },
              h('span', { class: 'nm' }, carrierLabel(b, site.name)),
              h('span', { class: 'meta' }, `${b.tech} ${b.band} · ${b.sectors.length}×`),
            ))];
          }),
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

  store.on('selection', () => renderList());
  store.on('network', () => renderList());
  store.on('scenario', () => {
    renderOperators();
    renderOpSelect();
  });
  renderOperators();
  renderList();
  return root;
}
