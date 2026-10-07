// Relief controls (Geometría → Relieve) and the "Pintar relieve" editor: a height map painted
// over the artwork with brushes and gradients, with a live 3D preview beside it.
// Settings and the painted map live in source.mask.relief (projects, recents and undo keep
// them); the decoded map is cached on the source while it is being edited.
import { DEFAULT_RELIEF, encodeMap, decodeMap, sampleMap } from './relief.js';

const $ = sel => document.querySelector(sel);
const MAP_MAX = 256;
const UNDO_MAX = 25;
const HINTS = {
  raise: 'Pinta para subir. Repasa para subir más.',
  lower: 'Pinta para bajar lo que has subido.',
  smooth: 'Pinta sobre un escalón para suavizarlo.',
  flatten: 'Pinta para devolver la zona a plano.',
  linear: 'Arrastra de donde quieres plano a donde quieres lo más alto. Sustituye el relieve.',
  radial: 'Arrastra desde el centro hacia fuera: lo más alto en el centro. Sustituye el relieve.',
};

export const reliefOf = src => ({ ...DEFAULT_RELIEF, ...(src?.mask.relief || {}) });

/** The painted map of a source (decoded once per saved version), or null. */
export function reliefMap(src) {
  const saved = src?.mask.relief?.map || null;
  if (!src) return null;
  if (src._reliefFrom !== saved) { src._reliefMap = decodeMap(saved); src._reliefFrom = saved; }
  return src._reliefMap;
}

/** Options for buildLogoGroup, or null for a flat logo. */
export function reliefOptions(src) {
  const r = reliefOf(src);
  if (r.mode === 'none' || !(r.amount > 0)) return null;
  const map = r.mode === 'paint' ? reliefMap(src) : null;
  if (r.mode === 'paint' && !map) return null;
  return { mode: r.mode, amount: r.amount, edge: r.edge, both: !!r.both, sample: map ? (u, v) => sampleMap(map, u, v) : null };
}

/**
 * initRelief({ getSource, rebuild, changed, renderPreview })
 *  rebuild()  — rebuild the meshes with the current relief
 *  changed()  — a settled change (history / autosave)
 *  renderPreview(canvas) — draws the logo in 3D into a 2D canvas
 */
