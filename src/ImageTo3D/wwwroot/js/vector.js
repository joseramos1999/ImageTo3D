// Real SVG import: the file's own paths become the outlines (exact curves, holes from its
// fill-rule, every fill colour and the paint order) instead of tracing a rasterised copy.
//
// Output has the same shape as the raster pipeline's, so the rest of the app does not care
// where it came from: outlines in "field" coordinates (texture pixel + 0.5), the texture
// size, and a colour texture drawn from the SVG itself. Each outline also carries `layer`:
// runs of consecutive same-colour paths in paint order, so a white word painted over a
// blue badge is a separate layer that can sit in front of it.
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import * as THREE from 'three';
import { fillTransparent } from './colormap.js';

const TEX_MAX = 2048;
const PREVIEW_MAX = 360;
/** Curve sampling per «Suavizado» step: target length of each straight piece, in texture
 *  pixels (the logo is 2048 px across), so a big circle gets as many points as it needs. */
const SEGMENT_PX = [24, 16, 10, 7, 5, 3.5, 2.5];

/** Points along a path (THREE.Path / Shape), each curve split by its length; no closing duplicate. */
function samplePath(path, scale, segPx) {
  const out = [];
  for (const curve of path.curves) {
    if (curve.isLineCurve) { out.push(curve.v1.clone()); continue; }
    const n = Math.max(2, Math.min(720, Math.ceil(curve.getLength() * scale / segPx)));
    for (let i = 0; i < n; i++) out.push(curve.getPoint(i / n));
  }
  // An open path still fills as if closed: keep its end point (dropped later if it is the start).
  if (path.curves.length) out.push(path.curves[path.curves.length - 1].getPoint(1));
  return out;
}

const cssHex = c => '#' + c.getHexString(THREE.SRGBColorSpace);

/**
 * Parses the SVG. Returns { paths, bbox, doc, report } or throws. `report` says what
 * cannot be kept as vectors (text that is not converted to paths, embedded bitmaps,
 * stroke-only drawings), so the caller can fall back to tracing the raster.
 */
export function parseVectorSvg(text) {
  const data = new SVGLoader().parse(text);
  const doc = data.xml?.ownerDocument || data.xml;
  const report = { texts: 0, images: 0, strokes: 0, gradients: 0, background: false };
  if (doc?.querySelectorAll) {
    report.texts = doc.querySelectorAll('text').length;
    report.images = doc.querySelectorAll('image').length;
  }

  const paths = [];
  for (const p of data.paths) {
    const st = p.userData?.style || {};
    const hidden = st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity ?? 1) <= 0;
    if (hidden) continue;
    const hasStroke = st.stroke && st.stroke !== 'none' && Number(st.strokeWidth ?? 1) > 0 && Number(st.strokeOpacity ?? 1) > 0;
    const hasFill = st.fill && st.fill !== 'none' && Number(st.fillOpacity ?? 1) > 0;
    if (hasStroke) report.strokes++;
    if (!hasFill) continue;
    const gradient = String(st.fill).startsWith('url(');
    if (gradient) report.gradients++;
    const shapes = p.toShapes();
    if (!shapes.length) continue;
    paths.push({ node: p.userData.node, color: gradient ? null : cssHex(p.color), shapes, bbox: shapesBox(shapes) });
  }

  // A full-size rectangle painted first is the artboard's background, not part of the logo.
  if (paths.length > 1) {
    const all = paths.slice(1).reduce((b, p) => b.union(p.bbox), new THREE.Box2());
    const first = paths[0], fb = first.bbox, fs = fb.getSize(new THREE.Vector2()), as = all.getSize(new THREE.Vector2());
    const pts = first.shapes[0].getPoints().length;
    if (first.shapes.length === 1 && !first.shapes[0].holes.length && pts <= 6 &&
        fb.containsBox(all) && fs.x * fs.y > 1.2 * as.x * as.y) {
      report.background = true;
      first.node?.remove();
      paths.shift();
    }
  }

  const bbox = paths.reduce((b, p) => b.union(p.bbox), new THREE.Box2());
  return { paths, bbox, doc, report };
}

function shapesBox(shapes) {
  const b = new THREE.Box2();
  for (const s of shapes) for (const v of s.getPoints()) b.expandByPoint(v);
  return b;
}

