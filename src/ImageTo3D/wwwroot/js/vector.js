// Real SVG import: the file's own paths become the outlines (exact curves, holes from its
// fill-rule, every fill colour and the paint order) instead of tracing a rasterised copy.
// Strokes (line icons) and <text> are drawn by the browser itself — exact widths, joins, caps,
// dashes and fonts — into a mask per layer, and that mask is traced like an image.
//
// Output has the same shape as the raster pipeline's, so the rest of the app does not care
// where it came from: outlines in "field" coordinates (texture pixel + 0.5), the texture
// size, and a colour texture drawn from the SVG itself. Each outline also carries `layer`:
// runs of consecutive same-colour items in paint order, so a white word painted over a
// blue badge is a separate layer that can sit in front of it.
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import * as THREE from 'three';
import { fillTransparent } from './colormap.js';
import { marchingSquares, buildOutlines } from './trace.js';

const TEX_MAX = 2048;
const PREVIEW_MAX = 360;
/** Curve sampling per «Suavizado» step: target length of each straight piece, in texture
 *  pixels (the logo is 2048 px across), so a big circle gets as many points as it needs. */
const SEGMENT_PX = [24, 16, 10, 7, 5, 3.5, 2.5];
/** Strokes and texts are drawn and traced once per layer; past this many it is quicker (and
 *  as good) to trace the whole SVG as an image. */
const MAX_RASTER_LAYERS = 24;
const XLINK = 'http://www.w3.org/1999/xlink';
const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
/** Containers whose content is never painted where it stands (only through a reference). */
const UNPAINTED = new Set(['defs', 'symbol', 'clipPath', 'mask', 'pattern', 'marker']);

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

let probe = null;
/** A CSS colour as #rrggbb, or null for what has no single colour of its own (a gradient,
 *  currentColor, inherit…): the browser's own parser decides, so names and rgb() work too. */
