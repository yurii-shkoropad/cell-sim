export interface ColorStop {
  v: number;
  c: [number, number, number];
}

export interface Scale {
  title: string;
  unit: string;
  stops: ColorStop[];
  /** Map a value to the scale's axis (e.g. log for throughput). */
  axis?: (v: number) => number;
  ticks: number[];
  /**
   * Discrete classes instead of a gradient: stop i colours [stops[i].v, stops[i+1].v),
   * the last stop only closes the top class. Values below the first stop are not drawn.
   */
  classes?: boolean;
}

const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const stops = (pairs: [number, string][]): ColorStop[] => pairs.map(([v, c]) => ({ v, c: hex(c) }));

/** LTE/NR RSRP, dBm: the drive-test classes (QGIS "RSRP main zone"), so maps compare 1:1. */
export const RSRP_SCALE: Scale = {
  title: 'RSRP',
  unit: 'dBm',
  stops: stops([[-145, '#e3201b'], [-120, '#f0901e'], [-110, '#f2f20d'], [-100, '#3ed43e'], [-90, '#2e8b57'], [-80, '#2fa7e0'], [-70, '#1414c8'], [-40, '#1414c8']]),
  ticks: [-145, -120, -110, -100, -90, -80, -70, -40],
  classes: true,
};

/** GSM RxLev, dBm (per carrier, so ~30 dB above RSRP). */
export const RXLEV_SCALE: Scale = {
  title: 'RxLev',
  unit: 'dBm',
  stops: stops([[-110, '#5b1a8c'], [-104, '#c2185b'], [-95, '#e53935'], [-85, '#fb8c00'], [-75, '#fdd835'], [-65, '#7cb342'], [-55, '#1b7f3b'], [-45, '#0b5394']]),
  ticks: [-110, -100, -90, -80, -70, -60, -50],
};

export const SINR_SCALE: Scale = {
  title: 'SINR',
  unit: 'dB',
  stops: stops([[-10, '#7b1fa2'], [-5, '#e53935'], [0, '#fb8c00'], [5, '#fdd835'], [10, '#c0ca33'], [15, '#7cb342'], [20, '#1b7f3b'], [30, '#0b5394']]),
  ticks: [-10, -5, 0, 5, 10, 15, 20, 30],
};

export const THR_SCALE: Scale = {
  title: 'Peak DL throughput',
  unit: 'Mbps',
  stops: stops([[-1, '#440154'], [0, '#3b528b'], [1, '#21918c'], [2, '#5ec962'], [3, '#fde725']]),
  axis: (v) => Math.log10(Math.max(v, 0.1)),
  ticks: [0.1, 1, 10, 100, 1000],
};

export function colorAt(scale: Scale, value: number): [number, number, number] {
  const v = scale.axis ? scale.axis(value) : value;
  const s = scale.stops;
  if (scale.classes) {
    let i = 0;
    while (i < s.length - 2 && v >= s[i + 1].v) i++;
    return s[i].c;
  }
  if (v <= s[0].v) return s[0].c;
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i].v) {
      const t = (v - s[i - 1].v) / (s[i].v - s[i - 1].v);
      const a = s[i - 1].c;
      const b = s[i].c;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return s[s.length - 1].c;
}

export function cssGradient(scale: Scale): string {
  const s = scale.stops;
  const lo = s[0].v;
  const hi = s[s.length - 1].v;
  const at = (v: number) => (((v - lo) / (hi - lo)) * 100).toFixed(1);
  if (scale.classes) {
    // Hard edges: each class is a flat band.
    const bands = s.slice(0, -1).map((x, i) => `rgb(${x.c.join(',')}) ${at(x.v)}% ${at(s[i + 1].v)}%`);
    return `linear-gradient(to right, ${bands.join(', ')})`;
  }
  return `linear-gradient(to right, ${s.map((x) => `rgb(${x.c.join(',')}) ${(((x.v - lo) / (hi - lo)) * 100).toFixed(1)}%`).join(', ')})`;
}

export function parseColor(css: string): [number, number, number] {
  if (css.startsWith('#')) return hex(css);
  const m = css.match(/hsl\((\d+(?:\.\d+)?),\s*(\d+)%,\s*(\d+)%\)/);
  if (m) {
    const h = +m[1] / 360;
    const s = +m[2] / 100;
    const l = +m[3] / 100;
    const f = (n: number) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }
  return [128, 128, 128];
}