/** Whether the parsed SVG is worth building from its vectors (else trace the raster). */
export function vectorVerdict(parsed) {
  const r = parsed.report;
  if (!parsed.paths.length) return { ok: false, reason: 'el SVG no tiene formas rellenas' };
  if (r.texts) return { ok: false, reason: 'tiene textos sin convertir a trazados' };
  if (r.images) return { ok: false, reason: 'lleva imágenes incrustadas' };
  return { ok: true };
}

/** Texture layout: the logo's bounding box plus a margin, mapped to at most TEX_MAX px. */
export function vectorLayout(parsed) {
  const size = parsed.bbox.getSize(new THREE.Vector2());
  const pad = Math.max(size.x, size.y) * 0.02 || 1;
  const x0 = parsed.bbox.min.x - pad, y0 = parsed.bbox.min.y - pad;
  const bw = size.x + pad * 2, bh = size.y + pad * 2;
  const s = TEX_MAX / Math.max(bw, bh);
  return { x0, y0, bw, bh, s, w: Math.max(2, Math.round(bw * s)), h: Math.max(2, Math.round(bh * s)) };
}

/** Polylines of one path's shapes in texture pixels (consecutive duplicates removed). */
function polys(path, L, segPx) {
  const map = v => ({ x: (v.x - L.x0) * L.s, y: (v.y - L.y0) * L.s });
  const clean = pts => {
    const out = [];
    for (const v of pts) {
      const p = map(v), q = out[out.length - 1];
      if (!q || Math.abs(p.x - q.x) > 1e-4 || Math.abs(p.y - q.y) > 1e-4) out.push(p);
    }
    const a = out[0], z = out[out.length - 1];
    if (out.length > 1 && Math.abs(a.x - z.x) < 1e-4 && Math.abs(a.y - z.y) < 1e-4) out.pop();
    return out;
  };
  return path.shapes.map(sh => ({
    outer: clean(samplePath(sh, L.s, segPx)),
    holes: sh.holes.map(h => clean(samplePath(h, L.s, segPx))).filter(h => h.length >= 3),
  })).filter(p => p.outer.length >= 3);
}

/**
 * Layers: consecutive paths of the same colour in paint order (gradients each on their own).
 * Returns [{ index, color }] and the layer of every path.
 */
function layersOf(paths) {
  const layers = [], of = [];
  for (const p of paths) {
    const last = layers[layers.length - 1];
    if (last && p.color && last.color === p.color) { of.push(last.index); continue; }
    layers.push({ index: layers.length, color: p.color, gradient: !p.color });
    of.push(layers.length - 1);
  }
  return { layers, of };
}

/**
 * Outlines for the geometry, in field coordinates (texture pixel + 0.5), each with its layer.
 * smooth (0..6, the «Suavizado» slider) sets how finely curves are sampled.
 */
export function vectorOutlines(parsed, L, smooth = 2) {
  const segPx = SEGMENT_PX[Math.max(0, Math.min(6, Math.round(smooth)))];
  const { of } = layersOf(parsed.paths);
  const field = p => ({ x: p.x + 0.5, y: p.y + 0.5 });
  const outlines = [];
  parsed.paths.forEach((path, i) => {
    for (const pl of polys(path, L, segPx)) {
      outlines.push({ outer: pl.outer.map(field), holes: pl.holes.map(h => h.map(field)), layer: of[i] });
    }
  });
  return outlines;
}

