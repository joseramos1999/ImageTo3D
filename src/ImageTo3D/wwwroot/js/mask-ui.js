// "Recorte" panel: how the logo is separated from its background, with a
// before / compare / after preview and an eyedropper for the background colour.
import { DEFAULT_MASK } from './trace.js';

const $ = sel => document.querySelector(sel);

export const MASK_MODES = [
  { id: 'auto', label: 'Automático' },
  { id: 'alpha', label: 'Transparencia' },
  { id: 'color', label: 'Color de fondo' },
  { id: 'luma', label: 'Oscuro / claro' },
];

const HINTS = {
  alpha: 'Umbral: cuánta opacidad hace falta para que un píxel cuente como logo.',
  color: 'Umbral: cuánto tiene que diferenciarse un píxel del color de fondo para ser logo.',
  luma: 'Lo oscuro es logo. Activa «Invertir» si el logo es claro sobre fondo oscuro.',
};

const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

/**
 * ui = initMaskUI({ getSource, commit }) where commit(op) applies source.mask:
 * op 'mask' redoes the analysis, 'outlines' only the denoise / holes step.
 */
export function initMaskUI({ getSource, commit, isVector = () => false }) {
  const canvas = $('#mask-canvas');
  const ctx = canvas.getContext('2d');
  let view = 'split', split = 0.5, picking = false, beforePixels = null;

  const mask = () => getSource()?.mask;
  const set = (patch, op) => {
    const m = mask();
    if (!m) return;
    Object.assign(m, patch);
    sync();
    commit(op);
  };

  // ── mode chips ──
  const modes = $('#mask-mode');
  MASK_MODES.forEach(m => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.id = m.id;
    b.textContent = m.label;
    b.setAttribute('aria-pressed', 'false');
    b.onclick = () => set({ mode: m.id }, 'mask');
    modes.appendChild(b);
  });

  // ── sliders ──
  const range = (el, label, min, max, step, key, op, fmt) => {
    el.innerHTML = `<div class="lbl"><span></span><span></span></div><input type="range" min="${min}" max="${max}" step="${step}">`;
    el.querySelector('.lbl span').textContent = label;
    const input = el.querySelector('input'), out = el.querySelector('.lbl span:last-child');
    input.setAttribute('aria-label', label);
    const paint = () => {
      input.style.setProperty('--p', ((input.value - min) / (max - min) * 100) + '%');
      out.textContent = fmt(Number(input.value));
    };
    input.addEventListener('input', () => { paint(); set({ [key]: Number(input.value) }, op); });
    input.addEventListener('dblclick', () => { input.value = DEFAULT_MASK[key]; paint(); set({ [key]: DEFAULT_MASK[key] }, op); });
    return v => { input.value = v; paint(); };
  };
  const syncTol = range($('#mask-tol'), 'Umbral', 0, 1, 0.01, 'tolerance', 'mask', v => Math.round(v * 100) + '%');
  const syncDenoise = range($('#mask-denoise'), 'Limpiar ruido', 0, 10, 1, 'denoise', 'outlines', v => v === 0 ? 'No' : String(v));

  $('#mask-invert').addEventListener('change', e => set({ invert: e.target.checked }, 'mask'));
  $('#mask-fill').addEventListener('change', e => set({ fillHoles: e.target.checked }, 'outlines'));
  $('#mask-color').addEventListener('change', e => set({ mode: 'color', color: e.target.value }, 'mask'));
  $('#mask-reset').onclick = () => set({ ...DEFAULT_MASK, vector: mask()?.vector ?? true }, 'mask');
  $('#mask-vector').addEventListener('change', e => set({ vector: e.target.checked }, 'mask'));

  // ── preview view mode ──
  const viewSeg = $('#mask-view-mode');
  viewSeg.querySelectorAll('button').forEach(b => b.onclick = () => { view = b.dataset.v; picking = false; sync(); draw(); });

  // ── eyedropper ──
  $('#mask-pick').onclick = () => {
    picking = !picking;
    if (picking) view = 'before';
    sync();
    draw();
  };

  const toImage = e => {
    const r = canvas.getBoundingClientRect();
    return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height };
  };
  let dragging = false;
  canvas.addEventListener('pointerdown', e => {
    const src = getSource();
    if (!src?.before) return;
    const { u, v } = toImage(e);
    if (picking) {
      if (!beforePixels) {
        const c = new OffscreenCanvas(src.before.width, src.before.height);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(src.before, 0, 0);
        beforePixels = g.getImageData(0, 0, c.width, c.height);
      }
      const x = Math.min(beforePixels.width - 1, Math.floor(u * beforePixels.width));
      const y = Math.min(beforePixels.height - 1, Math.floor(v * beforePixels.height));
      const i = (y * beforePixels.width + x) * 4, d = beforePixels.data;
      picking = false;
      view = 'split';
      set({ mode: 'color', color: hex(d[i], d[i + 1], d[i + 2]) }, 'mask');
      draw();
      return;
    }
    if (view === 'split') { dragging = true; canvas.setPointerCapture(e.pointerId); split = u; draw(); }
  });
  canvas.addEventListener('pointermove', e => { if (dragging) { split = Math.max(0, Math.min(1, toImage(e).u)); draw(); } });
  canvas.addEventListener('pointerup', () => { dragging = false; });

  function draw() {
    const src = getSource();
    if (!src?.before) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    const w = src.before.width, h = src.before.height;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    if (view === 'before') { ctx.drawImage(src.before, 0, 0); return; }
    if (view === 'after') { if (src.after) ctx.drawImage(src.after, 0, 0, w, h); return; }
    const sx = Math.round(split * w);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sx, h); ctx.clip(); ctx.drawImage(src.before, 0, 0); ctx.restore();
    if (src.after) { ctx.save(); ctx.beginPath(); ctx.rect(sx, 0, w - sx, h); ctx.clip(); ctx.drawImage(src.after, 0, 0, w, h); ctx.restore(); }
    ctx.fillStyle = '#c8f55a';
    ctx.fillRect(sx - 1, 0, 2, h);
  }

  function sync() {
    const m = mask() || DEFAULT_MASK, src = getSource();
    modes.querySelectorAll('.chip').forEach(b => {
      const on = b.dataset.id === m.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    viewSeg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === view && !picking));
    $('#mask-pick').classList.toggle('on', picking);
    $('#mask-pick').setAttribute('aria-pressed', String(picking));
    canvas.classList.toggle('picking', picking);
    canvas.classList.toggle('split', view === 'split' && !picking);
    syncTol(m.tolerance);
    syncDenoise(m.denoise);
    $('#mask-invert').checked = !!m.invert;
    $('#mask-fill').checked = !!m.fillHoles;
    $('#mask-color').value = m.color;

    // SVG: built from its own paths (nothing to cut out), or traced like any image.
    const vectorOn = isVector();
    $('#mask-vector-box').hidden = !src?.vector && !src?.vectorNote;
    $('#mask-vector').checked = vectorOn;
    $('#mask-vector').disabled = !src?.vector;
    $('#mask-raster').hidden = vectorOn;
    $('#mask-pick').hidden = vectorOn;
    if (src?.vector || src?.vectorNote) {
      const r = src.vector?.parsed.report;
      $('#mask-vector-info').textContent = !src.vector
        ? `No se puede usar como vector: ${src.vectorNote}. Se traza como imagen.`
        : vectorOn
          ? `Formas y colores exactos del SVG${r.background ? ' (sin su rectángulo de fondo)' : ''}. El «Suavizado» de Geometría ajusta la precisión de las curvas.` +
            (r.strokes ? ' Los trazos (stroke) no se convierten: pásalos a relleno en tu editor.' : '')
          : 'Se traza la imagen del SVG como si fuera un PNG.';
    }

    const info = $('#mask-info');
    const key = src?.key;
    if (picking) info.textContent = 'Haz clic en el fondo de la imagen para elegir su color.';
    else if (m.mode === 'auto' && key) {
      info.replaceChildren(document.createTextNode(key.auto === 'alpha'
        ? 'Detectado: la imagen tiene transparencia.'
        : 'Detectado: fondo de color '));
      if (key.auto !== 'alpha') {
        const sw = document.createElement('i');
        sw.className = 'mask-swatch';
        sw.style.background = hex(key.r, key.g, key.b);
        info.append(sw, ` ${hex(key.r, key.g, key.b)}.`);
      }
    } else info.textContent = HINTS[m.mode] || '';
  }

  return {
    /** New image or new analysis: refresh controls and preview. */
    refresh() { beforePixels = null; sync(); draw(); },
  };
}
