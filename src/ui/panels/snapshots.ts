import { deleteSnapshot, listSnapshots, renameSnapshot, saveSnapshot, snapshotCopy, snapshotsSizeKb, type Snapshot } from '../../state/snapshots';
import type { App } from '../app';
import { button, clear, confirmButton, h, refreshFields, section, toast } from '../dom';

const fmtTime = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Snapshots tab: save the whole state under a name, and load, rename, update or delete it later. */
export function snapshotsPanel(app: App): HTMLElement {
  const { store } = app;
  const root = h('div', { class: 'panel' });
  const listHost = h('div', { class: 'snap-list' });

  const view = () => {
    const c = app.mapView.map.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: app.mapView.map.getZoom() };
  };
  const defaultName = () => `${store.scenario.name} · ${fmtTime(Date.now())}`;
  const nameInput = h('input', { type: 'text', placeholder: 'Snapshot name' }) as HTMLInputElement;

  const save = (name: string, id?: string) => {
    store.scenario.center = { ...store.scenario.center, zoom: app.mapView.map.getZoom() };
    const s = saveSnapshot(name, store.scenario, store.layers, view(), id);
    if (!s) return toast('The browser refused to store the snapshot (storage full?). Delete old snapshots or export JSON instead.', 'error');
    toast(`${id ? 'Updated' : 'Saved'} snapshot “${s.name}”`, 'ok');
    render();
  };

  const load = (id: string) => {
    const s = snapshotCopy(id);
    if (!s) return render();
    store.replaceScenario(s.scenario);
    store.applyLayers(s.layers);
    app.mapView.map.setView([s.view.lat, s.view.lng], s.view.zoom);
    app.respawnUsers();
    void app.loadAreaData();
    refreshFields();
    toast(`Loaded snapshot “${s.name}”`, 'ok');
  };

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
    if (!list.length) listHost.append(h('p', { class: 'hint' }, 'No snapshots yet.'));
    else listHost.append(...list.map(row), h('p', { class: 'hint' }, `${list.length} snapshot${list.length > 1 ? 's' : ''}, about ${snapshotsSizeKb()} kB of this browser’s storage (typically 5 MB in all).`));
  };

  root.append(
    section('Save snapshot',
      h('p', { class: 'hint' }, 'A snapshot keeps the whole state: stations, users, Wi-Fi, planned buildings, all settings, the map layers and the map position. Snapshots stay in this browser; use Import/Export → Export JSON to move a scenario to another computer.'),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Name'), h('span', { class: 'ctl' }, nameInput)),
      h('div', { class: 'row' }, button('Save snapshot', () => {
        save(nameInput.value.trim() || defaultName());
        nameInput.value = '';
      }, 'primary')),
    ),
    section('Snapshots', listHost),
  );
  render();
  return root;
}