/** The SVG drawn by the browser at the texture's size, with the logo's box as its viewBox. */
async function rasterise(parsed, L) {
  const root = parsed.doc.documentElement;
  root.setAttribute('viewBox', `${L.x0} ${L.y0} ${L.bw} ${L.bh}`);
  root.setAttribute('width', String(L.w));
  root.setAttribute('height', String(L.h));
  root.setAttribute('preserveAspectRatio', 'none');
  const blob = new Blob([new XMLSerializer().serializeToString(parsed.doc)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(new Error('El SVG no se pudo dibujar.')); img.src = url; });
    const c = new OffscreenCanvas(L.w, L.h);
    c.getContext('2d').drawImage(img, 0, 0, L.w, L.h);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const path2d = pl => {
  const p = new Path2D();
  for (const loop of [pl.outer, ...pl.holes]) {
    loop.forEach((v, i) => (i ? p.lineTo(v.x, v.y) : p.moveTo(v.x, v.y)));
    p.closePath();
  }
  return p;
};

/**
 * The colour texture: every path filled and slightly widened in its own colour (so bevels
 * and side walls never pick up a background halo), then the SVG itself drawn over it, which
 * keeps gradients and exact colours inside the shapes. Gradient fills take their average
 * colour for the widened rim. Also returns the layers with their colours.
 */
export async function vectorTexture(parsed, L) {
  const raster = await rasterise(parsed, L);
  const { layers, of } = layersOf(parsed.paths);
  const shapes = parsed.paths.map(p => polys(p, L, 4));

  // Average colour of gradient-filled paths, read from the raster under their shapes.
  if (layers.some(l => l.gradient)) {
    const k = Math.min(1, 512 / Math.max(L.w, L.h)), sw = Math.max(1, Math.round(L.w * k)), sh = Math.max(1, Math.round(L.h * k));
    const small = new OffscreenCanvas(sw, sh), g = small.getContext('2d', { willReadFrequently: true });
    g.drawImage(raster, 0, 0, sw, sh);
    const px = g.getImageData(0, 0, sw, sh).data;
    const m = new OffscreenCanvas(sw, sh), mg = m.getContext('2d', { willReadFrequently: true });
    for (const layer of layers.filter(l => l.gradient)) {
      mg.clearRect(0, 0, sw, sh);
      mg.setTransform(k, 0, 0, k, 0, 0);
      parsed.paths.forEach((_, i) => { if (of[i] === layer.index) shapes[i].forEach(pl => mg.fill(path2d(pl), 'evenodd')); });
      mg.setTransform(1, 0, 0, 1, 0, 0);
      const mask = mg.getImageData(0, 0, sw, sh).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let j = 0; j < mask.length; j += 4) {
        if (mask[j + 3] < 128 || px[j + 3] < 128) continue;
        r += px[j]; gg += px[j + 1]; b += px[j + 2]; n++;
      }
      layer.color = n ? '#' + [r, gg, b].map(v => Math.round(v / n).toString(16).padStart(2, '0')).join('') : '#808080';
    }
  }

  const c = new OffscreenCanvas(L.w, L.h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  // Solid fills under the SVG: its anti-aliased rims become opaque in the shape's own colour
  // (gradients use their average), then the SVG on top keeps exact colours inside.
  parsed.paths.forEach((_, i) => {
    ctx.fillStyle = layers[of[i]].color;
    for (const pl of shapes[i]) ctx.fill(path2d(pl), 'evenodd');
  });
  ctx.drawImage(raster, 0, 0);
  // Outside the shapes, each pixel takes the nearest shape's colour: the bevel and side walls
  // sample there (the widest bevel reaches ~2 % of the logo, ~45 px), and mipmaps too.
  const img = ctx.getImageData(0, 0, L.w, L.h);
  fillTransparent(img, Math.ceil(Math.max(L.w, L.h) / 40));
  ctx.putImageData(img, 0, 0);
  return { color: c, raster, layers };
}

/** The "after" preview for the Recorte panel: the texture cut out by the outlines. */
export function vectorPreview(color, outlines, L) {
  const k = Math.min(1, PREVIEW_MAX / Math.max(L.w, L.h));
  const c = new OffscreenCanvas(Math.max(1, Math.round(L.w * k)), Math.max(1, Math.round(L.h * k)));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  // One fill per outline: layers overlap, and a single even-odd path would punch them out.
  for (const o of outlines) {
    const p = new Path2D();
    for (const loop of [o.outer, ...o.holes]) {
      loop.forEach((v, i) => { const x = (v.x - 0.5) * k, y = (v.y - 0.5) * k; i ? p.lineTo(x, y) : p.moveTo(x, y); });
      p.closePath();
    }
    ctx.fill(p, 'evenodd');
  }
  ctx.globalCompositeOperation = 'source-in';
  ctx.drawImage(color, 0, 0, c.width, c.height);
  return c.transferToImageBitmap();
}