function solidColor(css) {
  if (!css || /^\s*(url\(|currentcolor|inherit|none|transparent)/i.test(String(css))) return null;
  probe ||= new OffscreenCanvas(1, 1).getContext('2d');
  probe.fillStyle = '#010203';
  probe.fillStyle = String(css);
  const v = probe.fillStyle;
  if (v === '#010203' && !/^#?010203$/i.test(String(css).trim())) return null;
  const c = new THREE.Color();
  c.setStyle(v);
  return cssHex(c);
}

/** The fill a <text> is painted with, from its own attributes and style and its ancestors';
 *  null when its parts differ (a multicolour title) or it cannot be told here (a CSS class). */
function textFill(node) {
  const own = el => {
    const style = el.getAttribute?.('style') || '';
    const m = style.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i);
    return m ? m[1].trim() : el.getAttribute?.('fill');
  };
  // A style sheet may colour it by tag or class: then the drawing tells (traceRasterItems).
  if (node.ownerDocument?.querySelector('style')) return null;
  let value = null;
  for (let el = node; el && el.nodeType === 1; el = el.parentNode) { value = own(el); if (value) break; }
  const color = solidColor(value || 'black');   // SVG's default fill is black
  if (!color) return null;
  for (const t of node.querySelectorAll('tspan, textPath')) { const f = own(t); if (f && solidColor(f) !== color) return null; }
  return color;
}

/** Hidden by an attribute or inline style on the element or an ancestor. */
function hiddenByAttribute(node) {
  for (let el = node; el && el.nodeType === 1; el = el.parentNode) {
    const style = (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
    if (el.getAttribute('display') === 'none' || el.getAttribute('visibility') === 'hidden' || /display:none|visibility:hidden/.test(style)) return true;
  }
  return false;
}

/**
 * What SVGLoader does not model the way the browser draws it, which would leave the vectors and
 * the drawing out of step: a <use> of a <symbol> or <svg>, or with its own size; a nested <svg>
 * with its own viewport; transforms set by CSS. Such an SVG is traced as an image.
 */
function unsupportedReason(doc) {
  const root = doc.documentElement;
  for (const use of doc.querySelectorAll('use')) {
    const id = (use.getAttributeNS(XLINK, 'href') || use.getAttribute('href') || '').replace(/^#/, '');
    const ref = id && doc.getElementById(id);
    if (ref && (ref.localName === 'symbol' || ref.localName === 'svg')) return 'usa símbolos (<symbol>)';
    if (use.hasAttribute('width') || use.hasAttribute('height')) return 'usa <use> con tamaño propio';
  }
  for (const svg of doc.querySelectorAll('svg')) {
    if (svg !== root && ['viewBox', 'x', 'y', 'width', 'height'].some(a => svg.hasAttribute(a))) return 'lleva un <svg> anidado';
  }
  const css = [...doc.querySelectorAll('style')].map(s => s.textContent).join(' ') + [...doc.querySelectorAll('[style]')].map(e => e.getAttribute('style')).join(' ');
  if (/transform\s*:/i.test(css)) return 'usa transformaciones por CSS';
  return null;
}

/**
 * Parses the SVG. Returns { paths, items, bbox, doc, report } or throws. `items` is what gets
 * painted, in paint order: fills (vectors), strokes and texts (drawn and traced, see
 * traceRasterItems); `paths` are the fills alone. `report` counts texts, embedded bitmaps,
 * strokes and gradients, and says what cannot be built from the vectors (`unsupported`).
 */
export function parseVectorSvg(text) {
  // SVG 2 references (<use href>) as SVGLoader reads them (xlink:href); the drawing is the same.
  const pre = new DOMParser().parseFromString(text, 'image/svg+xml');
  let fixedHref = false;
  for (const use of pre.querySelectorAll('use')) {
    if (use.getAttribute('href') && !use.getAttributeNS(XLINK, 'href')) { use.setAttributeNS(XLINK, 'xlink:href', use.getAttribute('href')); fixedHref = true; }
  }
  if (fixedHref) text = new XMLSerializer().serializeToString(pre);

  const data = new SVGLoader().parse(text);
  const doc = data.xml?.ownerDocument || data.xml;
  const report = { texts: 0, images: 0, strokes: 0, gradients: 0, background: false, unsupported: null };
  if (doc?.querySelectorAll) {
    report.images = doc.querySelectorAll('image').length;
    report.unsupported = unsupportedReason(doc);
  }

  // Paint order as SVGLoader walks the document (a <use> where it stands, not where its target
  // is defined), counting the shapes it turns into paths; a <text> sits after the shapes before it.
  const textAt = new Map();
  let shapes = 0;
  const walk = (node, viaUse) => {
    if (!node || node.nodeType !== 1) return;
    const tag = node.localName;
    if (tag === 'text') { if (!textAt.has(node)) textAt.set(node, shapes); return; }
    if (SHAPE_TAGS.has(tag)) { shapes++; return; }
    if (tag === 'use') {
      const id = (node.getAttributeNS(XLINK, 'href') || node.getAttribute('href') || '').replace(/^#/, '');
      walk(id && doc.getElementById(id), true);
      return;
    }
    if (UNPAINTED.has(tag) && !viaUse) return;
    for (const child of node.children) walk(child, false);
  };
  if (doc?.documentElement) walk(doc.documentElement, false);
  const textNodes = [...textAt.keys()].filter(t => t.textContent.trim() && !hiddenByAttribute(t));
  report.texts = textNodes.length;

  const paths = [], items = [];
  data.paths.forEach((p, order) => {
    const st = p.userData?.style || {};
    const hidden = st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity ?? 1) <= 0;
    if (hidden) return;
    const hasStroke = st.stroke && st.stroke !== 'none' && Number(st.strokeWidth ?? 1) > 0 && Number(st.strokeOpacity ?? 1) > 0;
    const hasFill = st.fill && st.fill !== 'none' && Number(st.fillOpacity ?? 1) > 0;
    // SVG paints an element's fill first and its stroke over it.
    if (hasFill) {
      const gradient = String(st.fill).startsWith('url(');
      if (gradient) report.gradients++;
      const shapeList = p.toShapes();
      if (shapeList.length) {
        const item = { kind: 'fill', order, node: p.userData.node, color: gradient ? null : cssHex(p.color), shapes: shapeList, bbox: shapesBox(shapeList) };
        paths.push(item);
        items.push(item);
      }
    }
    if (hasStroke && p.subPaths.length) {
      report.strokes++;
      // Its box reaches half the width past the path, more at mitred corners.
      const box = new THREE.Box2();
      for (const sp of p.subPaths) for (const v of sp.getPoints()) box.expandByPoint(v);
      const mitre = (st.strokeLineJoin || 'miter') === 'miter' ? Math.max(1, Number(st.strokeMiterLimit ?? 4)) : 1;
      box.expandByScalar(Number(st.strokeWidth ?? 1) / 2 * mitre);
      items.push({ kind: 'stroke', order, node: p.userData.node, color: solidColor(st.stroke), bbox: box });
    }
  });
  for (const node of textNodes) items.push({ kind: 'text', order: textAt.get(node) - 0.5, node, color: textFill(node), bbox: null });
  items.sort((a, b) => a.order - b.order);   // stable: an element's fill stays before its stroke

  // A full-size rectangle painted first is the artboard's background, not part of the logo.
  const first = items[0], rest = items.slice(1).filter(it => it.node !== first?.node && it.bbox);
  if (first?.kind === 'fill' && rest.length) {
    const all = rest.reduce((b, it) => b.union(it.bbox), new THREE.Box2());
    const fb = first.bbox, fs = fb.getSize(new THREE.Vector2()), as = all.getSize(new THREE.Vector2());
    const pts = first.shapes[0].getPoints().length;
    if (first.shapes.length === 1 && !first.shapes[0].holes.length && pts <= 6 &&
        fb.containsBox(all) && fs.x * fs.y > 1.2 * as.x * as.y) {
      report.background = true;
      first.node?.remove();
      paths.splice(paths.indexOf(first), 1);
      // Its border too, if it had one.
      for (let i = items.length - 1; i >= 0; i--) if (items[i].node === first.node) items.splice(i, 1);
    }
  }

  const bbox = items.reduce((b, it) => (it.bbox ? b.union(it.bbox) : b), new THREE.Box2());
  // A text's box is not known until it is drawn: the artboard (viewBox, or width × height) bounds it.
  if (textNodes.length && doc?.documentElement) {
    const root = doc.documentElement, vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const art = vb.length === 4 && vb.every(Number.isFinite)
      ? new THREE.Box2(new THREE.Vector2(vb[0], vb[1]), new THREE.Vector2(vb[0] + vb[2], vb[1] + vb[3]))
      : new THREE.Box2(new THREE.Vector2(0, 0), new THREE.Vector2(parseFloat(root.getAttribute('width')) || 300, parseFloat(root.getAttribute('height')) || 150));
    bbox.union(art);
  }
  return { paths, items, bbox, doc, report };
}

function shapesBox(shapes) {
  const b = new THREE.Box2();
  for (const s of shapes) for (const v of s.getPoints()) b.expandByPoint(v);
  return b;
}

/**
 * Whether the parsed SVG is worth building from its vectors (else trace the raster). `legacy`:
 * the rules before 1.2 (fills only; any text, or no fill, meant tracing), for old projects.
 */
export function vectorVerdict(parsed, { legacy = false } = {}) {
  const r = parsed.report;
  if (r.images) return { ok: false, reason: 'lleva imágenes incrustadas' };
  if (legacy) {
    if (!parsed.paths.length) return { ok: false, reason: 'el SVG no tiene formas rellenas' };
    if (r.texts) return { ok: false, reason: 'tiene textos sin convertir a trazados' };
    return { ok: true };
  }
  if (r.unsupported) return { ok: false, reason: r.unsupported };
  if (!parsed.items.length) return { ok: false, reason: 'el SVG no tiene formas, trazos ni textos que se vean' };
  const { layers, of } = layersOf(parsed.items);
  const rasterLayers = new Set(parsed.items.map((it, i) => (it.kind === 'fill' ? -1 : of[i])).filter(l => l >= 0)).size;
  if (rasterLayers > MAX_RASTER_LAYERS) return { ok: false, reason: `tiene demasiados textos o trazos sueltos (${rasterLayers} de ${layers.length} capas)` };
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

/** Polylines of one fill's shapes in texture pixels (consecutive duplicates removed). */
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
 * Layers: consecutive items of the same colour in paint order (those without a single colour —
 * gradients, multicolour texts — each on their own, and they keep the artwork on their face).
 * Returns [{ index, color, gradient }] and the layer of every item.
 */
function layersOf(items) {
  const layers = [], of = [];
  for (const p of items) {
    const last = layers[layers.length - 1];
    if (last && p.color && last.color === p.color) { of.push(last.index); continue; }
    layers.push({ index: layers.length, color: p.color, gradient: !p.color });
    of.push(layers.length - 1);
  }
  return { layers, of };
}

/**
 * Outlines for the geometry, in field coordinates (texture pixel + 0.5), each with its layer.
 * smooth (0..6, the «Suavizado» slider) sets how finely curves are sampled, and how much the
 * traced strokes and texts are smoothed.
 */
export function vectorOutlines(parsed, L, smooth = 2) {
  const segPx = SEGMENT_PX[Math.max(0, Math.min(6, Math.round(smooth)))];
  const { of } = layersOf(parsed.items);
  const field = p => ({ x: p.x + 0.5, y: p.y + 0.5 });
  const outlines = [];
  parsed.items.forEach((item, i) => {
    if (item.kind !== 'fill') return;
    for (const pl of polys(item, L, segPx)) {
      outlines.push({ outer: pl.outer.map(field), holes: pl.holes.map(h => h.map(field)), layer: of[i] });
    }
  });
  // Strokes and texts: their traced masks (already in field coordinates).
  for (const r of parsed.rasterLoops || []) {
    for (const o of buildOutlines(r.loops, r, smooth, { denoise: 1 })) outlines.push({ ...o, layer: r.layer });
  }
  return outlines;
}

/**
 * Strokes and texts, layer by layer: the browser draws just them (everything else hidden) at the
 * texture's size; the drawing's alpha is traced into loops (parsed.rasterLoops) and its average
 * colour is the layer's when the SVG gives none (a gradient stroke, a text styled by class).
 */
async function traceRasterItems(parsed, L, layers, of) {
  parsed.rasterLoops = [];
  const byLayer = new Map();
  parsed.items.forEach((it, i) => {
    if (it.kind === 'fill') return;
    if (!byLayer.has(of[i])) byLayer.set(of[i], []);
    byLayer.get(of[i]).push(it);
  });
  // Traced at half the texture's size (a quarter of the work); the smoothing hides the difference.
  const k = L.w * L.h > 1e6 ? 2 : 1, mw = Math.max(2, Math.round(L.w / k)), mh = Math.max(2, Math.round(L.h / k));
  for (const [layer, list] of byLayer) {
    await new Promise(r => setTimeout(r, 0));   // one layer per task: the window stays responsive
    const canvas = await rasterise(parsed, L, new Set(list));
    const small = k === 1 ? canvas : new OffscreenCanvas(mw, mh);
    if (k !== 1) small.getContext('2d').drawImage(canvas, 0, 0, mw, mh);
    const px = small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, mw, mh).data;
    // Field (w + 2) × (h + 2): sample (x + 1, y + 1) is pixel (x, y), with an empty border.
    const W = mw + 2, H = mh + 2, field = new Float32Array(W * H);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const i = (y * mw + x) * 4, a = px[i + 3] / 255;
        field[(y + 1) * W + x + 1] = a;
        if (a > 0.8) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
      }
    }
    if (!n) continue;
    if (!layers[layer].color) layers[layer].color = '#' + [r, g, b].map(v => Math.round(v / n).toString(16).padStart(2, '0')).join('');
    // Back to the texture's field coordinates: field X is texture pixel X - 0.5 (+ 0.5).
    const up = p => ({ x: (p.x - 0.5) * L.w / mw + 0.5, y: (p.y - 0.5) * L.h / mh + 0.5 });
    const loops = marchingSquares({ field, W, H }).map(loop => (k === 1 ? loop : loop.map(up)));
    parsed.rasterLoops.push({ layer, loops, W: L.w + 2, H: L.h + 2, w: L.w, h: L.h });
  }
}

const addStyle = (el, css) => el.setAttribute('style', `${el.getAttribute('style') || ''};${css}`);

/**
 * The SVG drawn by the browser at the texture's size, with the logo's box as its viewBox.
 * With `only` (a set of stroke / text items), just those are painted, fully opaque (a stroke at
 * 40 % opacity is still part of the logo): every fill is off, and so are the other strokes,
 * texts and images. Masks, clip paths, patterns and markers are left as they are.
 */
async function rasterise(parsed, L, only = null) {
  const root = parsed.doc.documentElement;
  root.setAttribute('viewBox', `${L.x0} ${L.y0} ${L.bw} ${L.bh}`);
  root.setAttribute('width', String(L.w));
  root.setAttribute('height', String(L.h));
  root.setAttribute('preserveAspectRatio', 'none');
  let doc = parsed.doc;
  if (only) {
    doc = parsed.doc.cloneNode(true);
    const from = [...parsed.doc.querySelectorAll('*')], to = [...doc.querySelectorAll('*')];
    const strokes = new Set([...only].filter(it => it.kind === 'stroke').map(it => it.node));
    const texts = new Set([...only].filter(it => it.kind === 'text').map(it => it.node));
    from.forEach((el, i) => {
      const tag = el.localName, copy = to[i];
      if (el.closest('mask, clipPath, pattern, marker')) return;
      addStyle(copy, 'opacity:1 !important');
      if (tag === 'text') { addStyle(copy, texts.has(el) ? 'fill-opacity:1 !important' : 'display:none !important'); return; }
      if (tag === 'image') { addStyle(copy, 'display:none !important'); return; }
      if (SHAPE_TAGS.has(tag)) addStyle(copy, strokes.has(el) ? 'fill:none !important;stroke-opacity:1 !important' : 'fill:none !important;stroke:none !important');
    });
  }
  const blob = new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' });
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
 * The colour texture: every fill (and every traced stroke or text) filled and slightly widened
 * in its own colour (so bevels and side walls never pick up a background halo), then the SVG
 * itself drawn over it, which keeps gradients and exact colours inside the shapes. Gradient
 * fills take their average colour for the widened rim. Also returns the layers with their colours.
 */
export async function vectorTexture(parsed, L) {
  const raster = await rasterise(parsed, L);
  const { layers, of } = layersOf(parsed.items);
  await traceRasterItems(parsed, L, layers, of);
  const shapes = parsed.items.map(it => (it.kind === 'fill' ? polys(it, L, 4) : []));

  // Average colour of gradient-filled paths (strokes and texts got theirs from their drawing).
  if (layers.some(l => !l.color)) {
    const k = Math.min(1, 512 / Math.max(L.w, L.h)), sw = Math.max(1, Math.round(L.w * k)), sh = Math.max(1, Math.round(L.h * k));
    const small = new OffscreenCanvas(sw, sh), g = small.getContext('2d', { willReadFrequently: true });
    g.drawImage(raster, 0, 0, sw, sh);
    const px = g.getImageData(0, 0, sw, sh).data;
    const m = new OffscreenCanvas(sw, sh), mg = m.getContext('2d', { willReadFrequently: true });
    for (const layer of layers.filter(l => !l.color)) {
      mg.clearRect(0, 0, sw, sh);
      mg.setTransform(k, 0, 0, k, 0, 0);
      parsed.items.forEach((_, i) => { if (of[i] === layer.index) shapes[i].forEach(pl => mg.fill(path2d(pl), 'evenodd')); });
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
  parsed.items.forEach((_, i) => {
    ctx.fillStyle = layers[of[i]].color || '#808080';
    for (const pl of shapes[i]) ctx.fill(path2d(pl), 'evenodd');
  });
  const toPx = loop => loop.map(p => ({ x: p.x - 0.5, y: p.y - 0.5 }));
  for (const r of parsed.rasterLoops) {
    ctx.fillStyle = layers[r.layer].color || '#808080';
    for (const o of buildOutlines(r.loops, r, 2, { denoise: 1 })) ctx.fill(path2d({ outer: toPx(o.outer), holes: o.holes.map(toPx) }), 'evenodd');
  }
  ctx.drawImage(raster, 0, 0);
  // Outside the shapes, each pixel takes the nearest shape's colour: the bevel and side walls
  // sample there (the widest bevel reaches ~2 % of the logo, ~45 px), and mipmaps too.
  const img = ctx.getImageData(0, 0, L.w, L.h);
  fillTransparent(img, Math.ceil(Math.max(L.w, L.h) / 40));
  ctx.putImageData(img, 0, 0);
  return { color: c, raster, layers };
}

/**
 * The share of what the browser draws (opaque pixels of `raster`) that the outlines leave out:
 * something SVGLoader does not read. Measured at 256 px, with the outlines' edge widened a
 * pixel so anti-aliasing never counts.
 */
export function uncoveredShare(outlines, raster, L) {
  const k = Math.min(1, 256 / Math.max(L.w, L.h)), w = Math.max(1, Math.round(L.w * k)), h = Math.max(1, Math.round(L.h * k));
  const ink = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  ink.drawImage(raster, 0, 0, w, h);
  const drawn = ink.getImageData(0, 0, w, h).data;
  const m = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  m.fillStyle = m.strokeStyle = '#fff';
  m.lineWidth = 2;
  for (const o of outlines) {
    const p = new Path2D();
    for (const loop of [o.outer, ...o.holes]) {
      loop.forEach((v, i) => { const x = (v.x - 0.5) * k, y = (v.y - 0.5) * k; i ? p.lineTo(x, y) : p.moveTo(x, y); });
      p.closePath();
    }
    m.fill(p, 'evenodd');
    m.stroke(p);
  }
  const covered = m.getImageData(0, 0, w, h).data;
  let total = 0, missed = 0;
  for (let i = 3; i < drawn.length; i += 4) {
    if (drawn[i] < 160) continue;
    total++;
    if (covered[i] < 128) missed++;
  }
  return total ? missed / total : 0;
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
