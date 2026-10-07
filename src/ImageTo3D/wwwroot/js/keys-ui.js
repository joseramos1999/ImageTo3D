// "Keyframes" tab: pick a point (start, middle, end) and set where the logo, the camera and
// the light are at that moment; the clip interpolates between them (keys.js).
import { KEY_PARAMS, KEY_POINTS, KEY_EASES, DEFAULT_KEYS, keyValue } from './keys.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmt = (p, v) => p.unit === '°' ? `${Math.round(v)}°` : p.unit === '%' ? `${Math.round(v * 100)} %` : p.unit === 'x' ? `${v.toFixed(2)}x` : v.toFixed(2);

let current = 0;   // the point being edited (kept while the panel re-renders)

/**
 * Renders into `container`. on: { change(keys) — a settled edit (saved, history),
 * live(keys) — while dragging (preview only), use() — make the keyframes the animation }.
 */
export function renderKeysPanel(container, state, on) {
  const keys = { ...DEFAULT_KEYS, ...(state.keys || {}) };
  keys.points = [0, 1, 2].map(i => ({ ...(keys.points?.[i] || {}) }));
  const active = state.mode === 'keys';
  const withPoint = (i, patch) => ({ ...keys, points: keys.points.map((p, k) => (k === i ? { ...p, ...patch } : p)) });

  // Point selector, like a three-stop timeline.
  const bar = el('div', 'seg keys-points');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Punto de la animación');
  KEY_POINTS.forEach((name, i) => {
    const b = el('button', null, `${name} · ${[0, 50, 100][i]} %`);
    b.type = 'button';
    b.classList.toggle('on', i === current);
    b.setAttribute('aria-pressed', String(i === current));
    b.onclick = () => { current = i; renderKeysPanel(container, state, on); };
    bar.append(b);
  });

  // Sliders for the selected point, grouped.
  const groups = el('div', 'keys-groups');
  const point = keys.points[current];
  let group = null, title = null;
  for (const p of KEY_PARAMS) {
    if (p.group !== title) {
      title = p.group;
      group = el('div', 'keys-group');
      group.append(el('div', 'keys-title', title));
      groups.append(group);
    }
    const v = keyValue(point, p.id);
    const row = el('div', 'slider keys-slider' + (Math.abs(v - p.rest) > 1e-6 ? ' changed' : ''));
    const lbl = el('div', 'lbl');
    const out = el('span', null, fmt(p, v));
    lbl.append(el('span', null, p.label), out);
    const range = Object.assign(document.createElement('input'), { type: 'range', min: String(p.min), max: String(p.max), step: String(p.step), value: String(v) });
    range.setAttribute('aria-label', `${title} ${p.label}, ${KEY_POINTS[current]}`);
    const paint = () => { range.style.setProperty('--p', ((range.value - p.min) / (p.max - p.min) * 100) + '%'); out.textContent = fmt(p, Number(range.value)); };
    paint();
    range.addEventListener('input', () => { paint(); on.live(withPoint(current, { [p.id]: Number(range.value) })); });
    range.addEventListener('change', () => on.change(withPoint(current, { [p.id]: Number(range.value) })));
    range.addEventListener('dblclick', () => on.change(withPoint(current, { [p.id]: p.rest })));
    row.append(lbl, range);
    group.append(row);
  }

  // How the points are joined.
  const easeRow = el('div', 'row');
  const ease = el('select', 'select');
  ease.setAttribute('aria-label', 'Interpolación');
  for (const e of KEY_EASES) ease.add(new Option(e.label, e.id));
  ease.value = keys.ease;
  ease.onchange = () => on.change({ ...keys, ease: ease.value });
  easeRow.append(el('label', null, 'Interpolación'), ease);

  const loopRow = el('div', 'row');
  const sw = el('label', 'switch');
  const loop = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!keys.loop });
  loop.setAttribute('aria-label', 'Volver al inicio (bucle)');
  loop.onchange = () => on.change({ ...keys, loop: loop.checked });
  sw.append(loop, el('span'));
  loopRow.append(el('label', null, 'Volver al inicio (bucle)'), sw);

  // Point tools.
  const tools = el('div', 'row keys-tools');
  const copyPrev = el('button', 'btn small', current === 0 ? 'Copiar del final' : `Copiar de «${KEY_POINTS[current - 1]}»`);
  copyPrev.onclick = () => on.change(withPoint(current, { ...keys.points[current === 0 ? 2 : current - 1] }));
  const reset = el('button', 'btn small', 'Poner en reposo');
  reset.title = 'Todos los valores de este punto en su posición normal';
  reset.onclick = () => on.change({ ...keys, points: keys.points.map((p, k) => (k === current ? {} : p)) });
  tools.append(copyPrev, reset);

  const foot = el('div', 'seq-foot');
  const total = el('span', 'seq-total', `Duración ${String(state.seconds).replace('.', ',')} s (control «Duración» en Exportar)`);
  const status = active
    ? el('span', 'seq-active', '● En uso')
    : Object.assign(el('button', 'btn small primary', 'Usar keyframes'), { onclick: on.use });
  foot.append(total, status);

  container.replaceChildren(bar, groups, easeRow, loopRow, tools, foot);
}
