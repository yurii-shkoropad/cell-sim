import { parseScenario } from '../../io/importers';
import { defaultScenario } from '../../state/defaults';
import { deleteSnapshot, exportSnapshot, listSnapshots, parseSnapshotFile, renameSnapshot, saveSnapshot, snapshotCopy, snapshotsSizeKb, type Snapshot } from '../../state/snapshots';
import type { LayerState } from '../../state/store';
import type { Scenario } from '../../types';
import type { App } from '../app';
import { button, clear, confirmButton, h, refreshFields, section, toast } from '../dom';

const fmtTime = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Snapshots that ship with the app: they can be loaded and exported, not renamed, updated or deleted. */
const BUILT_IN: { id: string; name: string; hint: string; load(): Promise<Scenario> }[] = [
  {
    id: 'builtin-table4',
    name: 'Kyivstar LTE – Table 4 (central Lviv)',
    hint: '24 Kyivstar sites, 84 LTE carriers, 166 cells from the Table 4 engineering parameters (positions, azimuths, PCIs). The table has no bands, so carriers are assumed from the cell layer: 4x B3, 3x B1, 5x B7, 6x B8, 16x B20.',
    load: async () => {
      const r = await fetch(`${import.meta.env.BASE_URL}scenarios/kyivstar-lviv-table4.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return parseScenario(await r.text());
    },
  },
  {
    id: 'builtin-polytechnic',
    name: 'Lviv Polytechnic (default demo)',
    hint: 'Three operators with GSM, LTE and NR sites, Wi-Fi access points and users around the Lviv Polytechnic campus.',
    load: async () => defaultScenario(),
  },
];

/** Snapshots (Import/Export tab): save the whole state under a name; load, rename, update, export, import or delete it. */
export function snapshotsSections(app: App): HTMLElement {
  const { store } = app;
  const root = h('div');
  const listHost = h('div', { class: 'snap-list' });

  const view = () => {
    const c = app.mapView.map.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: app.mapView.map.getZoom() };
  };
  const defaultName = () => `${store.scenario.name} · ${fmtTime(Date.now())}`;
  const nameInput = h('input', { type: 'text', placeholder: 'Snapshot name' }) as HTMLInputElement;

  const save = (name: string, id?: string) => {
    store.scenario.name = name;
    store.scenario.center = { ...store.scenario.center, zoom: app.mapView.map.getZoom() };
    const s = saveSnapshot(name, store.scenario, store.layers, view(), id);
    if (!s) return toast('The browser refused to store the snapshot (storage full?). Delete old snapshots or export them first.', 'error');
    toast(`${id ? 'Updated' : 'Saved'} snapshot “${s.name}”`, 'ok');
    render();
  };

  /** Make a scenario (with optional layers / map position) the current state. */
  const apply = (name: string, scenario: Scenario, layers?: Partial<LayerState>, v?: Snapshot['view']) => {
    store.replaceScenario(scenario);
    if (layers) store.applyLayers(layers);
    const c = v ?? scenario.center;
    app.mapView.map.setView([c.lat, c.lng], ('zoom' in c ? c.zoom : undefined) ?? app.mapView.map.getZoom());
    app.respawnUsers();
    void app.loadAreaData();
    refreshFields();
    toast(`Loaded “${name}”`, 'ok');
  };

  const load = (id: string) => {
    const s = snapshotCopy(id);
    if (!s) return render();
    apply(s.name, s.scenario, s.layers, s.view);
  };

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', onchange: async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const j = parseSnapshotFile(await f.text());
      const layers = { ...store.layers, ...j.layers } as LayerState;
      const v = j.view ?? { lat: j.scenario.center.lat, lng: j.scenario.center.lng, zoom: j.scenario.center.zoom };
      const names = new Set(listSnapshots().map((s) => s.name));
      let name = j.name;
      for (let k = 2; names.has(name); k++) name = `${j.name} (${k})`;
      if (!saveSnapshot(name, j.scenario, layers, v)) return toast('The browser refused to store the snapshot (storage full?).', 'error');
      toast(`Imported snapshot “${name}”. Press Load to use it.`, 'ok');
      render();
    } catch (e) {
      toast(`Could not import: ${(e as Error).message}`, 'error');
    }
  } }) as HTMLInputElement;

  const builtInRow = (b: (typeof BUILT_IN)[number]) =>
    h('div', { class: 'snap-row builtin' },
      h('div', { class: 'snap-name' }, b.name, h('span', { class: 'snap-badge' }, 'built-in')),
      h('div', { class: 'snap-meta' }, b.hint),
      h('div', { class: 'row' },
        confirmButton('Load', 'Click again: replace current', async () => {
          try {
            apply(b.name, await b.load());
          } catch (e) {
            toast(`Could not load: ${(e as Error).message}`, 'error');
          }
        }, 'primary', 'Replace the current state with this snapshot'),
        button('Export', async () => {
          try {
            const scenario = await b.load();
            exportSnapshot({ name: b.name, savedAt: Date.now(), scenario });
          } catch (e) {
            toast(`Could not export: ${(e as Error).message}`, 'error');
          }
        }, '', 'Download as a .json file'),
      ),
    );

  const row = (s: Snapshot) => {
    const name = h('input', { type: 'text', value: s.name, title: 'Rename: type and press Enter', onchange: () => {
      const v = name.value.trim();
      if (!v) return void (name.value = s.name);
      if (renameSnapshot(s.id, v)) s.name = v;
    } }) as HTMLInputElement;
    const users = s.scenario.users?.length ?? 0;
    return h('div', { class: 'snap-row' },
      name,
      h('div', { class: 'snap-meta' }, `${fmtTime(s.savedAt)} · ${s.scenario.stations.length} stations · ${users} users · ${s.scenario.wifi?.length ?? 0} APs`),
      h('div', { class: 'row' },
        confirmButton('Load', 'Click again: replace current', () => load(s.id), 'primary', 'Replace the current state with this snapshot'),
        confirmButton('Update', 'Click again: overwrite', () => save(s.name, s.id), '', 'Overwrite this snapshot with the current state'),
        button('Export', () => {
          const c = snapshotCopy(s.id);
          if (c) exportSnapshot(c);
        }, '', 'Download as a .json file (to share, or to move to another computer)'),
        confirmButton('Delete', 'Click again: delete', () => {
          deleteSnapshot(s.id);
          render();
        }, 'danger'),
      ),
    );
  };

  const render = () => {
    clear(listHost);
    const list = listSnapshots();
    listHost.append(...list.map(row));
    if (!list.length) listHost.append(h('p', { class: 'hint' }, 'No saved snapshots yet.'));
    listHost.append(...BUILT_IN.map(builtInRow));
    if (list.length) listHost.append(h('p', { class: 'hint' }, `${list.length} saved snapshot${list.length > 1 ? 's' : ''}, about ${snapshotsSizeKb()} kB of this browser’s storage (typically 5 MB in all).`));
  };

  root.append(
    section('Snapshots',
      h('p', { class: 'hint' }, 'A snapshot keeps the whole state: stations, users, Wi-Fi, planned buildings, all settings, the map layers and the map position. Saved snapshots stay in this browser; Export downloads one as a file, Import adds a file (also an older scenario JSON) to the list.'),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Name'), h('span', { class: 'ctl' }, nameInput)),
      h('div', { class: 'row' },
        button('Save snapshot', () => {
          save(nameInput.value.trim() || defaultName());
          nameInput.value = '';
        }, 'primary'),
        h('label', { class: 'btn file' }, 'Import…', fileInput),
      ),
      listHost,
    ),
  );
  render();
  return root;
}
