// Outlines → extruded, bevelled meshes (one per separate piece of the logo),
// plus the color texture that maps the original artwork back onto them.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { detectKey, inkValue } from './trace.js';

export const LOGO_SIZE = 4;   // world units across the longest side of the logo

/** Outlines in field coordinates → normalised THREE.Shapes plus the mapping back
 *  to texture space. Y is flipped (image rows run down, world Y runs up). */
export function shapesFromOutlines(outlines, trace) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of outlines) for (const p of o.outer) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const k = LOGO_SIZE / Math.max(maxX - minX, maxY - minY, 1e-6);
  const toWorld = p => new THREE.Vector2((p.x - cx) * k, -(p.y - cy) * k);

  // Field sample (x+1, y+1) is the centre of image pixel (x, y).
  const uvOf = (X, Y) => new THREE.Vector2(
    (X / k + cx - 0.5) / trace.w,
    (-Y / k + cy - 0.5) / trace.h);

  const shapes = outlines.map(o => {
    // ExtrudeGeometry wants a clockwise outline with counter-clockwise holes; it only
    // re-winds holes when it also had to re-wind the outline, so set both explicitly.
    let outer = o.outer.map(toWorld);
    if (!THREE.ShapeUtils.isClockWise(outer)) outer.reverse();
    const shape = new THREE.Shape(outer);
    for (const h of o.holes) {
      let hole = h.map(toWorld);
      if (THREE.ShapeUtils.isClockWise(hole)) hole.reverse();
      shape.holes.push(new THREE.Path(hole));
    }
    return shape;
  });
  return { shapes, uvOf, width: (maxX - minX) * k, height: (maxY - minY) * k };
}

/** Planar UVs everywhere: the caps show the artwork, and the side walls carry the
 *  colors of the rim straight back through the depth. */
function planarUV(uvOf) {
  const at = (v, i) => uvOf(v[i * 3], v[i * 3 + 1]);
  return {
    generateTopUV: (g, v, a, b, c) => [at(v, a), at(v, b), at(v, c)],
    generateSideWallUV: (g, v, a, b, c, d) => [at(v, a), at(v, b), at(v, c), at(v, d)],
  };
}

/**
 * Builds the logo: a Group with one Mesh per outline. Each mesh is centred on its
 * own pivot (userData.home) so per-piece animations can move pieces individually.
 * opts: { depth, bevel, smoothness }
 */
export function buildLogoGroup(shapeSet, opts) {
  const { shapes, uvOf } = shapeSet;
  const group = new THREE.Group();
  const bevel = Math.max(0, opts.bevel);
  const uvGen = planarUV(uvOf);

  shapes.forEach((shape, i) => {
    let geo = new THREE.ExtrudeGeometry(shape, {
      depth: opts.depth,
      curveSegments: 2,
      steps: 1,
      bevelEnabled: bevel > 1e-4,
      bevelThickness: bevel * 0.8,
      bevelSize: bevel * 0.6,
      bevelSegments: Math.max(1, Math.min(6, 1 + opts.smoothness)),
      UVGenerator: uvGen,
    });
    geo.translate(0, 0, -opts.depth / 2);
    // Smooth shading across the bevel and curved walls, hard crease at real corners.
    geo = toCreasedNormals(geo, THREE.MathUtils.degToRad(35));
    flattenCaps(geo);
    geo.computeBoundingBox();
    const center = new THREE.Vector3();
    geo.boundingBox.getCenter(center);
    center.z = 0;
    geo.translate(-center.x, -center.y, 0);
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo);
    mesh.position.copy(center);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.home = center.clone();
    mesh.userData.index = i;
    group.add(mesh);
  });

  // Per-piece ranks drive staggered animations (waves, cascades, assembly...).
  const pieces = group.children;
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  let maxR = 1e-6;
  pieces.forEach(m => { maxR = Math.max(maxR, m.userData.home.length()); });
  pieces.forEach((m, i) => {
    const h = m.userData.home;
    m.userData.rankX = size.x > 1e-6 ? (h.x - box.min.x) / size.x : 0.5;
    m.userData.rankY = size.y > 1e-6 ? (h.y - box.min.y) / size.y : 0.5;
    m.userData.rankR = h.length() / maxR;
    m.userData.rand = hash01(i * 7.13 + 1.7);
    m.userData.rand2 = hash01(i * 3.91 + 9.2);
  });
  group.userData.size = size;
  return group;
}

/** Creasing averages the rim normals of the caps with the first bevel ring, which
 *  shows the cap triangulation as faint facets. Caps are flat: make them so. */
function flattenCaps(geo) {
  const caps = geo.groups.find(g => g.materialIndex === 0);
  if (!caps) return;
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  for (let i = caps.start; i < caps.start + caps.count; i++) nrm.setXYZ(i, 0, 0, pos.getZ(i) > 0 ? 1 : -1);
  nrm.needsUpdate = true;
}

