// Relief: a height surface laid over a piece's front face (and optionally its back), so a
// flat logo becomes a medal, a puffy sticker or a carved plate. Heights come from one of:
//   'inflate' — a rounded dome that grows with the distance to the edge (no painting needed)
//   'paint'   — a 0..1 height map painted by hand or with gradients (relief-editor.js),
//               sampled in the artwork's UV space and eased to zero at the edge
// The surface is a grid inside the shape whose height is 0 at the outline, so it meets the
// flat face exactly; it is merged into the piece's geometry (cap material, animations,
// shadows and the GLB / STL exports all come with it).
import * as THREE from 'three';

export const DEFAULT_RELIEF = { mode: 'none', amount: 0.3, edge: 0.18, both: false, map: null };
const LIFT = 0.0015;        // above the flat face, which stays underneath (no z-fighting)

/**
 * Relief geometry for one shape (world units, before the piece is centred), non-indexed with
 * position / normal / uv, or null. o: { mode, amount, edge, both, cell, frontZ, backZ, uvOf, sample }
 *
 * The face's own triangulation is refined until no edge is longer than `cell`, so the surface
 * has its border exactly on the outline (height 0 there: it meets the flat face without a
 * step) and enough vertices inside to carry the relief.
 */
export function buildRelief(shape, o) {
  if (o.mode === 'none' || !(o.amount > 0)) return null;
  const { shape: outer, holes } = shape.extractPoints(1);
  if (outer.length < 3) return null;
  const pts = [...outer, ...holes.flat()];
  const faces = THREE.ShapeUtils.triangulateShape(outer, holes);
  if (!faces.length) return null;
  const mesh = refine(pts.map(v => [v.x, v.y]), faces, o.cell);

  // The height is worked out on a regular grid (smoothed evenly there), and the mesh only
  // samples it: height and slope, so the shading comes from the surface itself and not from
  // the shape of the triangles (the face's triangulation has long thin ones).
  const loops = [outer, ...holes];
  const edge = Math.max(o.cell, o.edge);
  const grid = heightGrid(loops, o, edge);
  const dist = distanceToOutline(mesh.verts, loops, edge);

  const n = mesh.verts.length, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
  const taperW = 2 * o.cell;
  for (let k = 0; k < n; k++) {
    const [x, y] = mesh.verts[k];
    const { h, gx, gy } = sampleGrid(grid, x, y);
    // Exactly flat on the outline, so the surface meets the face without a step.
    const t = Math.min(1, dist[k] / taperW), taper = t * t * (3 - 2 * t);
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = o.frontZ + LIFT + h * taper;
    const nx = -gx * taper, ny = -gy * taper, len = Math.hypot(nx, ny, 1);
    nrm[k * 3] = nx / len; nrm[k * 3 + 1] = ny / len; nrm[k * 3 + 2] = 1 / len;
    const uv = o.uvOf(x, y);
    uvs[k * 2] = uv.x; uvs[k * 2 + 1] = uv.y;
  }
  let front = new THREE.BufferGeometry();
  front.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  front.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  front.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  front.setIndex(orientUp(mesh.tris, mesh.verts));
  front = front.toNonIndexed();
  if (!o.both) return front;

  // The back: the same surface mirrored behind the back face, wound the other way.
  const back = front.clone();
  const bp = back.attributes.position, bn = back.attributes.normal, bu = back.attributes.uv;
  for (let k = 0; k < bp.count; k++) {
    bp.setZ(k, o.backZ - (bp.getZ(k) - o.frontZ));
    bn.setZ(k, -bn.getZ(k));
  }
  for (let k = 0; k < bp.count; k += 3) {
    for (const attr of [bp, bn, bu]) {
      for (let comp = 0; comp < attr.itemSize; comp++) {
        const t1 = attr.array[(k + 1) * attr.itemSize + comp];
        attr.array[(k + 1) * attr.itemSize + comp] = attr.array[(k + 2) * attr.itemSize + comp];
        attr.array[(k + 2) * attr.itemSize + comp] = t1;
      }
    }
  }
  return appendGeometry(front, back, false);
}

/**
 * Splits triangles until no edge is longer than maxLen. Each long edge gets one midpoint,
 * shared by both triangles on it, and every triangle is cut by the pattern of its split
 * edges (1, 2 or 3), so the mesh stays watertight. The outline's own edges are split too,
 * with their midpoints on the outline. verts: [[x, y]…], tris: [[a, b, c]…].
 */
