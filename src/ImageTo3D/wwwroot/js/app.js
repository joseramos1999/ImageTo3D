// App controller: UI state ↔ engine.
import * as THREE from 'three';
import { DEFAULT_MASK } from './trace.js';
import { shapesFromOutlines, buildLogoGroup } from './geometry.js';
import { decodeImage, previewBitmap, ImageTooLargeError, LIMITS } from './imaging.js';
import { pipeline } from './pipeline.js';
import { MATERIALS, createMaterials, disposeMaterials } from './materials.js';
import { ANIMATIONS, getAnimation, poseAt, fitLoop, resetPose, stillTime } from './animations.js';
import { PRESETS, matchesPreset } from './presets.js';
import { Stage, LIGHTING, FLOORS, CAMERA_MOVES, BACKGROUNDS } from './stage.js';
import { exportVideo, exportPNG, exportGLB, exportSTL, download } from './exporter.js';
import { host } from './host.js';
import { demoLogo, textLogo } from './sources.js';

const $ = sel => document.querySelector(sel);

// ───────── state ─────────
const DEFAULTS = {
  depth: 0.4, bevel: 0.03, smooth: 2, scale: 1,
  material: 'logo', color: '#c8f55a', sideMode: 'logo', sideColor: '#1c1c24',
  anim: 'rotate-y', animTab: 'preset', speed: 1,
  lighting: 'studio', lightGain: 1, floor: 'shadow', bg: 'vignette', camMove: 'none',
  bloom: 0, bloomTh: 0.85, particles: false, density: 1,
  format: 'mp4', res: '1080', aspect: '16:9', fps: '30', seconds: 6, transparent: false, stlWidth: 100,
};
const STORE_KEY = 'imageto3d.settings.v1';
const state = { ...DEFAULTS };
try { Object.assign(state, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch { /* fresh start */ }
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ } };

// ───────── engine ─────────
const canvas = $('#canvas');
const stage = new Stage(canvas);
let source = null;     // { name, blob, thumbUrl, mask, meta, key, colorTex, outlines, shapeSet, before, after }
let logo = null;       // THREE.Group of piece meshes
let materials = [];
let exporting = false, cancelExport = false;

// ───────── source loading ─────────
// The image work (tracing, colour texture, mask preview) runs in a Web Worker; only the
// extrusion happens here. Every request bumps `pipeJob`, so a slow result that has been
// overtaken by a newer one is dropped instead of overwriting it.
let pipeJob = 0;

function setBusy(on) {
  clearTimeout(setBusy.t);
  // Short jobs never flash the spinner.
  if (on) setBusy.t = setTimeout(() => $('#stage').classList.add('busy'), 150);
  else $('#stage').classList.remove('busy');
}

const NO_SHAPE_MSG = 'No se encontró la forma del logo. Ajusta la máscara (modo de fondo y umbral) en «Recorte».';

/** Takes ownership of `bitmap`. `blob` is the original file, kept for saving projects. */
async function loadSource(bitmap, { name, blob, thumbUrl = null, mask = DEFAULT_MASK }) {
  const job = ++pipeJob;
  setBusy(true);
  const t0 = performance.now();
  try {
    const before = await previewBitmap(bitmap);
    const r = await pipeline.load(bitmap, mask, state.smooth);
    if (job !== pipeJob) { r.color?.close(); r.after?.close(); before.close(); return false; }
    disposeSource();
    // The worker now holds this image, so it becomes the source even when nothing was
    // found: the mask controls are how the user fixes that.
    source = { name, blob, thumbUrl, mask: { ...DEFAULT_MASK, ...mask }, before };
    applyAnalysis(r);
    rebuildMeshes();
    frameCamera();
    setThumb(thumbUrl);
    updateHud(performance.now() - t0);
    onSourceChanged();
    if (!r.outlines.length) toast(NO_SHAPE_MSG, 'error');
    return true;
  } catch (e) {
    console.error(e);
    if (job === pipeJob) toast('No se pudo procesar la imagen: ' + e.message, 'error');
    return false;
  } finally {
    if (job === pipeJob) setBusy(false);
  }
}

/** Re-runs the pipeline for the current image: 'mask' redoes everything, 'outlines' only
 *  the smoothing / denoise / holes step. */
