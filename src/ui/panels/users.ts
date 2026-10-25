import { generateUsers, templateFromSettings, type UserTemplate, type Zone } from '../../sim/population';
import type { SimUser } from '../../sim/engine';
import { TECHS, type Mobility, type TrafficMode, type UserSpec } from '../../types';
import type { App } from '../app';
import { button, clear, fmt, h, numField, section, selectEl, selectField, toast } from '../dom';

const MAX_ROWS = 300;
const MOBILITY: [Mobility, string][] = [['static', 'Static'], ['walk', 'Pedestrian'], ['drive', 'Vehicle']];
const TRAFFIC: [TrafficMode, string][] = [['random', 'Random (Poisson)'], ['data', 'Continuous data'], ['voice', 'Continuous voice'], ['idle', 'Idle']];
const MOB_SHORT: Record<Mobility, string> = { static: 'static', walk: 'walk', drive: 'drive' };
const TRF_SHORT: Record<TrafficMode, string> = { random: 'random', data: 'cont. data', voice: 'cont. voice', idle: 'idle' };
type State = 'all' | 'active' | 'data' | 'voice' | 'idle' | 'none';

const stateOf = (u: SimUser | undefined): Exclude<State, 'all' | 'active'> => (!u || u.serving < 0 ? 'none' : u.session ? u.session.kind : 'idle');