function refine(verts, tris, maxLen) {
  const max2 = maxLen * maxLen;
  for (let pass = 0; pass < 14; pass++) {
    const mids = new Map();
    const key = (a, b) => a < b ? a * 4194304 + b : b * 4194304 + a;
    const long = (a, b) => { const dx = verts[a][0] - verts[b][0], dy = verts[a][1] - verts[b][1]; return dx * dx + dy * dy > max2; };
    const mid = (a, b) => {
      const k = key(a, b);
      let m = mids.get(k);
      if (m === undefined) { m = verts.length; verts.push([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2]); mids.set(k, m); }
      return m;
    };
    // Mark first (so both sides of an edge agree), then cut.
    let any = false;
    for (const [a, b, c] of tris) for (const [p, q] of [[a, b], [b, c], [c, a]]) if (long(p, q)) { mid(p, q); any = true; }
    if (!any) break;
    const out = [];
    for (const [a, b, c] of tris) {
      const ab = mids.get(key(a, b)), bc = mids.get(key(b, c)), ca = mids.get(key(c, a));
      const n = (ab !== undefined) + (bc !== undefined) + (ca !== undefined);
      if (n === 0) out.push([a, b, c]);
      else if (n === 3) out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      else if (n === 1) {
        if (ab !== undefined) out.push([a, ab, c], [ab, b, c]);
        else if (bc !== undefined) out.push([b, bc, a], [bc, c, a]);
        else out.push([c, ca, b], [ca, a, b]);
      } else {
        // Two split edges: cut the corner between them, then the rest along a diagonal.
        if (ab === undefined) out.push([c, ca, bc], [ca, a, b], [ca, b, bc]);
        else if (bc === undefined) out.push([a, ab, ca], [ab, b, c], [ab, c, ca]);
        else out.push([b, bc, ab], [bc, c, a], [bc, a, ab]);
      }
    }
    tris = out;
  }
  return { verts, tris };
}

/**
 * Heights on a regular grid over the shape (cell = o.cell, two cells of margin): the dome or
 * the painted map, eased in from the edge, then blurred twice (radius two cells) so the ridge
 * along the middle of a stroke and the map's pixel steps come out round.
 */
function heightGrid(loops, o, edge) {
  const c = o.cell;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of loops[0]) { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); }
  const x0 = minX - 2 * c, y0 = minY - 2 * c;
  const nx = Math.ceil((maxX - x0) / c) + 3, ny = Math.ceil((maxY - y0) / c) + 3;
  // Inside test: even-odd scanline per grid row.
  const inside = new Uint8Array(nx * ny), xs = [];
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * c;
    xs.length = 0;
    for (const loop of loops) for (let i = 0, n = loop.length; i < n; i++) {
      const a = loop[i], b = loop[(i + 1) % n];
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k] - x0) / c)), to = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / c));
      for (let i = from; i <= to; i++) inside[j * nx + i] = 1;
    }
  }
  const pts = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push([x0 + i * c, y0 + j * c]);
  const dist = distanceToOutline(pts, loops, edge);
  let h = new Float32Array(nx * ny);
  for (let p = 0; p < nx * ny; p++) {
    if (!inside[p]) continue;
    const t = Math.min(1, dist[p] / edge);
    if (o.mode === 'inflate') h[p] = o.amount * Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    else {
      const uv = o.uvOf(pts[p][0], pts[p][1]);
      h[p] = o.amount * (o.sample?.(uv.x, uv.y) ?? 0) * t * t * (3 - 2 * t);
    }
  }
  for (let k = 0; k < 2; k++) h = blur(h, nx, ny, 2);
  return { h, nx, ny, x0, y0, c };
}

function blur(src, nx, ny, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), w = 2 * r + 1;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let s = 0;
    for (let d = -r; d <= r; d++) s += src[j * nx + Math.max(0, Math.min(nx - 1, i + d))];
    tmp[j * nx + i] = s / w;
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let s = 0;
    for (let d = -r; d <= r; d++) s += tmp[Math.max(0, Math.min(ny - 1, j + d)) * nx + i];
    out[j * nx + i] = s / w;
  }
  return out;
}

/** Bilinear height and slope (central differences) of the grid at a world point. */
function sampleGrid({ h, nx, ny, x0, y0, c }, x, y) {
  const at = (i, j) => h[Math.max(0, Math.min(ny - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))];
  const fx = (x - x0) / c, fy = (y - y0) / c;
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const lerp2 = f => (f(i, j) * (1 - u) + f(i + 1, j) * u) * (1 - v) + (f(i, j + 1) * (1 - u) + f(i + 1, j + 1) * u) * v;
  return {
    h: lerp2(at),
    gx: lerp2((a, b) => (at(a + 1, b) - at(a - 1, b)) / (2 * c)),
    gy: lerp2((a, b) => (at(a, b + 1) - at(a, b - 1)) / (2 * c)),
  };
}

