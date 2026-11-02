import type { BaseStation, Sector } from '../types';
import type { App } from './app';
import { button, h, numField, selectEl, toast } from './dom';
import { buildingsAtMast } from './heightInfo';

type Mode = 'set' | 'add';

interface Param {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  /** Current value of a station, for the summary (first sector for sector parameters). */
  get(bs: BaseStation): number;
  apply(bs: BaseStation, mode: Mode, v: number, clamp: (x: number) => number): void;
  title?: string;
}

const sectorParam = (key: keyof Pick<Sector, 'gain' | 'tilt'>): Pick<Param, 'get' | 'apply'> => ({
  get: (bs) => bs.sectors[0]?.[key] ?? 0,
  apply: (bs, mode, v, clamp) => bs.sectors.forEach((s) => (s[key] = clamp(mode === 'set' ? v : s[key] + v))),
});

const PARAMS: Param[] = [
  {
    key: 'tx', label: 'Tx power', unit: 'dBm', min: -10, max: 70, step: 0.5,
    title: 'Set: every sector gets this power (sector overrides are removed). Change by: station power and sector overrides shift together.',
    get: (bs) => bs.txPowerDbm,
    apply: (bs, mode, v, clamp) => {
      if (mode === 'set') {
        bs.txPowerDbm = clamp(v);
        bs.sectors.forEach((s) => delete s.txPowerDbm);
      } else {
        bs.txPowerDbm = clamp(bs.txPowerDbm + v);
        bs.sectors.forEach((s) => s.txPowerDbm !== undefined && (s.txPowerDbm = clamp(s.txPowerDbm + v)));
      }
    },
  },
  {
    key: 'h', label: 'Antenna height', unit: 'm', min: 1, max: 300, step: 1,
    get: (bs) => bs.heightM,
    apply: (bs, mode, v, clamp) => (bs.heightM = clamp(mode === 'set' ? v : bs.heightM + v)),
  },
  {
    key: 'cable', label: 'Feeder/cable loss', unit: 'dB', min: 0, max: 20, step: 0.1,
    get: (bs) => bs.cableLossDb,
    apply: (bs, mode, v, clamp) => (bs.cableLossDb = clamp(mode === 'set' ? v : bs.cableLossDb + v)),
  },
  { key: 'gain', label: 'Antenna gain', unit: 'dBi', min: -10, max: 35, step: 0.5, title: 'Every sector', ...sectorParam('gain') },
  { key: 'tilt', label: 'Downtilt', unit: '°', min: -10, max: 30, step: 0.5, title: 'Every sector', ...sectorParam('tilt') },
];

/** Range of a parameter over the stations, e.g. "46 dBm" or "43–46 dBm". */
function spread(p: Param, list: BaseStation[]): string {
  if (!list.length) return '';
  const vals = list.map((b) => p.get(b));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const f = (x: number) => String(+x.toFixed(1));
  return `now ${lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`} ${p.unit}`;
}

/**
 * Change one parameter on many stations at once: set it to a value, or change it by an amount.
 * `targets` are the stations listed (after the list filter), so filtering by band / RAT /
 * operator / name picks what is edited.
 */
export interface BulkState {
  mode: Mode;
  open: boolean;
  values: Record<string, number>;
}

export function bulkEditor(app: App, targets: () => BaseStation[], state: BulkState, rerender: () => void): HTMLElement {
  const list = targets();
  // With buildings loaded: antenna height measured from the roof of the building under the mast (ground masts: from the ground).
  const params = [...PARAMS];
  if (app.buildings().set) {
    const roofs = new Map<string, number>();
    const roof = (bs: BaseStation) => {
      if (!roofs.has(bs.id)) roofs.set(bs.id, buildingsAtMast(app, bs)?.roofM ?? 0);
      return roofs.get(bs.id)!;
    };
    params.splice(2, 0, {
      key: 'roof', label: 'Height above roof', unit: 'm', min: 1, max: 300, step: 1,
      title: 'Set: antenna height = roof of the building under the mast + this (ground masts: above ground). Change by: same as antenna height.',
      get: (bs) => bs.heightM - roof(bs),
      apply: (bs, mode, v, clamp) => (bs.heightM = clamp(mode === 'set' ? roof(bs) + v : bs.heightM + v)),
    });
  }
  const enabledOnly = (b: BaseStation) => b.enabled;
  const rows = params.map((p) => {
    state.values[p.key] ??= state.mode === 'set' && list[0] ? +p.get(list[0]).toFixed(1) : 0;
    const field = numField(p.label, () => state.values[p.key], (v) => (state.values[p.key] = v), { step: p.step, unit: state.mode === 'set' ? p.unit : `± ${p.unit}`, title: p.title });
    const apply = button('Apply', () => {
      const v = state.values[p.key];
      const clamp = (x: number) => Math.min(p.max, Math.max(p.min, x));
      const sts = targets();
      if (!sts.length) return toast('No stations listed.', 'info');
      if (state.mode === 'add' && !v) return toast('Enter an amount to change by.', 'info');
      sts.forEach((bs) => p.apply(bs, state.mode, v, clamp));
      app.store.emit('network'); // re-renders the list (and this editor)
      app.store.emit('selection'); // the open station editor shows the new values
      toast(`${p.label} ${state.mode === 'set' ? `set to ${v} ${p.unit}` : `changed by ${v > 0 ? '+' : ''}${v} ${p.unit}`} on ${sts.length} stations.`, 'ok');
    }, '', `Apply to the ${list.length} listed stations`);
    return h('div', { class: 'bulk-row' }, field, apply, h('span', { class: 'bulk-now' }, spread(p, list)));
  });
  const modeSel = selectEl<Mode>([['set', 'Set to'], ['add', 'Change by']], () => state.mode, (v) => {
    state.mode = v;
    state.values = {};
    rerender();
  });
  const off = list.filter((b) => !enabledOnly(b)).length;
  const det = h('details', { class: 'bulk', open: state.open, ontoggle: () => (state.open = det.open) },
    h('summary', null, `Edit all listed stations (${list.length})`),
    h('p', { class: 'hint' }, `Applies to every station in the list below${off ? ` (${off} disabled ones included)` : ''}. Narrow it with the filter first, e.g. “B20”, “LTE” or a site name. Sector parameters change every sector.`),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Mode'), h('span', { class: 'ctl' }, modeSel)),
    ...rows,
  );
  return det;
}
