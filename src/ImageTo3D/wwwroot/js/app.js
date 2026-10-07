// App controller: UI state ↔ engine.
import * as THREE from 'three';
import { DEFAULT_MASK } from './trace.js';
import { shapesFromOutlines, buildLogoGroup } from './geometry.js';
import { decodeImage, previewBitmap, ImageTooLargeError, LIMITS } from './imaging.js';
import { pipeline } from './pipeline.js';
import { initMaskUI } from './mask-ui.js';
import { initMaskEditor } from './mask-editor.js';
import { store } from './store.js';
import { History, workSettings, serializeProject, readProjectFile, PROJECT_EXT } from './project.js';
import { MATERIALS, createMaterials, disposeMaterials } from './materials.js';
import { ANIMATIONS, getAnimation, poseAt, fitLoop, resetPose, stillTime, fx, migrateAnimationSettings } from './animations.js';
import { renderSequencePanel, sequenceParts, sequenceTimeline } from './sequence-ui.js';
import { initUpdates } from './update-ui.js';
import { PRESETS, matchesPreset } from './presets.js';
import { Stage, LIGHTING, FLOORS, CAMERA_MOVES, BACKGROUNDS } from './stage.js';
import { exportVideo, exportPngSequence, exportAvi, exportPNG, exportGLB, exportSTL, download, checkVideoSupport, estimateBytes, animationFileName } from './exporter.js';
import { openSink } from './filesink.js';
import { SIZES, sizeOf, evenClamp, migrateSettings } from './formats.js';
import { host } from './host.js';
import { demoLogo, textLogo } from './sources.js';
import { parseVectorSvg, vectorVerdict, vectorLayout, vectorTexture, vectorOutlines, vectorPreview } from './vector.js';
import { renderLayersPanel } from './layers-ui.js';
import { initRelief, reliefOptions } from './relief-ui.js';

const $ = sel => document.querySelector(sel);

// ───────── state ─────────
const DEFAULTS = {
  depth: 0.4, bevel: 0.03, smooth: 2, scale: 1,
  material: 'logo', color: '#c8f55a', sideMode: 'logo', sideColor: '#1c1c24',
  anim: 'rotate-y', animTab: 'preset', speed: 1,
  mode: 'single', seqIntro: 'intro-pop', seqLoop: 'rotate-y', seqReps: 2, seqOutro: 'outro-shrink', seqTransition: 0.6, seqLoopSpeed: 1,
  lighting: 'studio', lightGain: 1, floor: 'shadow', bg: 'vignette', camMove: 'none', camAmount: 1,
  bloom: 0, bloomTh: 0.85, bloomRadius: 0.35, particles: false, density: 1,
  lightAz: 0, lightEl: 0, shine: false, shineGain: 1,
  format: 'mp4', aviCodec: 'mjpg', size: 'yt', customW: 1920, customH: 1080, fps: '30', seconds: 6, stlWidth: 100,
};
/** Settings from older versions (sizes, chained intro / outro) brought up to date. */
const migrate = s => migrateAnimationSettings(migrateSettings(s));
const STORE_KEY = 'imageto3d.settings.v1';
const state = { ...DEFAULTS };
try { Object.assign(state, migrate(JSON.parse(localStorage.getItem(STORE_KEY) || '{}'))); } catch { /* fresh start */ }
const save = () => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  markDirty();
};

// ───────── engine ─────────
const canvas = $('#canvas');
const stage = new Stage(canvas);
let source = null;     // { name, blob, thumbUrl, mask, meta, key, colorTex, outlines, shapeSet, before, after, vector, vectorNote }
let logo = null;       // THREE.Group of piece meshes
let materials = [];
let exporting = false, cancelExport = false;
let maskUI = null, maskEditor = null, reliefUI = null;

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
    // An SVG is also read as vectors; the raster still goes to the worker, so "trace it as
    // an image" stays one switch away.
    const vecJob = blob?.type === 'image/svg+xml' ? buildVector(blob) : null;
    const r = await pipeline.load(bitmap, mask, state.smooth);
    const vec = await vecJob;
    if (job !== pipeJob) { r.color?.close(); r.after?.close(); before.close(); return false; }
    disposeSource();
    // The worker now holds this image, so it becomes the source even when nothing was
    // found: the mask controls are how the user fixes that.
    source = { name, blob, thumbUrl, mask: { ...DEFAULT_MASK, ...mask }, before,
      vector: vec?.parsed ? vec : null, vectorNote: vec?.note || null };
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

/** The SVG's own paths, layers and colour texture, or { note } saying why they can't be used. */
async function buildVector(blob) {
  try {
    const parsed = parseVectorSvg(await blob.text());
    const verdict = vectorVerdict(parsed);
    if (!verdict.ok) return { note: verdict.reason };
    const L = vectorLayout(parsed);
    const tex = await vectorTexture(parsed, L);
    return { parsed, L, color: tex.color, layers: tex.layers };
  } catch (e) {
    console.warn('SVG vector import failed:', e);
    return { note: 'no se pudo leer como vector' };
  }
}

/** True while the current source is built from SVG paths rather than traced. */
const usingVector = () => !!(source?.vector && source.mask.vector !== false);

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
  if (usingVector()) applyVector();
  source.shapeSet = shapesFromOutlines(source.outlines, source.meta);
}

