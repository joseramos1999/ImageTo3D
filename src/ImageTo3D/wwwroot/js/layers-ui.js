// "Capas" panel: the logo's colour layers (an SVG's from its paths, a traced image's from
// its colours when «Separar por colores» is on), each with its own thickness, material and
// visibility. Settings live in source.mask.layerStyle, so projects and undo keep them.
import { MATERIALS } from './materials.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * Renders into `container`.
 *  info: { layers: [{ index, color, detail }], raster: bool, split: bool, colors: 'auto'|n }
 *  style(layer) → { depth, visible, material }
 *  on: { split(on), colors(v), style(layer, patch, rebuild) }  — rebuild: geometry vs material only
 */
export function renderLayersPanel(container, info, style, on) {
  const parts = [];

  if (info.raster) {
    const row = el('div', 'row');
    const label = el('label', null, 'Separar por colores');
    const sw = el('label', 'switch');
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: info.split });
    input.setAttribute('aria-label', 'Separar por colores');
    input.onchange = () => on.split(input.checked);
    sw.append(input, el('span'));
    row.append(label, sw);
    parts.push(row);
    if (info.split) {
      const crow = el('div', 'row');
      const sel = el('select', 'select layers-count');
      sel.setAttribute('aria-label', 'Número de colores');
      sel.add(new Option('Automático', 'auto'));
      for (let n = 2; n <= 8; n++) sel.add(new Option(`${n} colores`, String(n)));
      sel.value = String(info.colors);
      sel.onchange = () => on.colors(sel.value === 'auto' ? 'auto' : Number(sel.value));
      crow.append(el('label', null, 'Colores'), sel);
      parts.push(crow);
    }
  }

  if (info.layers.length > 1) {
    const list = el('div', 'layer-list');
    for (const layer of info.layers) list.append(layerCard(layer, style(layer.index), on));
    parts.push(list);
  } else {
    parts.push(el('p', 'note', info.raster
      ? 'Activa «Separar por colores» para convertir cada color del logo en una capa con su propio grosor y material.'
      : 'Este SVG es de un solo color: todo es una capa.'));
  }
  container.replaceChildren(...parts);
}

function layerCard(layer, st, on) {
  const card = el('div', 'layer' + (st.visible ? '' : ' hidden-layer'));
  const head = el('div', 'layer-head');
  const sw = el('i', 'layer-swatch');
  sw.style.background = layer.color;
  const name = el('span', 'layer-name', `Capa ${layer.index + 1}`);
  const detail = el('span', 'layer-detail', layer.detail || '');
  const eye = el('button', 'btn icon small layer-eye', st.visible ? '◉' : '○');
  eye.type = 'button';
  eye.title = st.visible ? 'Ocultar esta capa' : 'Mostrar esta capa';
  eye.setAttribute('aria-label', `${eye.title}: capa ${layer.index + 1}`);
  eye.setAttribute('aria-pressed', String(!st.visible));
  eye.onclick = () => on.style(layer.index, { visible: !st.visible }, true);
  head.append(sw, name, detail, eye);

  // Thickness: a multiple of the logo's depth, added toward the front.
  const slider = el('div', 'slider layer-depth');
  const lbl = el('div', 'lbl');
  const value = el('span', null, st.depth.toFixed(2) + 'x');
  lbl.append(el('span', null, 'Grosor'), value);
  const range = Object.assign(document.createElement('input'), { type: 'range', min: '0.2', max: '3', step: '0.05', value: String(st.depth) });
  range.setAttribute('aria-label', `Grosor de la capa ${layer.index + 1}`);
  const paint = () => { range.style.setProperty('--p', ((range.value - 0.2) / 2.8 * 100) + '%'); value.textContent = Number(range.value).toFixed(2) + 'x'; };
  paint();
  range.addEventListener('input', paint);
  range.addEventListener('change', () => on.style(layer.index, { depth: Number(range.value) }, true));
  range.addEventListener('dblclick', () => on.style(layer.index, { depth: 1 }, true));
  slider.append(lbl, range);

  const mat = el('select', 'select layer-material');
  mat.setAttribute('aria-label', `Material de la capa ${layer.index + 1}`);
  mat.add(new Option('Material general', ''));
  for (const m of MATERIALS) mat.add(new Option(m.label, m.id));
  mat.value = st.material || '';
  mat.onchange = () => on.style(layer.index, { material: mat.value || null }, false);

  card.append(head, slider, mat);
  return card;
}