async function retrace(op) {
  if (!source) return;
  const job = ++pipeJob;
  setBusy(true);
  try {
    const r = op === 'mask'
      ? await pipeline.remask(source.mask, state.smooth)
      : await pipeline.outlines(state.smooth, source.mask);
    if (job !== pipeJob) { r.color?.close(); r.after?.close(); return; }
    const hadShape = !!source.outlines?.length;
    applyAnalysis(r);
    rebuildMeshes();
    if (!hadShape && r.outlines.length) frameCamera();
    updateHud();
    onSourceChanged();
    if (!r.outlines.length) toast(NO_SHAPE_MSG, 'error');
  } catch (e) {
    console.error(e);
    if (job === pipeJob) toast('No se pudo procesar la imagen: ' + e.message, 'error');
  } finally {
    if (job === pipeJob) setBusy(false);
  }
}

function applyAnalysis(r) {
  if (r.color) {
    source.colorTex?.image?.close?.();
    source.colorTex?.dispose();
    const tex = new THREE.Texture(r.color);
    tex.flipY = false;               // planar UVs run top→bottom like image rows
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = stage.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    source.colorTex = tex;
    source.meta = r.meta;
    source.key = r.key;
  }
  source.after?.close();
  source.after = r.after;
  source.outlines = r.outlines;
  source.shapeSet = shapesFromOutlines(r.outlines, source.meta);
}

function disposeSource() {
  if (!source) return;
  source.colorTex?.image?.close?.();
  source.colorTex?.dispose();
  source.before?.close();
  source.after?.close();
  if (source.thumbUrl) URL.revokeObjectURL(source.thumbUrl);
}

/** Frames the logo, leaving room for animations that spin it in its own plane. */
function frameCamera() {
  stage.frame(!!getAnimation(state.anim).round);
}

function rebuildOutlines() { retrace('outlines'); }

/** Anything that mirrors the current source (previews, autosave) refreshes from here. */
function onSourceChanged() {}

function rebuildMeshes() {
  if (!source) return;
  const old = logo;
  logo = buildLogoGroup(source.shapeSet, { depth: state.depth, bevel: state.bevel, smoothness: state.smooth });
  applyMaterials();
  stage.setLogo(logo);
  stage.updateFloorHeight(!!getAnimation(state.anim).tall);
  if (old) old.traverse(o => o.geometry?.dispose());
  invalidateThumbs();
}

/** Pushes every scene setting in `state` to the engine (used by presets and on start-up). */
function applySceneToEngine() {
  stage.setLighting(state.lighting, state.lightGain);
  stage.setBackground((BACKGROUNDS.find(b => b.id === state.bg) || BACKGROUNDS[0]).spec);
  stage.setFloor(state.floor);
  stage.setBloom(state.bloom, state.bloomTh);
  stage.setParticles(state.particles, state.density);
  stage.cameraMove = state.camMove;
  stage.updateFloorHeight(!!getAnimation(state.anim).tall);
  applyMaterials();
}

function applyMaterials() {
  if (!logo) return;
  const old = materials;
  materials = createMaterials(state.material, {
    logoMap: source?.colorTex, color: state.color, sideMode: state.sideMode, sideColor: state.sideColor,
  });
  logo.children.forEach(m => { m.material = materials; });
  if (old.length) disposeMaterials(old);
}

async function openFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('Ese archivo no es una imagen.', 'error'); return; }
  let decoded;
  try {
    decoded = await decodeImage(file);
  } catch (e) {
    console.error(e);
    toast(e instanceof ImageTooLargeError ? e.message : 'No se pudo leer la imagen.', 'error');
    return;
  }
  const { bitmap, width, height } = decoded;
  const ok = await loadSource(bitmap, { name: file.name, blob: file, thumbUrl: URL.createObjectURL(file) });
  if (!ok) return;
  const reduced = Math.max(width, height) > LIMITS.workSide;
  toast(reduced
    ? `«${file.name}» (${width}×${height}) reducido a ${LIMITS.workSide} px para trabajar y convertido a 3D`
    : `«${file.name}» convertido a 3D`);
}

/** Text and the demo logo are drawn on a canvas and go through the same pipeline. */
async function loadCanvas(canvas, name, withThumb) {
  const [bitmap, blob] = await Promise.all([createImageBitmap(canvas), new Promise(r => canvas.toBlob(r, 'image/png'))]);
  return loadSource(bitmap, { name, blob, thumbUrl: withThumb ? URL.createObjectURL(blob) : null });
}

