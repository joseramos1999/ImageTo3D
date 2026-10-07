// 3D printing: the logo as a printable part (in millimetres) with an optional base, in the
// chosen orientation, and a check of what usually goes wrong: an open mesh, walls or details
// thinner than a nozzle can draw, loose or floating pieces, a part too thin to hold together.
import * as THREE from 'three';
import { marchingSquares, buildOutlines } from './trace.js';

export const PRINT_DEFAULTS = { base: 'none', margin: 3, baseThick: 2, orient: 'flat', minWall: 0.8 };

/** The logo at rest, pieces at home, as plain triangles per piece (logo units). */
function restPieces(logo) {
  const out = [];
  for (const piece of logo.children) {
    const g = piece.geometry, pos = g.attributes.position;
    const m = new THREE.Matrix4().makeTranslation(piece.userData.home.x, piece.userData.home.y, piece.userData.home.z);
    const relief = piece.userData.reliefGroup;   // { start, count } of the relief surface, if any
    const tris = [], reliefTris = [];
    for (let i = 0; i + 2 < pos.count; i += 3) {
      const t = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, i + k).applyMatrix4(m));
      if (relief && i >= relief.start && i < relief.start + relief.count) reliefTris.push(t); else tris.push(t);
    }
    out.push({ piece, tris, reliefTris, frontZ: piece.userData.frontZ, backZ: piece.userData.backZ, outline: piece.userData.outline, home: piece.userData.home });
  }
  return out;
}

/**
 * A relief surface (open, lifted a hair off the face) as a closed solid for printing: the
 * surface on top and a copy underneath, wound the other way, that dips into the piece (so the
 * slicer merges them) except along the outline, where both share their vertices and close.
 */
function reliefSolid(reliefTris, frontZ, backZ) {
  const LIFT = 0.0015, SINK = 0.01, solid = [];
  for (const [a, b, c] of reliefTris) {
    solid.push([a, b, c]);
    const front = (a.z + b.z + c.z) / 3 > (frontZ + backZ) / 2;
    const under = v => {
      // On the outline the surface is exactly LIFT off the face: keep that vertex as it is.
      const edge = front ? v.z <= frontZ + LIFT + 1e-6 : v.z >= backZ - LIFT - 1e-6;
      return new THREE.Vector3(v.x, v.y, edge ? v.z : front ? frontZ - SINK : backZ + SINK);
    };
    solid.push([c, b, a].map(under));
  }
  return solid;
}

/**
 * Holes in a shell: edges used by an odd number of triangles. A closed shell uses every edge
 * twice; a relief solid may pinch to zero thickness along a short chord of the outline (that
 * edge is used four times), which still encloses a volume, so only odd counts are holes.
 */
function openEdges(tris) {
  const key = v => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
  const count = new Map();
  for (const t of tris) {
    const k = t.map(key);
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      if (a === b) continue;
      const ek = a < b ? a + '|' + b : b + '|' + a;
      count.set(ek, (count.get(ek) || 0) + 1);
    }
  }
  let open = 0;
  for (const c of count.values()) if (c % 2) open++;
  return open;
}

// ── silhouette raster tools (millimetres) ──

/** The logo's silhouette, seen from the front, rasterised at `ppm` pixels per mm. */
function silhouette(pieces, k, box, ppm, pad) {
  const w = Math.ceil((box.max.x - box.min.x) * k * ppm) + pad * 2, h = Math.ceil((box.max.y - box.min.y) * k * ppm) + pad * 2;
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  const X = x => (x - box.min.x) * k * ppm + pad, Y = y => (box.max.y - y) * k * ppm + pad;
  for (const p of pieces) {
    if (!p.outline) continue;
    const path = new Path2D();
    for (const loop of p.outline) {
      for (let i = 0; i < loop.length; i += 2) {
        const x = X(loop[i] + p.home.x), y = Y(loop[i + 1] + p.home.y);
        i ? path.lineTo(x, y) : path.moveTo(x, y);
      }
      path.closePath();
    }
    g.fill(path, 'evenodd');
  }
  const d = g.getImageData(0, 0, w, h).data;
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return { inside, w, h, X, Y };
}

