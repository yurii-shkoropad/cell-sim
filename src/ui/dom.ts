type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: string };

/** Minimal hyperscript: h('div', {class: 'x', onclick: fn}, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v as string;
      else if (k === 'style') el.setAttribute('style', v as string);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export interface NumOpts {
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  title?: string;
  /** Display scale, e.g. 100 to edit a 0..1 fraction as percent. */
  scale?: number;
}

export function numField(label: string, get: () => number, set: (v: number) => void, o: NumOpts = {}): HTMLElement {
  const scale = o.scale ?? 1;
  const input = h('input', {
    type: 'number',
    value: String(+(get() * scale).toFixed(6)),
    min: o.min !== undefined ? String(o.min) : undefined,
    max: o.max !== undefined ? String(o.max) : undefined,
    step: String(o.step ?? 'any'),
    onchange: () => {
      let v = parseFloat(input.value);
      if (!Number.isFinite(v)) {
        input.value = String(get() * scale);
        return;
      }
      if (o.min !== undefined) v = Math.max(o.min, v);
      if (o.max !== undefined) v = Math.min(o.max, v);
      input.value = String(v);
      set(v / scale);
    },
  });
  return h('label', { class: 'field', title: o.title }, h('span', { class: 'lbl' }, label), h('span', { class: 'ctl' }, input, o.unit ? h('span', { class: 'unit' }, o.unit) : null));
}

export function textField(label: string, get: () => string, set: (v: string) => void, title?: string): HTMLElement {
  const input = h('input', { type: 'text', value: get(), onchange: () => set(input.value) });
  return h('label', { class: 'field', title }, h('span', { class: 'lbl' }, label), h('span', { class: 'ctl' }, input));
}

export function colorField(label: string, get: () => string, set: (v: string) => void): HTMLElement {
  const input = h('input', { type: 'color', value: get(), oninput: () => set(input.value) });
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), h('span', { class: 'ctl' }, input));
}

export function selectField<T extends string>(label: string, options: [T, string][], get: () => T, set: (v: T) => void, title?: string): HTMLElement {
  const sel = selectEl(options, get, set);
  return h('label', { class: 'field', title }, h('span', { class: 'lbl' }, label), h('span', { class: 'ctl' }, sel));
}

export function selectEl<T extends string>(options: [T, string][], get: () => T, set: (v: T) => void): HTMLSelectElement {
  const sel = h('select', { onchange: () => set(sel.value as T) }, ...options.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = get();
  return sel;
}

export function checkField(label: string, get: () => boolean, set: (v: boolean) => void, title?: string): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: get(), onchange: () => set(input.checked) });
  return h('label', { class: 'field check', title }, input, h('span', null, label));
}

export function rangeField(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string = String): HTMLElement {
  const out = h('span', { class: 'unit' }, fmt(get()));
  const input = h('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(get()),
    oninput: () => {
      out.textContent = fmt(+input.value);
      set(+input.value);
    },
  });
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), h('span', { class: 'ctl' }, input, out));
}

export function section(title: string, ...children: (Child | Child[])[]): HTMLElement {
  return h('section', { class: 'sec' }, h('h3', null, title), ...children);
}

export function button(label: string, onclick: () => void, cls = '', title?: string): HTMLButtonElement {
  return h('button', { class: `btn ${cls}`, onclick, title, type: 'button' }, label);
}

let toastTimer = 0;
export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el!.className = ''), kind === 'error' ? 6000 : 3500);
}

export const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