export function initRelief({ getSource, rebuild, changed, renderPreview }) {
  // ── panel controls ──
  const modeSeg = $('#relief-mode');
  const set = (patch, settle = true) => {
    const src = getSource();
    if (!src) return;
    src.mask.relief = { ...reliefOf(src), ...patch };
    sync();
    rebuild();
    if (settle) changed();
  };
  modeSeg.querySelectorAll('button').forEach(b => b.onclick = () => {
    const src = getSource();
    if (b.dataset.v === 'paint' && !reliefMap(src)) { set({ mode: 'paint' }); editor.open(); return; }
    set({ mode: b.dataset.v });
  });

  let pending = 0;
  const range = (el, label, min, max, step, key, fmt) => {
    el.innerHTML = '<div class="lbl"><span></span><span></span></div><input type="range">';
    Object.assign(el.querySelector('input'), { min, max, step });
    el.querySelector('.lbl span').textContent = label;
    const input = el.querySelector('input'), out = el.querySelector('.lbl span:last-child');
    input.setAttribute('aria-label', label);
    const paint = () => { input.style.setProperty('--p', ((input.value - min) / (max - min) * 100) + '%'); out.textContent = fmt(Number(input.value)); };
    // Rebuilds while dragging, at most every 80 ms; the settled value goes to the history.
    input.addEventListener('input', () => {
      paint();
      clearTimeout(pending);
      pending = setTimeout(() => set({ [key]: Number(input.value) }, false), 80);
    });
    input.addEventListener('change', () => { clearTimeout(pending); set({ [key]: Number(input.value) }); });
    input.addEventListener('dblclick', () => { input.value = DEFAULT_RELIEF[key]; paint(); set({ [key]: DEFAULT_RELIEF[key] }); });
    return v => { input.value = v; paint(); };
  };
  const syncAmount = range($('#relief-amount'), 'Altura', 0.02, 0.8, 0.01, 'amount', v => v.toFixed(2));
  const syncEdge = range($('#relief-edge'), 'Borde', 0.02, 0.8, 0.01, 'edge', v => v.toFixed(2));
  $('#relief-both').addEventListener('change', e => set({ both: e.target.checked }));
  $('#relief-paint').onclick = () => { if (reliefOf(getSource()).mode !== 'paint') set({ mode: 'paint' }); editor.open(); };

  function sync() {
    const src = getSource(), r = reliefOf(src);
    modeSeg.querySelectorAll('button').forEach(b => {
      const on = b.dataset.v === r.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $('#relief-opts').hidden = r.mode === 'none';
    $('#relief-paint').hidden = r.mode !== 'paint';
    $('#relief-edge').querySelector('.lbl span').textContent = r.mode === 'inflate' ? 'Redondez del borde' : 'Borde suave';
    syncAmount(r.amount);
    syncEdge(r.edge);
    $('#relief-both').checked = !!r.both;
  }

  const editor = initReliefEditor({ getSource, set, renderPreview });
  sync();
  return { sync, refresh() { sync(); editor.refresh(); } };
}

function initReliefEditor({ getSource, set, renderPreview }) {
  const modal = $('#relief-editor'), canvas = $('#re-canvas'), ctx = canvas.getContext('2d');
  const preview = $('#re-preview');
  let tool = 'raise', size = 0.05, strength = 0.35, map = null, drag = null, hover = null, overlay = null;
  const undo = [];

  const seg = $('#re-tool');
  seg.querySelectorAll('button').forEach(b => b.onclick = () => { tool = b.dataset.v; sync(); });
  const slider = (el, label, min, max, step, get, put, fmt) => {
    el.innerHTML = '<div class="lbl"><span></span><span></span></div><input type="range">';
    Object.assign(el.querySelector('input'), { min, max, step });
    el.querySelector('.lbl span').textContent = label;
    const input = el.querySelector('input'), out = el.querySelector('.lbl span:last-child');
    input.setAttribute('aria-label', label);
    const paint = () => { input.style.setProperty('--p', ((input.value - min) / (max - min) * 100) + '%'); out.textContent = fmt(Number(input.value)); };
    input.addEventListener('input', () => { put(Number(input.value)); paint(); draw(); });
    return () => { input.value = get(); paint(); };
  };
  const syncSize = slider($('#re-size'), 'Tamaño del pincel', 0.01, 0.25, 0.005, () => size, v => { size = v; }, v => (v * 100).toFixed(1) + ' %');
  const syncStrength = slider($('#re-strength'), 'Fuerza', 0.05, 1, 0.05, () => strength, v => { strength = v; }, v => Math.round(v * 100) + ' %');

  $('#re-undo').onclick = () => { const prev = undo.pop(); if (prev) { map.data.set(prev); commit(); } sync(); };
  $('#re-clear').onclick = () => { if (!map) return; snapshot(); map.data.fill(0); commit(); };
  $('#re-close').onclick = close;
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  modal.addEventListener('pointerdown', e => { if (e.target === modal) close(); });

  const snapshot = () => { undo.push(map.data.slice()); if (undo.length > UNDO_MAX) undo.shift(); };

  /** Saves the map into the mask (history, projects) and rebuilds the 3D logo. */
  function commit() {
    const src = getSource();
    if (!src || !map) return;
    const saved = encodeMap(map);
    src._reliefFrom = saved;        // the live map already matches: no need to decode it again
    src._reliefMap = map;
    set({ mode: 'paint', map: saved });
    drawPreview();
    draw();
  }

  // ── painting ──
  const toUV = e => {
    const r = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
  };
  function stamp(u, v) {
    const { w, h, data } = map;
    const R = Math.max(1, size * Math.max(w, h)), cx = u * w - 0.5, cy = v * h - 0.5;
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
    const src = tool === 'smooth' ? data.slice() : null;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / R;
      if (d >= 1) continue;
      const f = (1 - d * d) * (1 - d * d) * strength * 0.35;   // soft brush; each stamp adds a little
      const i = y * w + x;
      if (tool === 'raise') data[i] = Math.min(1, data[i] + f);
      else if (tool === 'lower') data[i] = Math.max(0, data[i] - f);
      else if (tool === 'flatten') data[i] = data[i] * (1 - Math.min(1, f * 3));
      else if (tool === 'smooth') {
        let s = 0, n = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += src[yy * w + xx]; n++;
        }
        data[i] += (s / n - data[i]) * Math.min(1, f * 3);
      }
    }
  }
  function gradient(a, b) {
    const { w, h, data } = map;
    const ax = a[0] * w, ay = a[1] * h, bx = b[0] * w, by = b[1] * h;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1, R = Math.sqrt(len2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x + 0.5 - ax, py = y + 0.5 - ay;
      let t = tool === 'linear' ? (px * dx + py * dy) / len2 : 1 - Math.hypot(px, py) / R;
      t = Math.max(0, Math.min(1, t));
      data[y * w + x] = t * t * (3 - 2 * t);
    }
  }

  canvas.addEventListener('pointerdown', e => {
    if (!map) return;
    canvas.setPointerCapture(e.pointerId);
    const uv = toUV(e);
    snapshot();
    drag = { start: uv, last: uv };
    if (tool !== 'linear' && tool !== 'radial') { stamp(...uv); refreshOverlay(); }
    draw();
  });
  canvas.addEventListener('pointermove', e => {
    hover = toUV(e);
    if (drag && tool !== 'linear' && tool !== 'radial') {
      // Stamps every ~fifth of a brush along the way, so fast strokes stay continuous.
      const [lu, lv] = drag.last, steps = Math.max(1, Math.ceil(Math.hypot(hover[0] - lu, hover[1] - lv) / (size * 0.2)));
      for (let k = 1; k <= steps; k++) stamp(lu + (hover[0] - lu) * k / steps, lv + (hover[1] - lv) * k / steps);
      drag.last = hover;
      refreshOverlay();
    } else if (drag) drag.last = hover;
    draw();
  });
  canvas.addEventListener('pointerleave', () => { hover = null; draw(); });
  const finish = () => {
    if (!drag) return;
    if (tool === 'linear' || tool === 'radial') {
      if (Math.hypot(drag.last[0] - drag.start[0], drag.last[1] - drag.start[1]) > 0.01) gradient(drag.start, drag.last);
      else undo.pop();
      refreshOverlay();
    }
    drag = null;
    commit();
    sync();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  // ── view ──
  function fit() {
    const src = getSource();
    const tex = src?.colorTex?.image;
    if (!tex) return;
    const box = $('#re-stage').getBoundingClientRect();
    const k = Math.min((box.width - 16) / tex.width, (box.height - 16) / tex.height, 2);
    const w = Math.max(1, Math.round(tex.width * k)), h = Math.max(1, Math.round(tex.height * k));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }

  /** The height map as an amber veil (more opaque = higher). */
  function refreshOverlay() {
    if (!map) return;
    if (!overlay || overlay.width !== map.w || overlay.height !== map.h) overlay = new OffscreenCanvas(map.w, map.h);
    const g = overlay.getContext('2d'), img = g.createImageData(map.w, map.h);
    for (let i = 0; i < map.data.length; i++) {
      const v = map.data[i];
      img.data[i * 4] = 255; img.data[i * 4 + 1] = Math.round(140 + 100 * v); img.data[i * 4 + 2] = 40;
      img.data[i * 4 + 3] = Math.round(v * 200);
    }
    g.putImageData(img, 0, 0);
  }

  function draw() {
    const src = getSource();
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const tex = src?.colorTex?.image;
    if (!tex) return;
    // Outside the logo the relief does nothing (and the texture there is only padding colour):
    // a plain dark ground, with the artwork and the height map drawn inside the outline.
    const tw = src.meta?.w || 1, th = src.meta?.h || 1;
    const shape = new Path2D();
    for (const o of src.outlines || []) {
      const p = new Path2D();
      for (const loop of [o.outer, ...o.holes]) {
        loop.forEach((q, i) => { const x = (q.x - 0.5) / tw * W, y = (q.y - 0.5) / th * H; i ? p.lineTo(x, y) : p.moveTo(x, y); });
        p.closePath();
      }
      shape.addPath(p);
    }
    ctx.fillStyle = '#16161c';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    for (const o of src.outlines || []) {
      const p = new Path2D();
      for (const loop of [o.outer, ...o.holes]) {
        loop.forEach((q, i) => { const x = (q.x - 0.5) / tw * W, y = (q.y - 0.5) / th * H; i ? p.lineTo(x, y) : p.moveTo(x, y); });
        p.closePath();
      }
      ctx.save();
      ctx.clip(p, 'evenodd');
      ctx.drawImage(tex, 0, 0, W, H);
      if (overlay) ctx.drawImage(overlay, 0, 0, W, H);
      ctx.restore();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = Math.max(1, W / 900);
    ctx.stroke(shape);

    if (drag && (tool === 'linear' || tool === 'radial')) {
      const [ax, ay] = [drag.start[0] * W, drag.start[1] * H], [bx, by] = [drag.last[0] * W, drag.last[1] * H];
      ctx.save();
      ctx.strokeStyle = '#ffd25a';
      ctx.lineWidth = Math.max(2, W / 500);
      ctx.beginPath();
      if (tool === 'linear') { ctx.moveTo(ax, ay); ctx.lineTo(bx, by); }
      else ctx.arc(ax, ay, Math.hypot(bx - ax, by - ay), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (hover && tool !== 'linear' && tool !== 'radial') {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, W / 900);
      ctx.beginPath();
      ctx.arc(hover[0] * W, hover[1] * H, size * Math.max(W, H), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawPreview() { if (!modal.hidden) renderPreview(preview); }

  function sync() {
    seg.querySelectorAll('button').forEach(b => {
      const on = b.dataset.v === tool;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const brush = tool !== 'linear' && tool !== 'radial';
    $('#re-size').hidden = !brush;
    $('#re-strength').hidden = !brush;
    syncSize();
    syncStrength();
    $('#re-undo').disabled = !undo.length;
    $('#re-hint').textContent = HINTS[tool] + ' Fuera del contorno no hay relieve; la altura máxima se ajusta con «Altura» en Geometría.';
    draw();
  }

  function open() {
    const src = getSource();
    if (!src?.colorTex?.image) return;
    // A map the shape of the artwork, at most MAP_MAX px on its long side.
    map = reliefMap(src);
    if (!map) {
      const tw = src.meta?.w || 1, th = src.meta?.h || 1, k = MAP_MAX / Math.max(tw, th);
      map = { w: Math.max(2, Math.round(tw * k)), h: Math.max(2, Math.round(th * k)), data: null };
      map.data = new Float32Array(map.w * map.h);
    }
    undo.length = 0;
    modal.hidden = false;
    fit();
    refreshOverlay();
    sync();
    drawPreview();
    seg.querySelector('button.on')?.focus();
  }

  function close() {
    if (drag) finish();
    modal.hidden = true;
  }

  window.addEventListener('resize', () => { if (!modal.hidden) { fit(); draw(); } });
  return {
    open,
    refresh() { if (!modal.hidden) { map = reliefMap(getSource()) || map; refreshOverlay(); draw(); drawPreview(); } },
  };
}