/** Builds DOM from [tag, text] parts with textContent only: file names and typed
 *  text reach the UI, and must never be parsed as HTML. */
function setParts(el, parts) {
  el.replaceChildren(...parts.map(p => {
    if (typeof p === 'string') return document.createTextNode(p);
    const n = document.createElement(p[0]);
    n.textContent = p[1];
    return n;
  }));
}

function setThumb(url) {
  const drop = $('#drop');
  if (!url) { drop.classList.remove('has-thumb'); return; }
  drop.classList.add('has-thumb');
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  const small = document.createElement('small');
  small.textContent = 'Clic o arrastra para cambiar';
  drop.replaceChildren(img, small);
}

function updateHud(ms) {
  if (!logo) return;
  let tris = 0;
  logo.children.forEach(m => { tris += m.geometry.attributes.position.count / 3; });
  const parts = [`${source.name} · `, ['b', String(logo.children.length)], ' piezas · ', ['b', `${Math.round(tris / 1000)}k`], ' triángulos'];
  if (ms != null) parts.push(' · ', ['b', String(Math.round(ms))], ' ms');
  setParts($('#hud'), parts);
}

// ───────── preview loop ─────────
let animClock = 0, camClock = 0, last = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (exporting || !logo) return;
  animClock += dt * state.speed;
  camClock += dt;
  stage.controls.update();
  poseAt(getAnimation(state.anim), animClock, stage.motion, logo.children, false);
  stage.render((camClock % state.seconds) / state.seconds);
}

// ───────── layout: letterboxed viewport in the export aspect ─────────
function layoutViewport() {
  const box = $('#stage').getBoundingClientRect();
  const [aw, ah] = state.aspect.split(':').map(Number);
  const availW = box.width - 40, availH = box.height - 40;
  let w = availW, h = w * ah / aw;
  if (h > availH) { h = availH; w = h * aw / ah; }
  w = Math.max(50, Math.floor(w)); h = Math.max(50, Math.floor(h));
  const vp = $('#viewport');
  vp.style.width = w + 'px'; vp.style.height = h + 'px';
  stage.setSize(w, h);
}
new ResizeObserver(layoutViewport).observe($('#stage'));

// ───────── export ─────────
function exportDims() {
  const base = state.res === '2160' ? 2160 : 1080;
  const long = Math.round(base * 16 / 9);
  if (state.aspect === '9:16') return [base, long];
  if (state.aspect === '1:1') return [base, base];
  return [long, base];
}

async function runExport() {
  if (!logo || exporting) return;
  if (!logo.children.length) { toast(NO_SHAPE_MSG, 'error'); return; }
  const fmt = state.format;
  try {
    if (fmt === 'glb') { const r = await exportGLB(logo, state.scale); download(r.blob, r.filename); return; }
    if (fmt === 'stl') { const r = exportSTL(logo, state.stlWidth); download(r.blob, r.filename); return; }

    const [w, h] = exportDims();
    const anim = getAnimation(state.anim);
    exporting = true;
    const restore = stage.beginFixedSize(w, h);
    try {
      if (fmt === 'png') {
        const r = await exportPNG({
          canvas, width: w, height: h,
          renderFrame: () => {
            poseAt(anim, anim.kind === 'intro' ? anim.duration : animClock, stage.motion, logo.children, true);
            stage.render((camClock % state.seconds) / state.seconds, { transparent: state.transparent });
          },
        });
        download(r.blob, r.filename);
        return;
      }

      const seconds = state.seconds, fps = Number(state.fps);
      const fit = fitLoop(anim, seconds, state.speed);
      cancelExport = false;
      showProgress(`Renderizando vídeo ${w}×${h} · ${fps} fps…`);
      const r = await exportVideo({
        canvas, width: w, height: h, fps, seconds,
        renderFrame: (i, t) => {
          poseAt(anim, t * fit.speed, stage.motion, logo.children, true);
          stage.render(t / seconds);
        },
        onProgress: p => setProgress(p),
        isCancelled: () => cancelExport,
      });
      hideProgress();
      if (r) download(r.blob, r.filename);
      else toast('Exportación cancelada');
    } finally {
      restore();
      exporting = false;
      hideProgress();
    }
  } catch (e) {
    console.error(e);
    toast('Error al exportar: ' + (e.message || e), 'error');
  }
}