/** Exact squared Euclidean distance transform (Felzenszwalb–Huttenlocher), to the nearest `target` pixel. */
function edt(target, w, h) {
  const INF = 1e20, f = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = target[i] ? 0 : INF;
  const pass = (n, get, set) => {
    for (let q = 0; q < n; q++) f[q] = get(q);
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      while ((s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])) <= z[k]) k--;
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    for (let q = 0; q < n; q++) set(q, d[q]);
  };
  for (let x = 0; x < w; x++) pass(h, y => out[y * w + x], (y, val) => { out[y * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, x => out[y * w + x], (x, val) => { out[y * w + x] = val; });
  return out;   // squared distances, in pixels
}

/**
 * Thin areas: what a morphological opening with a disc of radius minWall / 2 removes, i.e.
 * the parts of the silhouette narrower than minWall. Sharp tips are always a little thin, so
 * only patches bigger than minWall² count.
 */
function thinAreas(sil, ppm, minWall) {
  const { inside, w, h } = sil;
  const R = minWall / 2 * ppm;
  const outside = inside.map(v => 1 - v);
  const dIn = edt(outside, w, h);                       // distance to the outside
  const core = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) core[i] = inside[i] && dIn[i] >= R * R ? 1 : 0;
  const dCore = edt(core, w, h);                        // distance to the core
  const thin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) thin[i] = inside[i] && dCore[i] > (R + 0.75) * (R + 0.75) ? 1 : 0;
  // Keep patches above the size of a sharp tip.
  const minPx = Math.max(4, minWall * minWall * ppm * ppm);
  const seen = new Uint8Array(w * h), keep = new Uint8Array(w * h);
  let patches = 0, area = 0;
  for (let s = 0; s < w * h; s++) {
    if (!thin[s] || seen[s]) continue;
    const stack = [s], comp = [];
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop();
      comp.push(p);
      const x = p % w, y = (p - x) / w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && thin[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (comp.length >= minPx) { patches++; area += comp.length; comp.forEach(p => { keep[p] = 1; }); }
  }
  return { thin: keep, patches, areaMm2: area / (ppm * ppm) };
}

/** A base plate's outline: the silhouette grown by `margin` mm, traced back to shapes (mm, y up). */
function contourBase(sil, ppm, margin, box, k, pad) {
  const { inside, w, h } = sil;
  const d = edt(inside, w, h);
  const R = margin * ppm;
  const W = w + 2, H = h + 2, field = new Float32Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dist = Math.sqrt(d[y * w + x]);
    field[(y + 1) * W + x + 1] = Math.max(0, Math.min(1, 0.5 + (R - dist) / 2));   // soft edge at R
  }
  const outlines = buildOutlines(marchingSquares({ field, W, H }), { W, H, w, h }, 3, { denoise: 4, fillHoles: true });
  const toMm = p => new THREE.Vector2((p.x - 0.5 - pad) / ppm + box.min.x * k, (box.max.y * k) - (p.y - 0.5 - pad) / ppm);
  return outlines.map(o => {
    let pts = o.outer.map(toMm);
    if (!THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
    return new THREE.Shape(pts);
  });
}

function roundedRect(x0, y0, x1, y1, r) {
  const s = new THREE.Shape();
  r = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0); s.quadraticCurveTo(x1, y0, x1, y0 + r);
  s.lineTo(x1, y1 - r); s.quadraticCurveTo(x1, y1, x1 - r, y1);
  s.lineTo(x0 + r, y1); s.quadraticCurveTo(x0, y1, x0, y1 - r);
  s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  return s;
}

const trianglesOf = geo => {
  const g = geo.index ? geo.toNonIndexed() : geo, pos = g.attributes.position, out = [];
  for (let i = 0; i + 2 < pos.count; i += 3) out.push([0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, i + k)));
  return out;
};

/**
 * The printable part and its check. opts: { widthMm, base, margin, baseThick, orient, minWall }.
 * Returns { group (millimetres, z up = the print bed's up), checks: [{ ok, level, text }], map }.
 */