/** Swaps the traced result for the SVG's own: outlines, colour texture and preview. */
function applyVector() {
  const v = source.vector;
  if (source.colorTex?.image !== v.color) {
    source.colorTex?.image?.close?.();
    source.colorTex?.dispose();
    const tex = new THREE.Texture(v.color);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = stage.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    source.colorTex = tex;
  }
  source.meta = { w: v.L.w, h: v.L.h, W: v.L.w + 2, H: v.L.h + 2 };
  source.outlines = vectorOutlines(v.parsed, v.L, state.smooth);
  source.after?.close();
  source.after = vectorPreview(v.color, source.outlines, v.L);
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

// Dragging a slider fires many changes; only one retrace runs at a time and, while it
// runs, further requests collapse into a single follow-up (a 'mask' one wins, as it
// includes the 'outlines' step).
let retraceRunning = false, retraceNext = null;
function requestRetrace(op) {
  retraceNext = retraceNext === 'mask' || op === 'mask' ? 'mask' : 'outlines';
  if (retraceRunning) return;
  retraceRunning = true;
  (async () => {
    try {
      while (retraceNext) { const next = retraceNext; retraceNext = null; await retrace(next); }
    } finally {
      retraceRunning = false;
    }
  })();
}

function rebuildOutlines() { requestRetrace('outlines'); }

/** Anything that mirrors the current source (previews, autosave) refreshes from here. */
function onSourceChanged() {
  maskUI?.refresh();
  maskEditor?.refresh();
  reliefUI?.refresh();
  renderLayers();
  markDirty();
}

// ───────── layers ─────────
/** The current source's layers: an SVG's (paint-order colour runs) or the traced colours. */
function sourceLayers() {
  if (!source) return [];
  const count = layer => source.outlines?.filter(o => (o.layer ?? 0) === layer).length || 0;
  const pieces = n => `${n} pieza${n === 1 ? '' : 's'}`;
  if (usingVector()) return source.vector.layers.map((l, i) => ({ index: i, color: l.color, gradient: !!l.gradient, detail: pieces(count(i)) }));
  return (source.meta?.layers || []).map((l, i) => ({ index: i, color: l.color, detail: `${Math.round(l.share * 100)} %` }));
}

/** Per-layer settings, only while the logo actually has several layers. */
function layerStyleOf(layer) {
  return { depth: 1, visible: true, material: null, ...(source?.mask.layerStyle?.[layer] || {}) };
}
const hasLayers = () => sourceLayers().length > 1;

function renderLayers() {
  const box = $('#layers-panel');
  if (!box) return;
  $('#layers-sec').hidden = !source;
  if (!source) return;
  renderLayersPanel(box, {
    layers: sourceLayers(),
    raster: !usingVector(),
    split: !!source.mask.split,
    colors: source.mask.colors ?? 'auto',
  }, layerStyleOf, {
    // Changing how layers are found renumbers them: their settings start over.
    split: on => { Object.assign(source.mask, { split: on, layerStyle: {} }); requestRetrace('mask'); markDirty(); },
    colors: v => { Object.assign(source.mask, { colors: v, layerStyle: {} }); requestRetrace('mask'); markDirty(); },
    style: (layer, patch, geometry) => {
      const all = { ...(source.mask.layerStyle || {}) };
      all[layer] = { ...layerStyleOf(layer), ...patch };
      source.mask.layerStyle = all;
      if (geometry) { rebuildMeshes(); updateHud(); } else applyMaterials();
      renderLayers();
      markDirty();
    },
  });
}

function rebuildMeshes() {
  if (!source) return;
  const old = logo;
  logo = buildLogoGroup(source.shapeSet, { depth: state.depth, bevel: state.bevel, smoothness: state.smooth,
    layerStyle: hasLayers() ? layerStyleOf : null, relief: reliefOptions(source) });
  applyMaterials();
  stage.setLogo(logo);
  updateFloorForAnim();
  if (old) old.traverse(o => o.geometry?.dispose());
  invalidateThumbs();
}

/** The logo at rest, turned three-quarters, drawn into a 2D canvas (the relief editor's preview). */
function renderStillInto(target) {
  if (!logo) return;
  const restore = stage.beginFixedSize(target.width, target.height);
  resetPose(stage.motion, logo.children);
  stage.motion.rotation.set(-0.3, 0.55, 0);
  stage.render(0);
  const g = target.getContext('2d');
  g.clearRect(0, 0, target.width, target.height);
  g.drawImage(stage.renderer.domElement, 0, 0, target.width, target.height);
  stage.motion.rotation.set(0, 0, 0);
  restore();
}

/** Pushes every scene setting in `state` to the engine (used by presets and on start-up). */
function applySceneToEngine() {
  stage.setLighting(state.lighting, state.lightGain);
  stage.setBackground((BACKGROUNDS.find(b => b.id === state.bg) || BACKGROUNDS[0]).spec);
  syncTransparency();
  stage.setFloor(state.floor);
  stage.setBloom(state.bloom, state.bloomTh, state.bloomRadius);
  stage.setLightAngle(state.lightAz, state.lightEl);
  stage.setShine(state.shine, state.shineGain);
  stage.setParticles(state.particles, state.density);
  stage.cameraMove = state.camMove;
  stage.cameraAmount = state.camAmount;
  updateFloorForAnim();
  applyMaterials();
}

/** The checkerboard behind the viewport and the export notes follow the "Transparente" background. */
function syncTransparency() {
  $('#viewport').classList.toggle('transparent', stage.transparent);
  updateExportEstimate();
}

function applyMaterials() {
  if (!logo) return;
  const old = materials;
  const opts = { logoMap: source?.colorTex, color: state.color, sideMode: state.sideMode, sideColor: state.sideColor };
  const base = createMaterials(state.material, opts);
  // With layers, each piece is one colour. A layer with its own material takes that colour as
  // the tint (plastic in that colour…), and "logo colours" are drawn flat in it, faces and
  // side walls: sampling the artwork right at a layer's edge would mix in the neighbour's
  // colour and leave a thin line. Only an SVG gradient keeps the artwork on its face.
  const sets = new Map();
  const layerInfo = sourceLayers();
  const forLayer = layer => {
    if (!hasLayers()) return base;
    const info = layerInfo[layer] || {}, color = info.color || state.color;
    const id = layerStyleOf(layer).material || state.material;
    const key = id + color;
    if (sets.has(key)) return sets.get(key);
    // As dim as the textured walls are (×0.72), so a layered logo reads the same.
    const sides = state.sideMode === 'logo' ? { sideMode: 'custom', sideColor: '#' + new THREE.Color(color).multiplyScalar(0.72).getHexString() } : {};
    const mats = createMaterials(id, { ...opts, ...sides, ...(layerStyleOf(layer).material ? { color } : {}) });
    if (id === 'logo' && !info.gradient) { mats[0].map = null; mats[0].color.set(color); mats[0].needsUpdate = true; }
    sets.set(key, mats);
    return mats;
  };
  logo.children.forEach(m => { m.material = forLayer(m.userData.layer ?? 0); });
  materials = [...base, ...[...sets.values()].flat()];
  new Set(materials).forEach(m => stage.decorateMaterial(m));
  if (old.length) disposeMaterials(old);
}

async function openFile(file) {
  openGeneration++;
  if (file?.name?.toLowerCase().endsWith('.' + PROJECT_EXT)) return openProjectFile(file);
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
  startProject();
  if (usingVector()) {
    const layers = new Set(source.outlines.map(o => o.layer)).size;
    toast(`«${file.name}» importado como vector: ${source.outlines.length} formas en ${layers} capa${layers > 1 ? 's' : ''}` +
      (source.vector.parsed.report.strokes ? '. Los trazos (stroke) del SVG no se convierten: pásalos a relleno o usa «Trazar como imagen» en Recorte.' : ''));
    return;
  }
  if (source.vectorNote) { toast(`«${file.name}»: ${source.vectorNote}, así que se traza como imagen.`); return; }
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
  const parts = [`${source.name} · `, ...(usingVector() ? [['b', 'vectorial'], ' · '] : []),
    ['b', String(logo.children.length)], ' piezas · ', ['b', `${Math.round(tris / 1000)}k`], ' triángulos'];
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
  // A chained clip (intro → loop → outro) previews exactly what will be exported, on the camera's clock.
  const tl = currentTimeline(), clip = clipSeconds();
  if (tl) tl.pose(camClock % clip, stage.motion, logo.children);
  else poseAt(getAnimation(state.anim), animClock, stage.motion, logo.children, false);
  stage.render((camClock % clip) / clip);
}

// ───────── layout: letterboxed viewport in the export aspect ─────────
function layoutViewport() {
  const box = $('#stage').getBoundingClientRect();
  const [aw, ah] = sizeOf(state);
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
  return sizeOf(state);
}

// Animated outputs share one path: video (MP4 / WebM) or a PNG sequence in a ZIP.
const ANIMATED = { mp4: 'vídeo MP4', webm: 'vídeo WebM', avi: 'vídeo AVI', 'avi-rgba': 'AVI sin compresión', pngseq: 'secuencia PNG' };
// Outputs without an alpha channel: a transparent background comes out black.
const NO_ALPHA = new Set(['mp4', 'avi']);
/** What will be written: the format, with AVI split by codec (Motion JPEG or RGB + alpha). */
const outputKind = () => state.format === 'avi' && state.aviCodec === 'rgba' ? 'avi-rgba' : state.format;

async function runExport() {
  if (!logo || exporting) return;
  if (!logo.children.length) { toast(NO_SHAPE_MSG, 'error'); return; }
  const fmt = state.format, kind = outputKind();
  try {
    if (fmt === 'glb') { const r = await exportGLB(logo, state.scale); download(r.blob, r.filename); return; }
    if (fmt === 'stl') { const r = exportSTL(logo, state.stlWidth); download(r.blob, r.filename); return; }

    const [w, h] = exportDims();
    const anim = getAnimation(state.anim);
    const fps = Number(state.fps), seconds = clipSeconds();
    let sink = null;
    if (ANIMATED[kind]) {
      const support = await checkVideoSupport(stage.renderer, kind, w, h, fps);
      if (!support.ok) { toast(support.reason, 'error'); return; }
      if (host.isDesktop) {
        // Where to save is asked first, then the file streams to disk as it renders.
        sink = await openSink(animationFileName(kind, w, h));
        if (!sink) return;
      } else if (estimateBytes(kind, w, h, fps, seconds, stage.transparent) > 1.5 * 1024 ** 3) {
        toast('Eso pasaría de 1,5 GB y en el navegador se monta entero en memoria. Acórtalo o usa la app de escritorio.', 'error');
        return;
      }
    }
    exporting = true;
    const restore = stage.beginFixedSize(w, h);
    try {
      if (fmt === 'png') {
        const r = await exportPNG({
          canvas, width: w, height: h,
          renderFrame: () => {
            poseAt(anim, anim.kind === 'intro' ? anim.duration : animClock, stage.motion, logo.children, true);
            stage.render((camClock % seconds) / seconds);
          },
        });
        download(r.blob, r.filename);
        return;
      }

      const fit = fitLoop(anim, seconds, state.speed);
      const tl = currentTimeline();
      cancelExport = false;
      showProgress(`Renderizando ${ANIMATED[kind]}${stage.transparent && !NO_ALPHA.has(kind) ? ' con transparencia' : ''} · ${w}×${h} · ${fps} fps…`);
      const started = performance.now();
      const job = {
        canvas, renderer: stage.renderer, kind: fmt, codec: state.aviCodec, alpha: stage.transparent, width: w, height: h, fps, seconds, sink,
        renderFrame: (i, t) => {
          if (tl) tl.pose(t, stage.motion, logo.children);
          else poseAt(anim, t * fit.speed, stage.motion, logo.children, true);
          stage.render(t / seconds);
        },
        onProgress: p => setProgress(p, started),
        isCancelled: () => cancelExport,
      };
      try {
        const r = fmt === 'pngseq' ? await exportPngSequence(job) : fmt === 'avi' ? await exportAvi(job) : await exportVideo(job);
        if (!r) { await sink?.abort(); toast('Exportación cancelada'); return; }
        rememberRenderRate(kind, w * h * seconds * fps, performance.now() - started);
        updateExportEstimate();
        // Streamed files are announced by the host ("saved", with "Mostrar en carpeta").
        if (r.blob) download(r.blob, animationFileName(kind, w, h));
      } catch (e) {
        await sink?.abort().catch(() => {});
        throw e;
      }
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
function setProgress(p, started) {
  $('#progress-bar').style.width = (p * 100).toFixed(1) + '%';
  let text = Math.round(p * 100) + '%';
  const elapsed = started ? (performance.now() - started) / 1000 : 0;
  if (p > 0.03 && p < 1 && elapsed > 1) text += ` · quedan ${formatDuration(elapsed / p * (1 - p))}`;
  $('#progress-text').textContent = text;
}

const formatDuration = s => s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
const formatBytes = b => b < 1024 ** 3 ? `${Math.max(1, Math.round(b / 1024 ** 2))} MB` : `${(b / 1024 ** 3).toFixed(1)} GB`;

// Render speed of the last export of each kind (output pixels per second), to predict the next.
const RATE_KEY = 'imageto3d.renderRate.';
function rememberRenderRate(kind, pixels, ms) {
  try { localStorage.setItem(RATE_KEY + kind, String(pixels / (ms / 1000))); } catch { /* ignore */ }
}

const FORMAT_NOTES = {
  webm: 'Con el fondo «Transparente» el vídeo lleva canal alfa: navegadores, OBS, DaVinci Resolve, Shotcut, Kdenlive.',
  pngseq: 'Una imagen PNG por fotograma, en un ZIP: transparencia sin pérdidas para Premiere, After Effects o DaVinci, y mucho más ligera que el AVI sin compresión.',
  avi: 'AVI con Motion JPEG: se abre en casi cualquier reproductor o editor, también en programas antiguos. Ocupa más que un MP4.',
  'avi-rgba': 'Sin compresión, RGB + alfa (32 bits): lo mismo que After Effects con el códec «Ninguno» y Canales «RGB + alfa». After Effects, Premiere y DaVinci lo importan con la transparencia (si After Effects pregunta, alfa «Directo»). Ocupa mucho: unos 8 MB por fotograma en 1080p.',
};

/** Size / frames / time estimate and the hardware check, under the animation options. */
async function updateExportEstimate() {
  const el = $('#export-estimate'), note = $('#format-note');
  if (!el) return;
  const kind = outputKind();
  note.textContent = FORMAT_NOTES[kind] || '';
  note.classList.remove('warn');
  if (stage.transparent && NO_ALPHA.has(kind)) {
    note.textContent = kind === 'avi'
      ? 'El AVI en Motion JPEG no admite transparencia: el fondo saldrá negro. Para conservarla elige «Sin compresión + alfa» (After Effects, Premiere, DaVinci).'
      : 'El MP4 no admite transparencia: el fondo saldrá negro. Para conservarla usa WebM, AVI sin compresión o Secuencia PNG.';
    note.classList.add('warn');
  }
  if (!ANIMATED[kind]) return;
  const seconds = clipSeconds();
  const [w, h] = exportDims(), fps = Number(state.fps), frames = Math.round(seconds * fps);
  const parts = [`≈ ${formatBytes(estimateBytes(kind, w, h, fps, seconds, stage.transparent))}`, `${frames} fotogramas`];
  const rate = Number(localStorage.getItem(RATE_KEY + kind));
  if (rate > 0) parts.push(`unos ${formatDuration(w * h * frames / rate)} de render`);
  el.textContent = parts.join(' · ');
  el.classList.remove('warn');
  const support = await checkVideoSupport(stage.renderer, kind, w, h, fps);
  if (outputKind() !== kind) return;
  $('#btn-export').disabled = !support.ok;
  if (!support.ok) { el.textContent = support.reason; el.classList.add('warn'); }
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

// ───────── projects, recents, undo / redo ─────────
// The work (image + mask + settings) is autosaved to IndexedDB a moment after every
// change, which is both the "Recientes" list and the recovery after a restart or a
// crash. Undo / redo keeps snapshots of settings and mask for the current project.
const history = new History();
let projectId = null;          // IndexedDB id of the current work (null: the demo, never stored)
let historyTimer = 0, autosaveTimer = 0, restoring = false;
// Bumped by every explicit open, so a start-up session restore still in flight backs off
// (e.g. a project double-clicked in Explorer must win over the last session).
let openGeneration = 0;

function snapshot() {
  return source ? { settings: workSettings(state), mask: { ...source.mask }, src: { blob: source.blob, name: source.name } } : null;
}

function flushHistory() {
  if (!historyTimer) return;
  clearTimeout(historyTimer);
  historyTimer = 0;
  if (restoring) return;
  const s = snapshot();
  if (s && history.push(s)) syncUndoUI();
}

/** Something about the work changed: record it for undo and schedule an autosave. */
function markDirty() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(flushHistory, 400);
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosave, 1500);
}

function cameraState() {
  return { p: stage.camera.position.toArray(), t: stage.controls.target.toArray() };
}

function applyCamera(c) {
  if (!c?.p || !c?.t) return;
  stage.camera.position.fromArray(c.p);
  stage.controls.target.fromArray(c.t);
  stage.controls.update();
}

/** A small JPEG of what the viewport shows, for the recent-projects menu. */
async function viewportThumb() {
  const c = new OffscreenCanvas(256, 144), g = c.getContext('2d');
  const k = Math.max(256 / canvas.width, 144 / canvas.height);
  const w = canvas.width * k, h = canvas.height * k;
  g.drawImage(canvas, (256 - w) / 2, (144 - h) / 2, w, h);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

async function autosave() {
  if (!source || !projectId || exporting) return;
  const id = projectId;
  try {
    if (source.storedAs !== id) { await store.putImage(id, source.blob); source.storedAs = id; }
    await store.putProject({
      id, name: source.name, updatedAt: Date.now(), thumb: await viewportThumb(),
      settings: workSettings(state), mask: { ...source.mask }, camera: cameraState(), imageName: source.name,
    });
    await store.prune();
  } catch (e) {
    console.warn('autosave failed:', e);
  }
}

/** New work: fresh project id and an empty undo history. */
function startProject(id = crypto.randomUUID()) {
  projectId = id;
  history.clear();
  syncUndoUI();
  markDirty();
}

/** Applies a whole set of work settings at once (projects, undo / redo). */
function applySettings(s) {
  const prev = { ...state };
  Object.assign(state, workSettings({ ...DEFAULTS, ...migrate(s) }));
  stage.setUserScale(state.scale);
  applySceneToEngine();
  syncSceneUI();
  segSyncs.forEach(fn => fn());
  syncSizeUI();
  syncExportOpts();
  if (String(sizeOf(prev)) !== String(sizeOf(state))) layoutViewport();
  if (logo && (prev.depth !== state.depth || prev.bevel !== state.bevel)) rebuildMeshes();
  if (source && prev.smooth !== state.smooth) requestRetrace('outlines');
  save();
}

async function openProjectData(p, id, generation = ++openGeneration) {
  let decoded;
  try {
    decoded = await decodeImage(new File([p.image.blob], p.image.name, { type: p.image.blob.type }));
  } catch (e) {
    toast(e instanceof ImageTooLargeError ? e.message : 'No se pudo leer la imagen del proyecto.', 'error');
    return false;
  }
  if (generation !== openGeneration) { decoded.bitmap.close(); return false; }
  // Settings first, so the first trace already uses the project's smoothing.
  applySettings(p.settings);
  const ok = await loadSource(decoded.bitmap, {
    name: p.name, blob: p.image.blob, thumbUrl: URL.createObjectURL(p.image.blob), mask: p.mask,
  });
  if (!ok) return false;
  if (id) source.storedAs = id;   // the image is already in IndexedDB under this id
  startProject(id);
  applyCamera(p.camera);
  return true;
}

async function openProjectFile(file) {
  try {
    const p = await readProjectFile(file);
    if (await openProjectData(p)) toast(`Proyecto «${p.name}» abierto`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function openStored(id, generation = ++openGeneration) {
  const rec = await store.get(id);
  if (!rec || generation !== openGeneration) return false;
  const m = rec.meta;
  return openProjectData({ name: m.name, settings: m.settings, mask: m.mask, camera: m.camera, image: { name: m.imageName, blob: rec.blob } }, id, generation);
}

async function saveProjectFile() {
  if (!source) return;
  flushHistory();
  const text = await serializeProject({
    name: source.name, settings: workSettings(state), mask: source.mask, camera: cameraState(),
    image: { name: source.name, blob: source.blob },
  });
  const base = source.name.replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|«»]+/g, '').trim() || 'proyecto';
  download(new Blob([text], { type: 'application/json' }), `${base}.${PROJECT_EXT}`);
}

async function restoreEntry(entry) {
  if (!entry || !source) return;
  restoring = true;
  clearTimeout(historyTimer);
  historyTimer = 0;
  try {
    if (JSON.stringify(entry.mask) !== JSON.stringify(source.mask)) {
      // Replaced, not merged: keys the snapshot lacks (layer settings added since) must go.
      source.mask = { ...DEFAULT_MASK, ...entry.mask };
      requestRetrace('mask');
    }
    applySettings(entry.settings);
    maskUI.refresh();
  } finally {
    restoring = false;
    syncUndoUI();
  }
}

function undo() { flushHistory(); restoreEntry(history.undo()); }
function redo() { flushHistory(); restoreEntry(history.redo()); }

function syncUndoUI() {
  $('#btn-undo').disabled = !history.canUndo;
  $('#btn-redo').disabled = !history.canRedo;
}

async function toggleRecentMenu(open) {
  const menu = $('#recent-menu'), btn = $('#btn-recent');
  if (open === undefined) open = menu.hidden;
  menu.querySelectorAll('img').forEach(i => URL.revokeObjectURL(i.src));
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (!open) return;
  flushHistory();
  await autosave();
  let list = [];
  try { list = await store.list(); } catch { /* no storage: empty list */ }
  const items = list.map(p => {
    const row = document.createElement('div');
    row.className = 'recent' + (p.id === projectId ? ' current' : '');
    const open = document.createElement('button');
    open.className = 'recent-open';
    const img = document.createElement('img');
    img.alt = '';
    if (p.thumb) img.src = URL.createObjectURL(p.thumb);
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = p.name;
    const when = document.createElement('span');
    when.className = 'recent-when';
    when.textContent = new Date(p.updatedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
    open.append(img, name, when);
    open.onclick = async () => { toggleRecentMenu(false); if (p.id !== projectId && !(await openStored(p.id))) toast('No se pudo abrir ese proyecto.', 'error'); };
    const del = document.createElement('button');
    del.className = 'recent-del';
    del.title = 'Quitar de recientes';
    del.setAttribute('aria-label', `Quitar ${p.name} de recientes`);
    del.textContent = '×';
    del.onclick = async () => { await store.remove(p.id); if (p.id === projectId) projectId = null; row.remove(); };
    row.append(open, del);
    return row;
  });
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = 'Aún no hay proyectos. Se guardan solos mientras trabajas.';
    items.push(empty);
  }
  menu.replaceChildren(...items);
}

function initShortcuts() {
  addEventListener('keydown', e => {
    if (e.key === 'Escape') { toggleRecentMenu(false); return; }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    // Typing in a text box keeps its own undo.
    const t = e.target;
    if (t.matches?.('input[type=text], textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); saveProjectFile(); }
    else if (k === 'o') { e.preventDefault(); $('#file').click(); }
  });
}

/** Start-up: reopen the last work, or show the demo logo the very first time. */
async function restoreLastSession() {
  const generation = ++openGeneration;
  try {
    const [last] = await store.list();
    if (generation !== openGeneration) return;
    if (last && await openStored(last.id, generation)) return;
    if (generation !== openGeneration) return;
  } catch (e) {
    console.warn('no previous session:', e);
  }
  await loadCanvas(demoLogo(), 'Logo de ejemplo', false);
  projectId = null;
}

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
  bloom: () => stage.setBloom(state.bloom, state.bloomTh, state.bloomRadius),
  bloomTh: () => stage.setBloom(state.bloom, state.bloomTh, state.bloomRadius),
  bloomRadius: () => stage.setBloom(state.bloom, state.bloomTh, state.bloomRadius),
  shineGain: () => stage.setShine(state.shine, state.shineGain),
  camAmount: () => { stage.cameraAmount = state.camAmount; },
  density: () => stage.setParticles(state.particles, state.density, '#ffffff'),
  seconds: () => { updateLoopNote(); updateExportEstimate(); },
  speed: () => { updateLoopNote(); updateExportEstimate(); if (state.animTab === 'seq') renderAnimationList(); },
};

const sliderSync = {};   // key → re-reads state into the slider

function initSliders() {
  document.querySelectorAll('.slider[data-key]').forEach(el => {
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
      markDirty();   // here, not in the frame callback below: frames pause in a hidden window
      // Geometry rebuilds are throttled to one per frame while dragging.
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => { ON_CHANGE[key]?.(); save(); });
    });
    input.addEventListener('dblclick', () => { input.value = DEFAULTS[key]; input.dispatchEvent(new Event('input')); });
  });
}

/** Marks the picked option of a group: `.on` for the eye, aria-pressed for screen readers. */
function markPicked(container, id) {
  container.querySelectorAll(':scope > [data-id]').forEach(b => {
    const on = b.dataset.id === id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

/** A toggle button for a group of options (keyboard and screen reader friendly). */
function optionButton(cls, id, picked) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls + (picked ? ' on' : '');
  b.dataset.id = id;
  b.setAttribute('aria-pressed', String(picked));
  return b;
}

function chips(container, items, key, onPick, render = it => it.label) {
  const el = $(container);
  el.innerHTML = '';
  items.forEach(it => {
    const b = optionButton('chip', it.id, state[key] === it.id);
    b.innerHTML = render(it);
    b.onclick = () => {
      state[key] = it.id;
      markPicked(el, it.id);
      onPick(it);
      save();
    };
    el.appendChild(b);
  });
}

const segSyncs = [];   // re-read state into every segmented control

function segmented(id, key, onPick = () => {}) {
  const el = $(id);
  const sync = () => el.querySelectorAll('button').forEach(b => {
    const on = b.dataset.v === String(state[key]);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  segSyncs.push(sync);
  el.querySelectorAll('button').forEach(b => b.onclick = () => { state[key] = b.dataset.v; sync(); onPick(b.dataset.v); save(); });
  sync();
}

function initMaterials() {
  const el = $('#materials');
  el.innerHTML = '';
  MATERIALS.forEach(m => {
    const b = optionButton('swatch', m.id, state.material === m.id);
    const dot = document.createElement('i');
    dot.style.background = m.swatch;
    b.append(dot, m.label);
    b.onclick = () => {
      state.material = m.id;
      markPicked(el, m.id);
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
  el.classList.toggle('seq', state.animTab === 'seq');
  syncModeMarks();
  if (state.animTab === 'preset') { renderPresets(); return; }
  if (state.animTab === 'seq') {
    renderSequencePanel(el, state, {
      change: patch => { Object.assign(state, patch); useSequence(); },
      use: useSequence,
    });
    return;
  }
  chips('#animations', ANIMATIONS.filter(a => a.kind === state.animTab || a.id === 'none'), 'anim', a => {
    state.mode = 'single';   // picking a single animation leaves the sequence
    onAnimationChanged();
    if (a.round) stage.frame(true);
  }, a => a.pieces ? `${a.label}<span class="pc" title="Anima cada pieza por separado">▦</span>` : a.label);
}

/** Makes the "Secuencia" the active animation (after any change in its panel). */
function useSequence() {
  state.mode = 'sequence';
  onAnimationChanged();
  if (state.animTab === 'seq') renderAnimationList();
  save();
}

function onAnimationChanged() {
  animClock = 0;
  camClock = 0;
  updateFloorForAnim();
  syncModeMarks();
  syncDurationUI();
  updateLoopNote();
  updateExportEstimate();
}

/** A dot on the tab whose animation is in use: the sequence, or the single loop / intro. */
function syncModeMarks() {
  const single = getAnimation(state.anim).kind;
  document.querySelectorAll('#anim-tabs button').forEach(b => {
    b.classList.toggle('in-use', isSequence() ? b.dataset.v === 'seq' : b.dataset.v === single);
  });
}

const isSequence = () => state.mode === 'sequence';

/**
 * In sequence mode, the clip as intro → loop × N → outro (see timelineOf); null for a
 * single animation (which keeps its seamless-loop behaviour over "Duración").
 */
function currentTimeline() {
  return isSequence() ? sequenceTimeline(state) : null;
}

/** The clip's length: built from the sequence's parts, or the "Duración" setting. */
function clipSeconds() {
  const tl = currentTimeline();
  return tl ? Math.max(0.5, tl.clip) : state.seconds;
}

/** The floor drops for animations that sweep below the logo. */
function updateFloorForAnim() {
  const p = isSequence() ? sequenceParts(state) : null;
  stage.updateFloorHeight(!!(p ? (p.intro?.tall || p.loop?.tall || p.outro?.tall) : getAnimation(state.anim).tall));
}

/** "Duración" is a setting for single animations; a sequence's length comes from its parts. */
function syncDurationUI() {
  $('.slider[data-key="seconds"]').hidden = isSequence();
}

/** A representative pose for stills and thumbnails. */
function poseStill() {
  if (isSequence()) {
    const p = sequenceParts(state), a = p.loop || p.intro || p.outro;
    if (!a) return resetPose(stage.motion, logo.children);
    return poseAt(a, a.kind === 'outro' ? 0 : stillTime(a), stage.motion, logo.children, true);
  }
  const anim = getAnimation(state.anim);
  poseAt(anim, stillTime(anim), stage.motion, logo.children, true);
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
    const picked = matchesPreset(p, state);
    card.type = 'button';
    card.className = 'preset' + (picked ? ' on' : '');
    card.dataset.id = p.id;
    card.setAttribute('aria-pressed', String(picked));
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
  markPicked($('#materials'), state.material);
  markPicked($('#lighting'), state.lighting);
  markPicked($('#floors'), state.floor);
  markPicked($('#cameras'), state.camMove);
  markPicked($('#backgrounds'), state.bg);
  if (state.animTab === 'preset') document.querySelectorAll('#animations .preset').forEach(card => {
    const on = matchesPreset(PRESETS.find(p => p.id === card.dataset.id), state);
    card.classList.toggle('on', on);
    card.setAttribute('aria-pressed', String(on));
  });
  else renderAnimationList();
  Object.values(sliderSync).forEach(fn => fn());
  $('#color').value = state.color;
  $('#particles').checked = state.particles;
  $('#shine').checked = state.shine;
  syncLightPad();
  syncModeMarks();
  syncDurationUI();
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
    poseStill();
    stage.render(0.1);
    thumbs.set(p.id, canvas.toDataURL('image/jpeg', 0.82));
    restore();

    Object.assign(state, saved);
    applySceneToEngine();
    stage.camera.position.copy(cam);
    stage.controls.target.copy(target);
    stage.controls.update();
    poseAt(getAnimation(state.anim), animClock, stage.motion, logo.children, false);
    stage.render((camClock % clipSeconds()) / clipSeconds());

    const img = document.querySelector(`#animations .preset[data-id="${p.id}"] .thumb`);
    if (img) img.innerHTML = `<img src="${thumbs.get(p.id)}" alt="">`;
  }
}

// Light direction pad: horizontal = azimuth (−180°…180°), vertical = elevation (−40°…70°).
const AZ = [-180, 180], EL = [-40, 70];

function initLightPad() {
  const pad = $('#light-pad');
  const setFrom = e => {
    const r = pad.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const v = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    applyLight(AZ[0] + u * (AZ[1] - AZ[0]), EL[1] - v * (EL[1] - EL[0]));
  };
  let dragging = false;
  pad.addEventListener('pointerdown', e => { dragging = true; pad.setPointerCapture(e.pointerId); setFrom(e); });
  pad.addEventListener('pointermove', e => { if (dragging) setFrom(e); });
  pad.addEventListener('pointerup', () => { dragging = false; });
  pad.addEventListener('dblclick', () => applyLight(0, 0));
  pad.addEventListener('keydown', e => {
    const step = e.shiftKey ? 15 : 5;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (!moves[e.key]) return;
    e.preventDefault();
    applyLight(state.lightAz + moves[e.key][0], state.lightEl + moves[e.key][1]);
  });
  syncLightPad();
}

function applyLight(az, el) {
  state.lightAz = Math.round(Math.max(AZ[0], Math.min(AZ[1], az)));
  state.lightEl = Math.round(Math.max(EL[0], Math.min(EL[1], el)));
  stage.setLightAngle(state.lightAz, state.lightEl);
  syncLightPad();
  save();
}

function syncLightPad() {
  const u = (state.lightAz - AZ[0]) / (AZ[1] - AZ[0]), v = (EL[1] - state.lightEl) / (EL[1] - EL[0]);
  const dot = $('#light-dot');
  dot.style.left = (u * 100) + '%';
  dot.style.top = (v * 100) + '%';
  $('#light-read').textContent = `${state.lightAz}° · ${state.lightEl >= 0 ? '+' : ''}${state.lightEl}°`;
  $('#light-pad').setAttribute('aria-valuetext', `giro ${state.lightAz} grados, altura ${state.lightEl} grados`);
}

function initBackgrounds() {
  const el = $('#backgrounds');
  BACKGROUNDS.forEach(bg => {
    const b = optionButton('bg', bg.id, state.bg === bg.id);
    b.style.background = bg.css;
    b.title = bg.label;
    b.setAttribute('aria-label', bg.label);
    b.onclick = () => {
      state.bg = bg.id;
      markPicked(el, bg.id);
      stage.setBackground(bg.spec);
      syncTransparency();
      save();
    };
    el.appendChild(b);
  });
}

function initSize() {
  const sel = $('#size');
  SIZES.forEach(s => sel.add(new Option(s.label, s.id)));
  const changed = () => { layoutViewport(); frameCamera(); updateExportEstimate(); save(); };
  sel.addEventListener('change', () => {
    if (sel.value === 'custom' && state.size !== 'custom') {
      // Start the custom size from whatever was selected, so only one number needs changing.
      [state.customW, state.customH] = sizeOf(state);
    }
    state.size = sel.value;
    syncSizeUI();
    changed();
  });
  for (const [id, key] of [['#custom-w', 'customW'], ['#custom-h', 'customH']]) {
    $(id).addEventListener('change', e => {
      state[key] = evenClamp(e.target.value);
      e.target.value = state[key];
      changed();
    });
  }
  syncSizeUI();
}

function syncSizeUI() {
  $('#size').value = state.size;
  $('#custom-size').hidden = state.size !== 'custom';
  $('#custom-w').value = evenClamp(state.customW);
  $('#custom-h').value = evenClamp(state.customH);
}

function syncExportOpts() {
  document.querySelectorAll('.export-opts').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(state.format); });
  const label = {
    mp4: 'Exportar vídeo MP4', webm: 'Exportar vídeo WebM', avi: 'Exportar vídeo AVI', pngseq: 'Exportar secuencia PNG (ZIP)',
    png: 'Exportar imagen PNG', glb: 'Exportar modelo GLB', stl: 'Exportar STL (impresión 3D)',
  };
  $('#btn-export').textContent = label[state.format];
  $('#btn-export').disabled = false;
  updateExportEstimate();
}

function updateLoopNote() {
  const anim = getAnimation(state.anim);
  const el = $('#loop-note');
  const s = n => n.toFixed(1).replace('.', ',') + ' s';
  el.classList.remove('warn');
  const tl = currentTimeline();
  if (tl) {
    // Sequence: the length comes from its parts.
    const p = sequenceParts(state), parts = [];
    if (p.intro) parts.push(`intro ${s(tl.introSecs)}`);
    if (p.loop) parts.push(`«${p.loop.label}» × ${state.seqReps}${(state.seqLoopSpeed ?? 1) !== 1 ? ` a ${state.seqLoopSpeed.toFixed(2)}x` : ''} (${s(tl.mid)})`);
    else if (p.still && tl.mid > 0) parts.push(`quieto ${s(tl.mid)}`);
    if (p.outro) parts.push(`salida ${s(tl.outroSecs)}`);
    el.textContent = parts.length
      ? `Duración ${s(tl.clip)}, marcada por la secuencia: ${parts.join(' → ')}.`
      : 'La secuencia está vacía: elige una intro, un bucle o una salida en la pestaña Secuencia.';
    el.classList.toggle('warn', !parts.length);
    return;
  }
  if (anim.kind === 'intro') { el.textContent = `Intro de ${s(anim.duration / state.speed)} y luego se queda quieto.`; return; }
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
  fx.clip = (axis, value, keepAbove) => stage.setLogoClip(axis, value, keepAbove);
  const commitMask = op => { requestRetrace(op); markDirty(); };
  maskEditor = initMaskEditor({ getSource: () => source, commit: commitMask });
  reliefUI = initRelief({
    getSource: () => source,
    rebuild: () => { rebuildMeshes(); updateHud(); },
    changed: markDirty,
    renderPreview: renderStillInto,
  });
  maskUI = initMaskUI({ getSource: () => source, isVector: usingVector, commit: commitMask, openEditor: () => maskEditor.open() });
  initMaterials();
  initAnimations();
  initBackgrounds();
  chips('#lighting', LIGHTING, 'lighting', l => stage.setLighting(l.id, state.lightGain));
  chips('#floors', FLOORS, 'floor', f => stage.setFloor(f.id));
  chips('#cameras', CAMERA_MOVES, 'camMove', c => { stage.cameraMove = c.id; camClock = 0; });
  segmented('#side-mode', 'sideMode', () => { applyMaterials(); syncColorRows(); });
  segmented('#format', 'format', syncExportOpts);
  initSize();
  segmented('#fps', 'fps', updateExportEstimate);
  segmented('#avi-codec', 'aviCodec', updateExportEstimate);

  $('#color').value = state.color;
  $('#color').addEventListener('input', e => { state.color = e.target.value; applyMaterials(); save(); });
  $('#side-color').value = state.sideColor;
  $('#side-color').addEventListener('input', e => { state.sideColor = e.target.value; applyMaterials(); save(); });
  $('#particles').checked = state.particles;
  $('#particles').addEventListener('change', e => { state.particles = e.target.checked; stage.setParticles(state.particles, state.density); save(); });
  $('#shine').checked = state.shine;
  $('#shine').addEventListener('change', e => { state.shine = e.target.checked; stage.setShine(state.shine, state.shineGain); save(); });
  initLightPad();
  syncDurationUI();

  const fileInput = $('#file');
  $('#btn-open').onclick = () => fileInput.click();
  $('#drop').onclick = () => fileInput.click();
  fileInput.onchange = () => { openFile(fileInput.files[0]); fileInput.value = ''; };
  const makeText = () => {
    const text = $('#text-input').value.trim();
    if (!text) return;
    openGeneration++;
    loadCanvas(textLogo(text, $('#font-select').value, state.color), `Texto «${text}»`, true).then(ok => ok && startProject());
  };
  $('#btn-text').onclick = makeText;
  $('#text-input').addEventListener('keydown', e => { if (e.key === 'Enter') makeText(); });
  $('#btn-export').onclick = runExport;
  $('#btn-save').onclick = saveProjectFile;
  $('#btn-undo').onclick = undo;
  $('#btn-redo').onclick = redo;
  $('#btn-recent').onclick = e => { e.stopPropagation(); toggleRecentMenu(); };
  document.addEventListener('click', e => { if (!$('#recent-menu').hidden && !e.target.closest('#recent-menu')) toggleRecentMenu(false); });
  initShortcuts();
  syncUndoUI();
  host.on('open-project', msg => openProjectFile(new File([msg.text], msg.name)));
  // Last chance to keep the latest changes when the window closes.
  addEventListener('pagehide', () => { flushHistory(); autosave(); });
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

  initUpdates({
    toast,
    beforeInstall: async () => { flushHistory(); await autosave(); },
    isBusy: () => exporting,
  });
  restoreLastSession();
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
window.__app = { state, stage, THREE, get logo() { return logo; }, get source() { return source; }, resetPose };