function hash01(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * The artwork as a texture. Transparent (non-ink) pixels are filled with the
 * nearest ink color (push-pull pyramid) so the bevel and the mip chain never
 * pick up black fringes from the background.
 */
export function buildColorCanvas(img, maxDim = 2048) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(1, maxDim / Math.max(iw, ih));
  const w = Math.max(2, Math.round(iw * s)), h = Math.max(2, Math.round(ih * s));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // Weight = how much each pixel is "logo". Opaque images use the same keying as the tracer.
  const key = detectKey(d, w, h);
  const weight = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    weight[p] = key.mode === 'alpha' ? d[i + 3] / 255 : inkValue(key, d[i], d[i + 1], d[i + 2], 255);
  }
  // Only pixels well inside the artwork are trusted as color sources: the rim of an
  // anti-aliased or JPEG logo is blended with the background, and the side walls
  // repeat whatever color the rim has all the way through the depth.
  let solid = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) solid[p] = weight[p] > 0.9 ? 1 : 0;
  const radius = Math.max(1, Math.round(Math.max(w, h) / 900));
  for (let i = 0; i < radius; i++) solid = erode(solid, w, h);
  // Near the rim, copy the nearest trusted color exactly; the pyramid fill below
  // only has to cover the far background, where nothing samples it closely.
  solid = dilateColors(d, solid, w, h, radius + 6);
  pushPull(d, solid, w, h);
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/** 3×3 binary erosion. If a pass would wipe out most of the artwork (hairline
 *  line-art), the previous mask is kept instead. */
function erode(src, w, h) {
  const out = new Uint8Array(w * h);
  let kept = 0, before = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!src[p]) continue;
    before++;
    if (x > 0 && x < w - 1 && y > 0 && y < h - 1 &&
        src[p - 1] && src[p + 1] && src[p - w] && src[p + w] &&
        src[p - w - 1] && src[p - w + 1] && src[p + w - 1] && src[p + w + 1]) { out[p] = 1; kept++; }
  }
  return kept > before * 0.2 ? out : src;
}

/** Grows the trusted region `passes` pixels outwards, each new pixel taking the
 *  average color of its trusted 8-neighbours. Returns the grown mask. */
function dilateColors(d, solid, w, h, passes) {
  let cur = solid;
  for (let pass = 0; pass < passes; pass++) {
    const next = cur.slice();
    let grew = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (cur[p]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!cur[q]) continue;
          r += d[q * 4]; g += d[q * 4 + 1]; b += d[q * 4 + 2]; n++;
        }
      }
      if (!n) continue;
      d[p * 4] = r / n; d[p * 4 + 1] = g / n; d[p * 4 + 2] = b / n;
      next[p] = 1;
      grew++;
    }
    cur = next;
    if (!grew) break;
  }
  return cur;
}

function pushPull(d, solid, w, h) {
  // Level 0: premultiplied color + weight.
  const levels = [];
  let lw = w, lh = h;
  let rgb = new Float32Array(w * h * 3), wt = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const a = solid[p];
    wt[p] = a;
    rgb[p * 3] = d[p * 4] * a; rgb[p * 3 + 1] = d[p * 4 + 1] * a; rgb[p * 3 + 2] = d[p * 4 + 2] * a;
  }
  levels.push({ rgb, wt, w: lw, h: lh });
  // Push: average down to 1x1.
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
    const nrgb = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(lw - 1, x * 2 + dx), sy = Math.min(lh - 1, y * 2 + dy);
        const q = sy * lw + sx;
        r += rgb[q * 3]; g += rgb[q * 3 + 1]; b += rgb[q * 3 + 2]; a += wt[q];
      }
      const o = y * nw + x;
      nrgb[o * 3] = r; nrgb[o * 3 + 1] = g; nrgb[o * 3 + 2] = b; nwt[o] = a;
    }
    rgb = nrgb; wt = nwt; lw = nw; lh = nh;
    levels.push({ rgb, wt, w: lw, h: lh });
  }
  // Pull: walk back up, filling empty pixels from the coarser level.
  for (let li = levels.length - 2; li >= 0; li--) {
    const L = levels[li], C = levels[li + 1];
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const p = y * L.w + x;
      if (L.wt[p] > 0) continue;
      const q = Math.min(C.h - 1, y >> 1) * C.w + Math.min(C.w - 1, x >> 1);
      const cw = C.wt[q] || 1;
      L.rgb[p * 3] = C.rgb[q * 3] / cw; L.rgb[p * 3 + 1] = C.rgb[q * 3 + 1] / cw; L.rgb[p * 3 + 2] = C.rgb[q * 3 + 2] / cw;
      L.wt[p] = 1;
    }
    if (li > 0) {
      // Coarse levels hold sums; normalise so the next level down reads averages.
      for (let p = 0; p < L.w * L.h; p++) {
        if (L.wt[p] > 1) { const a = L.wt[p]; L.rgb[p * 3] /= a; L.rgb[p * 3 + 1] /= a; L.rgb[p * 3 + 2] /= a; L.wt[p] = 1; }
      }
    }
  }
  const base = levels[0];
  for (let p = 0; p < w * h; p++) {
    if (!solid[p]) {
      d[p * 4] = base.rgb[p * 3]; d[p * 4 + 1] = base.rgb[p * 3 + 1]; d[p * 4 + 2] = base.rgb[p * 3 + 2];
    }
    d[p * 4 + 3] = 255;
  }
}
