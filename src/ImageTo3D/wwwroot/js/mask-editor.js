// "Editar recorte": a large view of the image with the current cut-out, where the user
// paints fixes the automatic mask cannot make — erase, recover (parts taken for background),
// smooth an edge — or clicks a piece to drop it / a hole to fill it.
// Edits are stored in the mask (strokes, removed) in 0..1 image coordinates and applied by
// the tracer (trace.js), so they survive projects, undo and any change of resolution.
import { decodeImage, previewBitmap } from './imaging.js';

const $ = sel => document.querySelector(sel);
const VIEW_MAX = 1400;
const TOOL_HINTS = {
  erase: 'Pinta sobre lo que no es logo para quitarlo.',
  restore: 'Pinta sobre partes del logo que el recorte tomó por fondo (por ejemplo, blanco sobre blanco).',
  smooth: 'Pinta sobre un borde dentado para redondearlo.',
  remove: 'Haz clic en una pieza para quitarla, o dentro de un hueco para rellenarlo.',
};
const STROKE_COLORS = { erase: 'rgba(255,80,80,0.35)', restore: 'rgba(120,230,120,0.35)', smooth: 'rgba(90,170,255,0.35)' };

/** editor = initMaskEditor({ getSource, commit }) — commit(op) retraces ('mask' or 'outlines'). */
export function initMaskEditor({ getSource, commit }) {
  const modal = $('#mask-editor'), canvas = $('#me-canvas'), ctx = canvas.getContext('2d');
  let tool = 'erase', size = 0.025, image = null, imageFor = null, drawing = null, hover = null;
  const stack = [];   // this session's edits, newest last: 'stroke' | 'removed'

  const mask = () => getSource()?.mask;

  // ── tools ──
  const toolSeg = $('#me-tool');
  toolSeg.querySelectorAll('button').forEach(b => b.onclick = () => { tool = b.dataset.v; sync(); });

  const sizeEl = $('#me-size');
  sizeEl.innerHTML = '<div class="lbl"><span>Tamaño del pincel</span><span></span></div><input type="range" min="0.004" max="0.12" step="0.001">';
  const sizeInput = sizeEl.querySelector('input'), sizeOut = sizeEl.querySelector('.lbl span:last-child');
  sizeInput.setAttribute('aria-label', 'Tamaño del pincel');
  const paintSize = () => {
    sizeInput.style.setProperty('--p', ((sizeInput.value - 0.004) / 0.116 * 100) + '%');
    sizeOut.textContent = (Number(sizeInput.value) * 100).toFixed(1) + ' %';
  };
  sizeInput.addEventListener('input', () => { size = Number(sizeInput.value); paintSize(); draw(); });

  $('#me-undo').onclick = () => {
    const m = mask();
    if (!m) return;
    // This session's last edit; for edits from before, the last stroke, then the last click.
    const kind = stack.pop() || (m.strokes?.length ? 'stroke' : m.removed?.length ? 'removed' : null);
    if (kind === 'stroke' && m.strokes?.length) { m.strokes = m.strokes.slice(0, -1); commit('mask'); }
    else if (kind === 'removed' && m.removed?.length) { m.removed = m.removed.slice(0, -1); commit('outlines'); }
    sync();
  };
  $('#me-clear').onclick = () => {
    const m = mask();
    if (!m || (!m.strokes?.length && !m.removed?.length)) return;
    m.strokes = [];
    m.removed = [];
    stack.length = 0;
    commit('mask');
    sync();
  };
  $('#me-close').onclick = close;
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  modal.addEventListener('pointerdown', e => { if (e.target === modal) close(); });

  // ── painting ──
  const toUV = e => {
    const r = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
  };
  canvas.addEventListener('pointerdown', e => {
    const m = mask();
    if (!m || !image) return;
    const uv = toUV(e);
    if (tool === 'remove') {
      m.removed = [...(m.removed || []), uv.map(v => +v.toFixed(5))];
      stack.push('removed');
      commit('outlines');
      sync();
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    drawing = { m: tool, r: +size.toFixed(4), p: uv.map(v => +v.toFixed(5)) };
    draw();
  });
  canvas.addEventListener('pointermove', e => {
    hover = toUV(e);
    if (drawing) {
      const p = drawing.p, n = p.length;
      // A point every ~quarter brush: smooth strokes without thousands of points.
      if (Math.hypot(hover[0] - p[n - 2], (hover[1] - p[n - 1]) * canvas.height / canvas.width) > size * 0.25) {
        p.push(+hover[0].toFixed(5), +hover[1].toFixed(5));
      }
    }
    draw();
  });
  canvas.addEventListener('pointerleave', () => { hover = null; draw(); });
  const finish = () => {
    if (!drawing) return;
    const m = mask();
    if (m) {
      m.strokes = [...(m.strokes || []), drawing];
      stack.push('stroke');
      commit('mask');
    }
    drawing = null;
    sync();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  // ── view ──
  async function loadImage() {
    const src = getSource();
    if (!src?.blob || imageFor === src) return;
    image?.close();
    image = null;
    imageFor = src;
    try {
      const { bitmap } = await decodeImage(src.blob);
      image = await previewBitmap(bitmap, VIEW_MAX);
      bitmap.close();
    } catch (e) {
      console.warn('editor image:', e);
      image = src.before ? await createImageBitmap(src.before) : null;
    }
  }

  function fit() {
    if (!image) return;
    const box = $('#me-stage').getBoundingClientRect();
    const k = Math.min((box.width - 16) / image.width, (box.height - 16) / image.height);
    const w = Math.max(1, Math.round(image.width * Math.min(k, 2))), h = Math.max(1, Math.round(image.height * Math.min(k, 2)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  /** Image, a veil over everything that is not logo, the outline, and the edits. */
  function draw() {
    const src = getSource();
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!image || !src) return;
    ctx.drawImage(image, 0, 0, W, H);

    // Outlines are in field coordinates of the trace (sample x+1 = pixel x).
    const tw = src.meta?.w || 1, th = src.meta?.h || 1;
    const logoPath = new Path2D();
    for (const o of src.outlines || []) {
      for (const loop of [o.outer, ...o.holes]) {
        loop.forEach((p, i) => { const x = (p.x - 0.5) / tw * W, y = (p.y - 0.5) / th * H; i ? logoPath.lineTo(x, y) : logoPath.moveTo(x, y); });
        logoPath.closePath();
      }
    }
    ctx.save();
    ctx.fillStyle = 'rgba(8,8,12,0.62)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    for (const o of src.outlines || []) {
      const p = new Path2D();
      for (const loop of [o.outer, ...o.holes]) {
        loop.forEach((q, i) => { const x = (q.x - 0.5) / tw * W, y = (q.y - 0.5) / th * H; i ? p.lineTo(x, y) : p.moveTo(x, y); });
        p.closePath();
      }
      ctx.fill(p, 'evenodd');
    }
    ctx.restore();
    // The veil cut out the logo from the dark layer; put the image back under it.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.drawImage(image, 0, 0, W, H);
    ctx.restore();
    ctx.lineWidth = Math.max(1.5, W / 700);
    ctx.strokeStyle = '#c8f55a';
    ctx.stroke(logoPath);

    // Edits: painted strokes tinted by kind, removed points as crosses.
    const m = src.mask;
    const paintStroke = st => {
      const pts = st.p || [];
      ctx.strokeStyle = STROKE_COLORS[st.m] || 'rgba(255,255,255,.3)';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = st.r * Math.max(W, H) * 2;
      ctx.lineCap = ctx.lineJoin = 'round';
      if (pts.length === 2) { ctx.beginPath(); ctx.arc(pts[0] * W, pts[1] * H, st.r * Math.max(W, H), 0, Math.PI * 2); ctx.fill(); return; }
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, pts[i] * W, pts[i + 1] * H);
      ctx.stroke();
    };
    ctx.save();
    (m?.strokes || []).forEach(paintStroke);
    if (drawing) paintStroke(drawing);
    ctx.restore();
    const cross = Math.max(5, W / 160);
    ctx.save();
    ctx.strokeStyle = '#ff5a6e';
    ctx.lineWidth = Math.max(2, W / 500);
    for (const [u, v] of m?.removed || []) {
      ctx.beginPath();
      ctx.moveTo(u * W - cross, v * H - cross); ctx.lineTo(u * W + cross, v * H + cross);
      ctx.moveTo(u * W + cross, v * H - cross); ctx.lineTo(u * W - cross, v * H + cross);
      ctx.stroke();
    }
    ctx.restore();

    // Brush outline under the pointer.
    if (hover && tool !== 'remove') {
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, W / 900);
      ctx.beginPath();
      ctx.arc(hover[0] * W, hover[1] * H, size * Math.max(W, H), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function sync() {
    toolSeg.querySelectorAll('button').forEach(b => {
      const on = b.dataset.v === tool;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    canvas.classList.toggle('picking', tool === 'remove');
    sizeEl.hidden = tool === 'remove';
    sizeInput.value = size;
    paintSize();
    const m = mask();
    const edits = (m?.strokes?.length || 0) + (m?.removed?.length || 0);
    $('#me-undo').disabled = !edits;
    $('#me-clear').disabled = !edits;
    $('#me-hint').textContent = TOOL_HINTS[tool] + ' Cada edición vuelve a trazar el logo; Ctrl+Z también la deshace.';
    draw();
  }

  async function open() {
    if (!getSource()?.blob) return;
    modal.hidden = false;
    await loadImage();
    fit();
    sync();
    modal.querySelector('#me-tool button.on, #me-tool button')?.focus();
  }

  function close() {
    finish();
    modal.hidden = true;
  }

  window.addEventListener('resize', () => { if (!modal.hidden) { fit(); draw(); } });

  return {
    open,
    /** The trace changed (new outlines): redraw if open. */
    refresh() { if (!modal.hidden) { if (imageFor !== getSource()) loadImage().then(() => { fit(); draw(); }); else draw(); } },
    get isOpen() { return !modal.hidden; },
  };
}