function showProgress(title) { $('#progress-title').textContent = title; setProgress(0); $('#progress').hidden = false; }
function hideProgress() { $('#progress').hidden = true; }
function setProgress(p) {
  $('#progress-bar').style.width = (p * 100).toFixed(1) + '%';
  $('#progress-text').textContent = Math.round(p * 100) + '%';
}

// ───────── toasts ─────────
function toast(text, kind = 'info', action) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 5000);
}

host.on('saved', msg => toast('Guardado en ' + msg.path, 'info', { label: 'Mostrar en carpeta', run: () => host.post({ type: 'reveal', path: msg.path }) }));
host.on('save-failed', msg => toast('No se pudo guardar el archivo (' + msg.reason + ')', 'error'));

// ───────── UI wiring ─────────
const FORMAT = {
  x: v => Number(v).toFixed(2) + 'x',
  '%': v => Math.round(v * 100) + '%',
  s: v => v + ' s',
  mm: v => v + ' mm',
  off: v => Number(v) === 0 ? 'Off' : Number(v).toFixed(2),
};
const ON_CHANGE = {
  depth: rebuildMeshes, bevel: rebuildMeshes, smooth: rebuildOutlines,
  scale: () => { stage.setUserScale(state.scale); stage.fitShadow(); },
  lightGain: () => stage.setLighting(state.lighting, state.lightGain),
  bloom: () => stage.setBloom(state.bloom, state.bloomTh),
  bloomTh: () => stage.setBloom(state.bloom, state.bloomTh),
  density: () => stage.setParticles(state.particles, state.density, '#ffffff'),
  seconds: updateLoopNote, speed: updateLoopNote,
};

const sliderSync = {};   // key → re-reads state into the slider

function initSliders() {
  document.querySelectorAll('.slider').forEach(el => {
    const key = el.dataset.key, fmt = FORMAT[el.dataset.fmt] || (v => String(v));
    el.innerHTML = `<div class="lbl"><span>${el.dataset.label}</span><span></span></div>
      <input type="range" min="${el.dataset.min}" max="${el.dataset.max}" step="${el.dataset.step}">`;
    const input = el.querySelector('input'), out = el.querySelector('.lbl span:last-child');
    const paint = () => {
      const p = (input.value - input.min) / (input.max - input.min) * 100;
      input.style.setProperty('--p', p + '%');
      out.textContent = fmt(input.value);
    };
    sliderSync[key] = () => { input.value = state[key]; paint(); };
    sliderSync[key]();
    let pending = 0;
    input.addEventListener('input', () => {
      state[key] = Number(input.value);
      paint();
      // Geometry rebuilds are throttled to one per frame while dragging.
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => { ON_CHANGE[key]?.(); save(); });
    });
    input.addEventListener('dblclick', () => { input.value = DEFAULTS[key]; input.dispatchEvent(new Event('input')); });
  });
}

function chips(container, items, key, onPick, render = it => it.label) {
  const el = $(container);
  el.innerHTML = '';
  items.forEach(it => {
    const b = document.createElement('button');
    b.className = 'chip' + (state[key] === it.id ? ' on' : '');
    b.dataset.id = it.id;
    b.innerHTML = render(it);
    b.onclick = () => {
      state[key] = it.id;
      el.querySelectorAll('.on').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      onPick(it);
      save();
    };
    el.appendChild(b);
  });
}

function segmented(id, key, onPick = () => {}) {
  const el = $(id);
  const sync = () => el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(state[key])));
  el.querySelectorAll('button').forEach(b => b.onclick = () => { state[key] = b.dataset.v; sync(); onPick(b.dataset.v); save(); });
  sync();
}

function initMaterials() {
  const el = $('#materials');
  el.innerHTML = '';
  MATERIALS.forEach(m => {
    const b = document.createElement('div');
    b.className = 'swatch' + (state.material === m.id ? ' on' : '');
    b.dataset.id = m.id;
    b.innerHTML = `<i style="background:${m.swatch}"></i>${m.label}`;
    b.onclick = () => {
      state.material = m.id;
      el.querySelectorAll('.on').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      applyMaterials();
      syncColorRows();
      save();
    };
    el.appendChild(b);
  });
}

function syncColorRows() {
  const m = MATERIALS.find(x => x.id === state.material);
  $('#color-row').hidden = !m?.tint;
  $('#side-row').hidden = state.material !== 'logo';
  $('#side-color').hidden = state.sideMode !== 'custom';
}