/** Index list with every triangle facing +z. */
function orientUp(tris, verts) {
  const idx = [];
  for (const [a, b, c] of tris) {
    const cross = (verts[b][0] - verts[a][0]) * (verts[c][1] - verts[a][1]) - (verts[b][1] - verts[a][1]) * (verts[c][0] - verts[a][0]);
    if (cross >= 0) idx.push(a, b, c); else idx.push(a, c, b);
  }
  return idx;
}

/** Distance from each vertex to the nearest outline segment, capped at `cap` (segments are
 *  binned on a grid of that size, so only nearby ones are checked). */
function distanceToOutline(verts, loops, cap) {
  const bins = new Map(), size = cap;
  const binKey = (i, j) => i * 100003 + j;
  for (const loop of loops) {
    for (let k = 0, n = loop.length; k < n; k++) {
      const a = loop[k], b = loop[(k + 1) % n];
      const i0 = Math.floor(Math.min(a.x, b.x) / size), i1 = Math.floor(Math.max(a.x, b.x) / size);
      const j0 = Math.floor(Math.min(a.y, b.y) / size), j1 = Math.floor(Math.max(a.y, b.y) / size);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const kk = binKey(i, j);
        if (!bins.has(kk)) bins.set(kk, []);
        bins.get(kk).push(a.x, a.y, b.x, b.y);
      }
    }
  }
  const out = new Float32Array(verts.length);
  verts.forEach(([x, y], v) => {
    const i = Math.floor(x / size), j = Math.floor(y / size);
    let best = cap * cap;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const segs = bins.get(binKey(i + di, j + dj));
      if (!segs) continue;
      for (let s = 0; s < segs.length; s += 4) {
        const ax = segs[s], ay = segs[s + 1], dx = segs[s + 2] - ax, dy = segs[s + 3] - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
        const ex = ax + t * dx - x, ey = ay + t * dy - y, d2 = ex * ex + ey * ey;
        if (d2 < best) best = d2;
      }
    }
    out[v] = Math.sqrt(best);
  });
  return out;
}

/**
 * Appends `extra` (non-indexed: position, normal, uv) to `geo` (non-indexed). With asCap, the
 * extra triangles become one more group drawn with material 0 (the face material).
 */
export function appendGeometry(geo, extra, asCap = true) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = geo.attributes[name], b = extra.attributes[name];
    if (!a || !b) continue;
    const arr = new Float32Array(a.array.length + b.array.length);
    arr.set(a.array, 0);
    arr.set(b.array, a.array.length);
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  const n = geo.attributes.position.count;
  if (geo.groups.length) geo.groups.forEach(g => out.addGroup(g.start, g.count, g.materialIndex));
  else if (asCap) out.addGroup(0, n, 0);
  if (asCap) out.addGroup(n, extra.attributes.position.count, 0);
  return out;
}

/** A painted height map: { w, h, data: Float32Array 0..1 } ↔ { w, h, b64 } (8-bit) for saving. */
export function encodeMap(map) {
  const bytes = new Uint8Array(map.data.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.max(0, Math.min(1, map.data[i])) * 255);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { w: map.w, h: map.h, b64: btoa(s) };
}

export function decodeMap(saved) {
  if (!saved?.b64 || !(saved.w > 0) || !(saved.h > 0)) return null;
  const bin = atob(saved.b64);
  if (bin.length !== saved.w * saved.h) return null;
  const data = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i) / 255;
  return { w: saved.w, h: saved.h, data };
}

/** Bilinear sample of a height map at UV (0..1, rows top to bottom). */
export function sampleMap(map, u, v) {
  if (!map) return 0;
  const x = Math.max(0, Math.min(map.w - 1, u * map.w - 0.5)), y = Math.max(0, Math.min(map.h - 1, v * map.h - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(map.w - 1, x0 + 1), y1 = Math.min(map.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0, D = map.data, W = map.w;
  return (D[y0 * W + x0] * (1 - fx) + D[y0 * W + x1] * fx) * (1 - fy) + (D[y1 * W + x0] * (1 - fx) + D[y1 * W + x1] * fx) * fy;
}
