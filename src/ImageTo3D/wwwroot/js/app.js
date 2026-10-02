// App controller: UI state ↔ engine.
import * as THREE from 'three';
import { inkField, marchingSquares, buildOutlines } from './trace.js';
import { shapesFromOutlines, buildLogoGroup, buildColorCanvas } from './geometry.js';
import { MATERIALS, createMaterials, disposeMaterials } from './materials.js';
import { ANIMATIONS, getAnimation, poseAt, fitLoop, resetPose } from './animations.js';
import { Stage, LIGHTING, FLOORS, CAMERA_MOVES, BACKGROUNDS } from './stage.js';
import { exportVideo, exportPNG, exportGLB, exportSTL, download } from './exporter.js';
import { host } from './host.js';
import { demoLogo, textLogo } from './sources.js';

const $ = sel => document.querySelector(sel);

// ───────── state ─────────
const DEFAULTS = {
  depth: 0.4, bevel: 0.03, smooth: 2, scale: 1,
  material: 'logo', color: '#c8f55a', sideMode: 'logo', sideColor: '#1c1c24',
  anim: 'rotate-y', animTab: 'loop', speed: 1,
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
let source = null;     // { name, trace, rawLoops, colorTex, shapeSet }
let logo = null;       // THREE.Group of piece meshes
let materials = [];
let exporting = false, cancelExport = false;

// ───────── source loading ─────────
async function loadSource(img, name, thumbUrl) {
  const t0 = performance.now();
  const trace = inkField(img);
  const rawLoops = marchingSquares(trace);
  const outlines = buildOutlines(rawLoops, trace, state.smooth);
  if (!outlines.length) {
    toast('No se pudo encontrar la forma del logo. Prueba con un PNG transparente o con más contraste.', 'error');
    return;
  }
  const colorTex = new THREE.CanvasTexture(buildColorCanvas(img));
  colorTex.flipY = false;               // planar UVs run top→bottom like canvas rows
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.anisotropy = stage.renderer.capabilities.getMaxAnisotropy();

  if (source?.colorTex) source.colorTex.dispose();
  source = { name, trace, rawLoops, colorTex };
  source.shapeSet = shapesFromOutlines(outlines, trace);
  rebuildMeshes();
  stage.frame();
  setThumb(thumbUrl);
  updateHud(performance.now() - t0);
}

function rebuildOutlines() {
  if (!source) return;
  const outlines = buildOutlines(source.rawLoops, source.trace, state.smooth);
  if (!outlines.length) return;
  source.shapeSet = shapesFromOutlines(outlines, source.trace);
  rebuildMeshes();
  updateHud();
}

function rebuildMeshes() {
  if (!source) return;
  const old = logo;
  logo = buildLogoGroup(source.shapeSet, { depth: state.depth, bevel: state.bevel, smoothness: state.smooth });
  applyMaterials();
  stage.setLogo(logo);
  stage.updateFloorHeight(!!getAnimation(state.anim).tall);
  if (old) old.traverse(o => o.geometry?.dispose());
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
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(file, url);
    let src = img;
    // Vectors are rasterised big so the tracer sees crisp edges whatever the SVG's own size.
    if (file.type === 'image/svg+xml' || !img.width) {
      const w = img.naturalWidth || img.width || 1024, h = img.naturalHeight || img.height || 1024;
      const k = 2048 / Math.max(w, h);
      src = document.createElement('canvas');
      src.width = Math.round(w * k); src.height = Math.round(h * k);
      src.getContext('2d').drawImage(img, 0, 0, src.width, src.height);
    }
    await loadSource(src, file.name, url);
    toast(`«${file.name}» convertido a 3D`);
  } catch (e) {
    console.error(e);
    toast('No se pudo leer la imagen.', 'error');
  }
}

/** Raster formats decode off the main thread; SVG needs an <img> to rasterise.
 *  (img.decode() is avoided: it can stall while the window is hidden.) */
async function loadImage(file, url) {
  if (file.type !== 'image/svg+xml') {
    try { return await createImageBitmap(file); } catch { /* fall back to <img> */ }
  }
  const img = new Image();
  await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(new Error('decode')); img.src = url; });
  return img;
}

function setThumb(url) {
  const drop = $('#drop');
  if (!url) { drop.classList.remove('has-thumb'); return; }
  drop.classList.add('has-thumb');
  drop.innerHTML = `<img src="${url}" alt=""><small>Clic o arrastra para cambiar</small>`;
}

function updateHud(ms) {
  if (!logo) return;
  let tris = 0;
  logo.children.forEach(m => { tris += m.geometry.attributes.position.count / 3; });
  const t = ms != null ? ` · <b>${Math.round(ms)}</b> ms` : '';
  $('#hud').innerHTML = `${source.name} · <b>${logo.children.length}</b> piezas · <b>${Math.round(tris / 1000)}k</b> triángulos${t}`;
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
    input.value = state[key];
    paint();
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

function initAnimations() {
  const render = () => chips('#animations', ANIMATIONS.filter(a => a.kind === state.animTab || a.id === 'none'), 'anim', a => {
    animClock = 0;
    stage.updateFloorHeight(!!a.tall);
    updateLoopNote();
  });
  segmented('#anim-tabs', 'animTab', render);
  render();
}

function initBackgrounds() {
  const el = $('#backgrounds');
  BACKGROUNDS.forEach(bg => {
    const b = document.createElement('div');
    b.className = 'bg' + (state.bg === bg.id ? ' on' : '');
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
  segmented('#aspect', 'aspect', () => { layoutViewport(); stage.frame(); });
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
    loadSource(textLogo(text, $('#font-select').value, state.color), `Texto «${text}»`, null);
  };
  $('#btn-text').onclick = makeText;
  $('#text-input').addEventListener('keydown', e => { if (e.key === 'Enter') makeText(); });
  $('#btn-export').onclick = runExport;
  $('#btn-cancel').onclick = () => { cancelExport = true; };
  canvas.addEventListener('dblclick', () => stage.frame());
  setTimeout(() => { $('.hint').style.opacity = 0; }, 6000);
  initDragDrop();

  stage.setLighting(state.lighting, state.lightGain);
  stage.setBackground((BACKGROUNDS.find(b => b.id === state.bg) || BACKGROUNDS[0]).spec);
  stage.setFloor(state.floor);
  stage.setBloom(state.bloom, state.bloomTh);
  stage.setParticles(state.particles, state.density);
  stage.cameraMove = state.camMove;
  stage.setUserScale(state.scale);
  syncColorRows();
  syncExportOpts();
  updateLoopNote();
  layoutViewport();

  loadSource(demoLogo(), 'Logo de ejemplo', null);
  requestAnimationFrame(tick);
}

init();

// Handy for debugging from DevTools (F12 in debug builds).
window.__app = { state, stage, THREE, get logo() { return logo; }, resetPose };