function renderAnimationList() {
  const el = $('#animations');
  el.classList.toggle('presets', state.animTab === 'preset');
  if (state.animTab === 'preset') { renderPresets(); return; }
  chips('#animations', ANIMATIONS.filter(a => a.kind === state.animTab || a.id === 'none'), 'anim', a => {
    animClock = 0;
    if (a.round) stage.frame(true);
    stage.updateFloorHeight(!!a.tall);
    updateLoopNote();
  }, a => a.pieces ? `${a.label}<span class="pc" title="Anima cada pieza por separado">▦</span>` : a.label);
}

function initAnimations() {
  segmented('#anim-tabs', 'animTab', renderAnimationList);
  renderAnimationList();
}

// ───────── presets ("Predeterminadas") ─────────
const thumbs = new Map();   // preset id → data URL rendered with the current logo
let thumbsJob = 0;

function renderPresets() {
  const el = $('#animations');
  el.innerHTML = '';
  PRESETS.forEach(p => {
    const card = document.createElement('button');
    card.className = 'preset' + (matchesPreset(p, state) ? ' on' : '');
    card.dataset.id = p.id;
    card.innerHTML = `<span class="thumb">${thumbs.has(p.id) ? `<img src="${thumbs.get(p.id)}" alt="">` : ''}</span><span class="name">${p.label}</span>`;
    card.onclick = () => applyPreset(p);
    el.appendChild(card);
  });
  if (thumbs.size < PRESETS.length) renderThumbs();
}

function applyPreset(p) {
  Object.assign(state, p.set);
  animClock = 0;
  camClock = 0;
  applySceneToEngine();
  syncSceneUI();
  save();
}

/** Re-reads `state` into every scene control after many keys changed at once. */
function syncSceneUI() {
  const mark = (sel, value) => document.querySelectorAll(sel).forEach(e => e.classList.toggle('on', e.dataset.id === value));
  mark('#materials .swatch', state.material);
  mark('#lighting .chip', state.lighting);
  mark('#floors .chip', state.floor);
  mark('#cameras .chip', state.camMove);
  mark('#backgrounds .bg', state.bg);
  if (state.animTab === 'preset') document.querySelectorAll('#animations .preset').forEach(card => {
    card.classList.toggle('on', matchesPreset(PRESETS.find(p => p.id === card.dataset.id), state));
  });
  else renderAnimationList();
  Object.values(sliderSync).forEach(fn => fn());
  $('#color').value = state.color;
  $('#particles').checked = state.particles;
  syncColorRows();
  updateLoopNote();
}

function invalidateThumbs() {
  thumbs.clear();
  thumbsJob++;
  if (state.animTab === 'preset') renderPresets();
}

/**
 * Renders each preset with the user's own logo. One preset per task: the scene is
 * switched, drawn small, read back and switched back within the same task, so the
 * live viewport never shows the intermediate state.
 */
async function renderThumbs() {
  const job = ++thumbsJob;
  for (const p of PRESETS) {
    await new Promise(r => setTimeout(r, 0));
    if (job !== thumbsJob || !logo) return;
    if (thumbs.has(p.id) || exporting) continue;

    const saved = { ...state };
    const cam = stage.camera.position.clone(), target = stage.controls.target.clone();
    Object.assign(state, p.set);
    applySceneToEngine();
    const restore = stage.beginFixedSize(320, 180);
    stage.frame();
    const anim = getAnimation(state.anim);
    poseAt(anim, stillTime(anim), stage.motion, logo.children, true);
    stage.render(0.1);
    thumbs.set(p.id, canvas.toDataURL('image/jpeg', 0.82));
    restore();

    Object.assign(state, saved);
    applySceneToEngine();
    stage.camera.position.copy(cam);
    stage.controls.target.copy(target);
    stage.controls.update();
    poseAt(getAnimation(state.anim), animClock, stage.motion, logo.children, false);
    stage.render((camClock % state.seconds) / state.seconds);

    const img = document.querySelector(`#animations .preset[data-id="${p.id}"] .thumb`);
    if (img) img.innerHTML = `<img src="${thumbs.get(p.id)}" alt="">`;
  }
}

function initBackgrounds() {
  const el = $('#backgrounds');
  BACKGROUNDS.forEach(bg => {
    const b = document.createElement('div');
    b.className = 'bg' + (state.bg === bg.id ? ' on' : '');
    b.dataset.id = bg.id;
    b.style.background = bg.css;
    b.title = bg.id;
    b.onclick = () => {
      state.bg = bg.id;
      el.querySelectorAll('.on').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      stage.setBackground(bg.spec);
      save();
    };
    el.appendChild(b);
  });
}