export function buildPrint(logo, opts) {
  const o = { ...PRINT_DEFAULTS, ...opts };
  const pieces = restPieces(logo);
  const box = new THREE.Box3();
  pieces.forEach(p => p.tris.forEach(t => t.forEach(v => box.expandByPoint(v))));
  if (box.isEmpty()) return null;
  const k = o.widthMm / (box.max.x - box.min.x);   // logo units → mm

  // Shells: each piece (closed by construction), its relief as a closed solid, the base.
  const shells = pieces.map(p => ({ name: 'piece', tris: p.tris, piece: p }));
  for (const p of pieces) if (p.reliefTris.length) shells.push({ name: 'relief', tris: reliefSolid(p.reliefTris, p.frontZ + p.home.z, p.backZ + p.home.z), piece: p });
  for (const s of shells) s.tris = s.tris.map(t => t.map(v => v.clone().multiplyScalar(k)));

  const ppm = Math.min(10, 2400 / Math.max((box.max.x - box.min.x) * k, (box.max.y - box.min.y) * k));
  const pad = Math.ceil((o.base === 'contour' ? o.margin + 2 : 2) * ppm);
  const sil = silhouette(pieces, k, box, ppm, pad);

  // Base: a plate under the back face (flat) or a foot under the logo (standing).
  const bmin = box.min.clone().multiplyScalar(k), bmax = box.max.clone().multiplyScalar(k);
  let baseTris = null;
  const overlap = 0.2;   // the plate goes slightly into the logo, so the slicer merges them
  if (o.base !== 'none' && o.orient === 'flat') {
    const shapes = o.base === 'contour'
      ? contourBase(sil, ppm, o.margin, box, k, pad)
      : [roundedRect(bmin.x - o.margin, bmin.y - o.margin, bmax.x + o.margin, bmax.y + o.margin, o.margin * 0.8)];
    const geo = new THREE.ExtrudeGeometry(shapes, { depth: o.baseThick + overlap, bevelEnabled: false, curveSegments: 12 });
    geo.translate(0, 0, bmin.z - o.baseThick);
    baseTris = trianglesOf(geo);
  } else if (o.base !== 'none' && o.orient === 'stand') {
    // A foot block along the bottom of the logo, as deep as it is thick plus the margins.
    const depthMm = bmax.z - bmin.z, footD = Math.max(8, depthMm + 2 * o.margin), zc = (bmin.z + bmax.z) / 2;
    const shape = roundedRect(bmin.x - o.margin, zc - footD / 2, bmax.x + o.margin, zc + footD / 2, Math.min(3, footD / 4));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: o.baseThick + overlap, bevelEnabled: false, curveSegments: 8 });
    // Built in (x, z) and lifted under the logo's bottom edge: y here is the logo's depth.
    geo.rotateX(Math.PI / 2);
    geo.translate(0, bmin.y + overlap, 0);
    baseTris = trianglesOf(geo);
  }
  if (baseTris) shells.push({ name: 'base', tris: baseTris });

  // Orientation: lying face up (z up as built), or standing (the logo's up becomes z).
  const toBed = o.orient === 'stand' ? new THREE.Matrix4().makeRotationX(Math.PI / 2) : new THREE.Matrix4();
  for (const s of shells) s.tris = s.tris.map(t => t.map(v => v.applyMatrix4(toBed)));
  // Sit on the bed (z = 0) and centre it.
  const all = new THREE.Box3();
  shells.forEach(s => s.tris.forEach(t => t.forEach(v => all.expandByPoint(v))));
  const shift = new THREE.Vector3(-(all.min.x + all.max.x) / 2, -(all.min.y + all.max.y) / 2, -all.min.z);
  shells.forEach(s => s.tris.forEach(t => t.forEach(v => v.add(shift))));
  all.translate(shift);

  // ── checks ──
  const checks = [];
  const fmt = (v, d = 1) => v.toFixed(d).replace('.', ',');
  const size = all.getSize(new THREE.Vector3());
  checks.push({ level: size.x > 250 || size.y > 250 || size.z > 250 ? 'warn' : 'ok',
    text: `Tamaño ${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm` + (size.x > 250 || size.y > 250 ? ': puede no caber en una cama de 220–250 mm.' : '.') });

  const open = shells.reduce((n, s) => n + openEdges(s.tris), 0);
  checks.push({ level: open ? 'warn' : 'ok',
    text: open ? `La malla tiene ${open} aristas abiertas: el laminador puede repararla, revisa el resultado.` : `Malla cerrada (${shells.length} cuerpo${shells.length > 1 ? 's' : ''}, sin aristas abiertas).` });

  const thick = (box.max.z - box.min.z) * k;
  checks.push({ level: thick < 1.2 ? 'warn' : 'ok',
    text: thick < 1.2 ? `El logo solo tiene ${fmt(thick)} mm de grosor: sube la profundidad para que no se rompa.` : `Grosor del logo ${fmt(thick)} mm.` });

  const thin = thinAreas(sil, ppm, o.minWall);
  checks.push({ level: thin.patches ? 'warn' : 'ok',
    text: thin.patches
      ? `${thin.patches} zona${thin.patches > 1 ? 's' : ''} más fina${thin.patches > 1 ? 's' : ''} de ${fmt(o.minWall)} mm (en rojo en el mapa): pueden salir incompletas. Aumenta el ancho o engrosa el trazo.`
      : `Sin paredes de menos de ${fmt(o.minWall)} mm.` });

  // Smallest piece and smallest hole, by the short side of their box.
  let minPiece = Infinity, minHole = Infinity;
  for (const p of pieces) {
    if (!p.outline) continue;
    p.outline.forEach((loop, li) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < loop.length; i += 2) { x0 = Math.min(x0, loop[i]); x1 = Math.max(x1, loop[i]); y0 = Math.min(y0, loop[i + 1]); y1 = Math.max(y1, loop[i + 1]); }
      const s = Math.min(x1 - x0, y1 - y0) * k;
      if (li === 0) minPiece = Math.min(minPiece, s); else minHole = Math.min(minHole, s);
    });
  }
  const small = minPiece < 1.5 || minHole < 1;
  checks.push({ level: small ? 'warn' : 'ok',
    text: `Detalle más pequeño: pieza de ${fmt(minPiece)} mm` + (minHole < Infinity ? `, hueco de ${fmt(minHole)} mm` : '') + (small ? ': puede perderse al imprimir.' : '.') });

  // Loose / floating pieces.
  const pieceShells = shells.filter(s => s.name === 'piece');
  if (o.orient === 'flat') {
    checks.push(o.base !== 'none' || pieceShells.length <= 1
      ? { level: 'ok', text: o.base !== 'none' ? 'Todas las piezas apoyan en la base y quedan unidas.' : 'Una sola pieza.' }
      : { level: 'info', text: `${pieceShells.length} piezas sueltas: se imprimen bien tumbadas, pero separadas. Añade una base para unirlas.` });
  } else {
    // Standing: a piece is floating if nothing holds it from below (it doesn't reach the foot).
    const floorZ = o.base !== 'none' ? o.baseThick + 0.05 : 0.05;
    const floating = pieceShells.filter(s => Math.min(...s.tris.flatMap(t => t.map(v => v.z))) > floorZ).length;
    checks.push(floating
      ? { level: 'warn', text: `${floating} pieza${floating > 1 ? 's' : ''} flotando en el aire de pie: necesitan soportes, o imprime el logo tumbado con base.` }
      : { level: 'ok', text: 'De pie, todas las piezas apoyan.' });
  }

  // Map: silhouette in grey, thin areas in red.
  const map = new OffscreenCanvas(sil.w, sil.h), mg = map.getContext('2d'), img = mg.createImageData(sil.w, sil.h);
  for (let i = 0; i < sil.w * sil.h; i++) {
    const t = thin.thin[i], ins = sil.inside[i];
    img.data[i * 4] = t ? 255 : ins ? 170 : 0;
    img.data[i * 4 + 1] = t ? 60 : ins ? 172 : 0;
    img.data[i * 4 + 2] = t ? 70 : ins ? 180 : 0;
    img.data[i * 4 + 3] = t || ins ? 255 : 0;
  }
  mg.putImageData(img, 0, 0);

  // The part, as one mesh per shell (millimetres), for the STL and the preview.
  const group = new THREE.Group();
  for (const s of shells) {
    const arr = new Float32Array(s.tris.length * 9);
    s.tris.forEach((t, i) => t.forEach((v, j) => arr.set([v.x, v.y, v.z], i * 9 + j * 3)));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo));
  }
  group.userData.size = size;
  return { group, checks, map };
}