export function usersPanel(app: App): HTMLElement {
  const { store, engine, mapView } = app;
  const root = h('div', { class: 'panel' });

  // ---------------------------------------------------------------- list state
  const filter = { q: '', op: 'all', mob: 'all' as Mobility | 'all', state: 'all' as State };
  const selected = new Set<string>();
  const listHost = h('div', { class: 'ul-list' });
  const countEl = h('span', { class: 'ul-count' });
  const batchHost = h('div');
  const selectAll = h('input', { type: 'checkbox', title: 'Select all matching', onchange: () => {
    const ids = matching().map((x) => x.spec.id);
    if (selectAll.checked) ids.forEach((id) => selected.add(id));
    else ids.forEach((id) => selected.delete(id));
    selectionChanged();
  } });

  const specs = () => store.scenario.users ?? [];
  const live = () => {
    const m = new Map<string, SimUser>();
    for (const u of engine.users) if (u.specId) m.set(u.specId, u);
    return m;
  };
  const matching = () => {
    const lv = live();
    const ctx = app.ctx();
    const q = filter.q.trim().toLowerCase();
    return specs()
      .map((spec) => ({ spec, u: lv.get(spec.id) }))
      .filter(({ spec, u }) => {
        if (filter.op !== 'all' && spec.operatorId !== filter.op) return false;
        if (filter.mob !== 'all' && spec.mobility !== filter.mob) return false;
        const st = stateOf(u);
        if (filter.state === 'active' ? st !== 'data' && st !== 'voice' : filter.state !== 'all' && st !== filter.state) return false;
        if (q) {
          const cell = u && u.serving >= 0 ? ctx.cells[u.serving]?.name ?? '' : '';
          if (!spec.name.toLowerCase().includes(q) && !cell.toLowerCase().includes(q)) return false;
        }
        return true;
      });
  };

  const selectionChanged = () => {
    app.setUserSelection(selected);
    renderRows();
    renderBatch();
  };

  // ---------------------------------------------------------------- list rows
  const renderRows = () => {
    const ctx = app.ctx();
    const ops = new Map(store.scenario.operators.map((o) => [o.id, o]));
    const rows = matching();
    // Drop selections of users that no longer exist.
    const ids = new Set(specs().map((s) => s.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    countEl.textContent = `${rows.length} of ${specs().length} users${selected.size ? ` · ${selected.size} selected` : ''}`;
    selectAll.checked = rows.length > 0 && rows.every((r) => selected.has(r.spec.id));
    selectAll.indeterminate = !selectAll.checked && rows.some((r) => selected.has(r.spec.id));
    clear(listHost);
    if (!rows.length) {
      listHost.appendChild(h('div', { class: 'hint', style: 'padding:6px 8px' }, specs().length ? 'No users match the filter.' : 'No users yet: add some below.'));
      return;
    }
    const table = h('table', { class: 'meas ul-table' },
      h('tr', null, h('th', null, ''), h('th', null, 'User'), h('th', null, 'Mob.'), h('th', null, 'State'), h('th', null, 'Cell'), h('th', null, 'Mbps'), h('th', null, '')),
    );
    for (const { spec, u } of rows.slice(0, MAX_ROWS)) {
      const st = stateOf(u);
      const cell = u && u.serving >= 0 ? ctx.cells[u.serving] : null;
      const cb = h('input', { type: 'checkbox', checked: selected.has(spec.id), onchange: () => {
        if (cb.checked) selected.add(spec.id);
        else selected.delete(spec.id);
        selectionChanged();
      } });
      table.appendChild(
        h('tr', { class: `ul-row ${selected.has(spec.id) ? 'sel' : ''}`, onmousedown: (e: MouseEvent) => {
          // The row is rebuilt every second; act on mousedown. Checkbox and × handle themselves.
          if ((e.target as HTMLElement).closest('input,.btn')) return;
          if (!u) return;
          mapView.map.panTo([u.lat, u.lng]);
          app.openUser(u.id);
        } },
          h('td', null, cb),
          h('td', { class: 'ul-name', title: `${spec.name} · ${ops.get(spec.operatorId)?.name ?? '?'} · ${spec.techs.join('/')} · traffic: ${TRF_SHORT[spec.traffic]}` }, h('span', { class: 'dot', style: `background:${ops.get(spec.operatorId)?.color ?? '#888'}` }), ' ', spec.name),
          h('td', { class: 'muted', title: `traffic: ${TRF_SHORT[spec.traffic]}` }, MOB_SHORT[spec.mobility]),
          h('td', null, h('span', { class: `st-dot ${st === 'none' ? 'none' : st}` }), st === 'none' ? 'none' : st),
          h('td', null, cell ? cell.name : '—'),
          h('td', null, u?.session?.kind === 'data' ? fmt(u.thrMbps, 1) : ''),
          h('td', null, button('×', () => app.deleteUsers([spec.id]), 'icon', 'Delete user')),
        ),
      );
    }
    listHost.appendChild(table);
    if (rows.length > MAX_ROWS) listHost.appendChild(h('div', { class: 'hint', style: 'padding:4px 8px' }, `Showing the first ${MAX_ROWS} of ${rows.length}: narrow the filter to see the rest (batch actions apply to the whole selection).`));
  };

  // ---------------------------------------------------------------- batch edit bar
  const renderBatch = () => {
    clear(batchHost);
    if (!selected.size) return;
    const ids = () => [...selected];
    const apply = (patch: Partial<UserSpec>, what: string) => {
      app.editUsers(ids(), patch);
      toast(`${what} for ${selected.size} users`, 'ok');
    };
    const sel = <T extends string>(label: string, opts: [T, string][], on: (v: T) => void) =>
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), h('span', { class: 'ctl' }, selectEl([['' as T, '— keep —'], ...opts], () => '' as T, (v) => v && on(v))));
    const demand = h('input', { type: 'number', min: '0', step: '0.5', placeholder: 'random' });
    batchHost.appendChild(
      h('div', { class: 'callout ul-batch' },
        h('div', { class: 'ul-batch-head' }, h('b', null, `Edit ${selected.size} selected`), button('Clear selection', () => {
          selected.clear();
          selectionChanged();
        }, 'ghost')),
        sel('Operator', store.scenario.operators.map((o) => [o.id, o.name] as [string, string]), (v) => apply({ operatorId: v }, 'Operator set')),
        sel('Mobility', MOBILITY, (v) => apply({ mobility: v }, 'Mobility set')),
        sel('Traffic', TRAFFIC, (v) => apply({ traffic: v }, 'Traffic set')),
        sel('Phone Rx antennas', [['auto', 'Auto (device default)'], ['1', '1'], ['2', '2'], ['4', '4'], ['8', '8']], (v) => apply({ ueRx: v === 'auto' ? null : +v }, 'Rx antennas set')),
        sel('Supports', [['GSM', 'GSM only'], ['GSM,LTE', 'GSM + LTE'], ['GSM,LTE,NR', 'GSM + LTE + NR']], (v) => apply({ techs: v.split(',') as typeof TECHS }, 'Devices set')),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Data demand (Mbps)'), h('span', { class: 'ctl' }, demand, button('Set', () => {
          const v = parseFloat(demand.value);
          apply({ demandMbps: demand.value.trim() === '' || !Number.isFinite(v) ? null : Math.max(0.01, v) }, 'Demand set');
        }))),
        h('div', { class: 'row' },
          button('Start data', () => sessionAll('data'), '', 'Start a data session on every selected user'),
          button('Start voice', () => sessionAll('voice')),
          button('End sessions', () => sessionAll(null)),
          button(`Delete ${selected.size}`, () => {
            if (!confirm(`Delete ${selected.size} users?`)) return;
            app.deleteUsers(ids());
            selected.clear();
            selectionChanged();
          }, 'danger'),
        ),
      ),
    );
  };
  const sessionAll = (kind: 'data' | 'voice' | null) => {
    for (const id of selected) {
      const u = engine.userBySpec(id);
      if (!u) continue;
      if (kind) engine.startSessionNow(u, kind);
      else engine.endSessionNow(u);
    }
    mapView.renderUsers(engine);
    renderRows();
  };

  // ---------------------------------------------------------------- add users
  const tpl: UserTemplate = templateFromSettings(store.scenario);
  let zoneKind: 'view' | 'rect' | 'circle' = 'view';
  const persistTpl = () => {
    const u = store.scenario.settings.users;
    Object.assign(u, { count: tpl.count, operatorFilter: tpl.operator, staticShare: tpl.staticShare, pedestrianShare: tpl.pedestrianShare, nrCapableShare: tpl.nrShare, lteCapableShare: tpl.lteShare });
    store.emit('users');
  };
  const addIn = (zone: Zone, count = tpl.count) => {
    const list = generateUsers(store.scenario, tpl, zone, Math.random, count);
    app.addUsers(list);
    toast(`Added ${list.length} users`, 'ok');
  };
  mapView.onZone = (z) => addIn(z);
  mapView.onAddUser = (lat, lng) => {
    const [spec] = generateUsers(store.scenario, tpl, { kind: 'circle', lat, lng, radiusM: 0 }, Math.random, 1);
    spec.lat = lat;
    spec.lng = lng;
    app.addUsers([spec]);
  };
  const MOB_LABEL: Record<Mobility, string> = { static: 'static', walk: 'pedestrian', drive: 'vehicle' };
  mapView.placeHint.user = () => {
    const op = tpl.operator === 'all' ? 'operators by share' : store.scenario.operators.find((o) => o.id === tpl.operator)?.name ?? '?';
    const mix = tpl.staticShare >= 1 ? MOB_LABEL.static : tpl.staticShare <= 0 && tpl.pedestrianShare >= 1 ? MOB_LABEL.walk : 'mixed mobility';
    return `Adding users · ${op} · ${mix} · ${TRF_SHORT[tpl.traffic]}`;
  };
  const placeBtn = button('Click map to place', () => mapView.setPlaceMode(mapView.placeMode === 'user' ? null : 'user'), '', 'Each click adds one user with this template; Esc or Done to finish');
  mapView.onPlaceModeChange(() => {
    const on = mapView.placeMode === 'user';
    placeBtn.classList.toggle('active', on);
    placeBtn.textContent = on ? 'Done placing' : 'Click map to place';
  });

  const addSection = () => {
    const pct = { min: 0, max: 100, scale: 100, unit: '%' } as const;
    const radius = numField('Circle radius', () => mapView.zoneRadiusM, (v) => (mapView.zoneRadiusM = v), { min: 20, max: 5000, step: 50, unit: 'm' });
    radius.style.display = zoneKind === 'circle' ? '' : 'none';
    const addBtn = button(`Add ${tpl.count} users`, () => {
      if (zoneKind === 'view') {
        const b = mapView.map.getBounds();
        addIn({ kind: 'rect', south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
      } else mapView.setPlaceMode(zoneKind === 'rect' ? 'zone-rect' : 'zone-circle');
    }, 'primary');
    const count = numField('How many', () => tpl.count, (v) => {
      tpl.count = Math.round(v);
      addBtn.textContent = `Add ${tpl.count} users`;
      persistTpl();
    }, { min: 1, max: 5000, step: 10 });
    return section('Add users',
      h('p', { class: 'hint' }, 'New users use this template. Moving users snap to the nearest road; static users stay exactly where they are placed.'),
      selectField('Operator', [['all', 'All operators (by market share)'], ...store.scenario.operators.map((o) => [o.id, `Only ${o.name}`] as [string, string])], () => (store.scenario.operators.some((o) => o.id === tpl.operator) ? tpl.operator : 'all'), (v) => {
        tpl.operator = v;
        persistTpl();
        mapView.refreshBanner();
      }),
      numField('Static', () => tpl.staticShare, (v) => {
        tpl.staticShare = v;
        persistTpl();
      }, { ...pct, title: 'Share that never moves (indoor / stationary)' }),
      numField('Pedestrians (of moving)', () => tpl.pedestrianShare, (v) => {
        tpl.pedestrianShare = v;
        persistTpl();
      }, pct),
      numField('LTE-capable', () => tpl.lteShare, (v) => {
        tpl.lteShare = v;
        persistTpl();
      }, pct),
      numField('NR-capable', () => tpl.nrShare, (v) => {
        tpl.nrShare = v;
        persistTpl();
      }, { ...pct, title: 'NR-capable devices are also LTE-capable' }),
      selectField('Traffic', TRAFFIC, () => tpl.traffic, (v) => {
        tpl.traffic = v;
        mapView.refreshBanner();
      }),
      numField('Data demand', () => tpl.demandMbps ?? 0, (v) => (tpl.demandMbps = v > 0 ? v : null), { min: 0, step: 0.5, unit: 'Mbps', title: '0 = random per session (mean set under Traffic)' }),
      selectField('Phone Rx antennas', [['auto', 'Auto (device default)'], ['1', '1'], ['2', '2'], ['4', '4'], ['8', '8']], () => (tpl.ueRx === null ? 'auto' : String(tpl.ueRx)) as 'auto', (v) => (tpl.ueRx = v === 'auto' ? null : +v)),
      h('h4', null, 'Batch'),
      count,
      selectField('Where', [['view', 'Current map view'], ['rect', 'Rectangle (pick on map)'], ['circle', 'Circle (pick centre on map)']], () => zoneKind, (v) => {
        zoneKind = v;
        radius.style.display = v === 'circle' ? '' : 'none';
      }),
      radius,
      h('div', { class: 'row' }, addBtn),
      h('h4', null, 'One by one'),
      h('div', { class: 'row' }, placeBtn),
    );
  };

  // ---------------------------------------------------------------- roads, speeds, traffic
  const roadStatus = h('div', { class: 'status-line' });
  const updRoads = () => {
    const g = app.roads();
    roadStatus.textContent = g ? `Road graph: ${g.wayCount} ways, ${g.walk.pool.length} walkable / ${g.drive.pool.length} drivable nodes` : 'No road graph loaded: users move by random waypoint inside the area';
  };
  app.onLiveTick(updRoads);
  const loadBtn = button('Load OSM roads for current view', async () => {
    loadBtn.disabled = true;
    try {
      await app.loadRoads();
    } finally {
      loadBtn.disabled = false;
      updRoads();
    }
  });

  const otherSections = () => {
    const u = store.scenario.settings.users;
    const set = () => store.emit('settings');
    const n = specs().length;
    return [
      section('Movement & devices',
        h('p', { class: 'hint' }, 'Pedestrians walk on footways and streets, vehicles drive on roads (one-ways respected), each to random destinations by shortest path.'),
        h('div', { class: 'row' }, loadBtn),
        roadStatus,
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
        numField('Rx antennas: NR devices', () => u.ueRxNr, (v) => {
          u.ueRxNr = Math.round(v);
          set();
        }, { min: 1, max: 8, step: 1, title: 'Default for phones set to Auto' }),
        numField('Rx antennas: LTE devices', () => u.ueRxLte, (v) => {
          u.ueRxLte = Math.round(v);
          set();
        }, { min: 1, max: 8, step: 1, title: 'GSM-only devices always have 1' }),
      ),
      section('Traffic (users with random traffic)',
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
        h('p', { class: 'hint' }, `Offered load ≈ ${((n * u.voiceCallsPerHour * u.voiceMeanDurationS) / 3600).toFixed(1)} Erl voice, ${(((n * u.dataSessionsPerHour * u.dataMeanDurationS) / 3600) * u.dataMeanDemandMbps).toFixed(0)} Mbps data demand (if all ${n} users had random traffic).`),
      ),
    ];
  };

  // ---------------------------------------------------------------- layout
  const searchInput = h('input', { type: 'search', placeholder: 'Search name or cell', oninput: () => {
    filter.q = searchInput.value;
    renderRows();
  } });
  const render = () => {
    clear(root);
    const opOpts: [string, string][] = [['all', 'All operators'], ...store.scenario.operators.map((o) => [o.id, o.name] as [string, string])];
    root.append(
      section('Users',
        searchInput,
        h('div', { class: 'ul-filters' },
          selectEl(opOpts, () => filter.op, (v) => {
            filter.op = v;
            renderRows();
          }),
          selectEl([['all', 'Any mobility'], ...MOBILITY] as [Mobility | 'all', string][], () => filter.mob, (v) => {
            filter.mob = v;
            renderRows();
          }),
          selectEl([['all', 'Any state'], ['active', 'Active session'], ['data', 'Data'], ['voice', 'Voice'], ['idle', 'Idle'], ['none', 'No service']] as [State, string][], () => filter.state, (v) => {
            filter.state = v;
            renderRows();
          }),
        ),
        h('div', { class: 'ul-head' }, h('label', { class: 'ul-selall' }, selectAll, 'All'), countEl),
        batchHost,
        listHost,
        h('div', { class: 'row' }, button('Delete all users', () => {
          if (!specs().length || !confirm(`Delete all ${specs().length} users?`)) return;
          app.deleteAllUsers();
          selected.clear();
          selectionChanged();
        }, 'danger')),
      ),
      addSection(),
      ...otherSections(),
    );
    updRoads();
    renderRows();
    renderBatch();
  };
  render();
  // Live state (sessions, cells, throughput) changes every second: refresh rows while visible.
  app.onLiveTick(() => {
    if (root.offsetParent !== null) renderRows();
  });
  store.on('users', () => {
    if (root.offsetParent !== null) renderRows();
  });
  store.on('scenario', () => {
    selected.clear();
    app.setUserSelection(selected);
    Object.assign(tpl, templateFromSettings(store.scenario));
    render();
  });
  store.on('network', () => {
    if (root.offsetParent !== null) render(); // operator list may have changed
  });
  return root;
}