function syncExportOpts() {
  document.querySelectorAll('.export-opts').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(state.format); });
  const label = { mp4: 'Exportar vídeo MP4', png: 'Exportar imagen PNG', glb: 'Exportar modelo GLB', stl: 'Exportar STL (impresión 3D)' };
  $('#btn-export').textContent = label[state.format];
}

function updateLoopNote() {
  const anim = getAnimation(state.anim);
  const el = $('#loop-note');
  if (anim.kind === 'intro') { el.textContent = `Intro de ${anim.duration.toFixed(1)} s y luego se mantiene.`; return; }
  if (!anim.period) { el.textContent = ''; return; }
  const fit = fitLoop(anim, state.seconds, state.speed);
  el.textContent = `Bucle perfecto: ${fit.cycles} ciclo${fit.cycles > 1 ? 's' : ''} en ${state.seconds} s (velocidad ajustada a ${fit.speed.toFixed(2)}x).`;
}

function initDragDrop() {
  const stageEl = $('#stage');
  let depth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); if (++depth === 1) stageEl.classList.add('dragging'); });
  window.addEventListener('dragleave', e => { e.preventDefault(); if (--depth === 0) stageEl.classList.remove('dragging'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    depth = 0;
    stageEl.classList.remove('dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file) openFile(file);
  });
  window.addEventListener('paste', e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) openFile(item.getAsFile());
  });
}

function init() {
  initSliders();
  initMaterials();
  initAnimations();
  initBackgrounds();
  chips('#lighting', LIGHTING, 'lighting', l => stage.setLighting(l.id, state.lightGain));
  chips('#floors', FLOORS, 'floor', f => stage.setFloor(f.id));
  chips('#cameras', CAMERA_MOVES, 'camMove', c => { stage.cameraMove = c.id; camClock = 0; });
  segmented('#side-mode', 'sideMode', () => { applyMaterials(); syncColorRows(); });
  segmented('#format', 'format', syncExportOpts);
  segmented('#res', 'res');
  segmented('#aspect', 'aspect', () => { layoutViewport(); frameCamera(); });
  segmented('#fps', 'fps');

  $('#color').value = state.color;
  $('#color').addEventListener('input', e => { state.color = e.target.value; applyMaterials(); save(); });
  $('#side-color').value = state.sideColor;
  $('#side-color').addEventListener('input', e => { state.sideColor = e.target.value; applyMaterials(); save(); });
  $('#particles').checked = state.particles;
  $('#particles').addEventListener('change', e => { state.particles = e.target.checked; stage.setParticles(state.particles, state.density); save(); });
  $('#transparent').checked = state.transparent;
  $('#transparent').addEventListener('change', e => { state.transparent = e.target.checked; save(); });

  const fileInput = $('#file');
  $('#btn-open').onclick = () => fileInput.click();
  $('#drop').onclick = () => fileInput.click();
  fileInput.onchange = () => { openFile(fileInput.files[0]); fileInput.value = ''; };
  const makeText = () => {
    const text = $('#text-input').value.trim();
    if (!text) return;
    loadCanvas(textLogo(text, $('#font-select').value, state.color), `Texto «${text}»`, true);
  };
  $('#btn-text').onclick = makeText;
  $('#text-input').addEventListener('keydown', e => { if (e.key === 'Enter') makeText(); });
  $('#btn-export').onclick = runExport;
  $('#btn-cancel').onclick = () => { cancelExport = true; };
  canvas.addEventListener('dblclick', frameCamera);
  setTimeout(() => { $('.hint').style.opacity = 0; }, 6000);
  initDragDrop();

  stage.setUserScale(state.scale);
  applySceneToEngine();
  syncColorRows();
  syncExportOpts();
  updateLoopNote();
  layoutViewport();

  loadCanvas(demoLogo(), 'Logo de ejemplo', false);
  requestAnimationFrame(tick);
  window.__engineReady = true;
  host.post({ type: 'ready' });
}

try {
  init();
} catch (e) {
  console.error(e);
  host.post({ type: 'engine-error', message: e.message || String(e) });
}

// Handy for debugging from DevTools (F12 in debug builds).
window.__app = { state, stage, THREE, get logo() { return logo; }, resetPose };
