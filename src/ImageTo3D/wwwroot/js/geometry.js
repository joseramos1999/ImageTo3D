// Outlines → extruded, bevelled meshes (one per separate piece of the logo).
// The colour texture they carry is built by colormap.js, in the pipeline worker.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildRelief, appendGeometry } from './relief.js';

export const LOGO_SIZE = 4;   // world units across the longest side of the logo
const RELIEF_CELL = LOGO_SIZE / 220;   // grid of the relief surface (~220 points across)

/** Outlines in field coordinates → normalised THREE.Shapes plus the mapping back
 *  to texture space. Y is flipped (image rows run down, world Y runs up). */
export function shapesFromOutlines(outlines, trace) {
  if (!outlines.length) return { shapes: [], layers: [], uvOf: () => new THREE.Vector2(), width: 0, height: 0 };
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
  // Layer of each shape (SVG paint order / colour regions); a plain trace is all layer 0.
  const layers = outlines.map(o => o.layer ?? 0);
  return { shapes, layers, uvOf, width: (maxX - minX) * k, height: (maxY - minY) * k };
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
 * opts: { depth, bevel, smoothness, layerStyle?, relief? }
 * relief: { mode, amount, edge, both, sample(u, v) } — see relief.js
 * layerStyle(layer) → { depth: multiplier, visible } for colour / SVG layers: a thicker layer
 * grows toward the front only, so every layer keeps the same back plane.
 */
export function buildLogoGroup(shapeSet, opts) {
  const { shapes, uvOf } = shapeSet;
  // Overlapping layers (a word painted over a badge) would share their front plane and
  // flicker: each layer is extruded a hair deeper than the one under it, so it sits in front.
  const layerOf = i => shapeSet.layers?.[i] ?? 0;
  const top = Math.max(0, ...(shapeSet.layers || [0]));
  const step = top ? Math.min(0.006, 0.05 / top) : 0;
  const styleOf = l => ({ depth: 1, visible: true, ...(opts.layerStyle?.(l) || {}) });
  const group = new THREE.Group();
  const bevel = Math.max(0, opts.bevel);
  const uvGen = planarUV(uvOf);

  shapes.forEach((shape, i) => {
    const layer = layerOf(i), style = styleOf(layer);
    if (!style.visible) return;
    // From the shared back plane (pushed back a hair per layer, like the front) to its own front.
    const bias = layer * step / 2;
    const depth = opts.depth * Math.max(0.05, style.depth) + 2 * bias;
    let geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      curveSegments: 2,
      steps: 1,
      bevelEnabled: bevel > 1e-4,
      bevelThickness: bevel * 0.8,
      bevelSize: bevel * 0.6,
      bevelSegments: Math.max(1, Math.min(6, 1 + opts.smoothness)),
      UVGenerator: uvGen,
    });
    geo.translate(0, 0, -opts.depth / 2 - bias);
    // Smooth shading across the bevel and curved walls, hard crease at real corners.
    geo = toCreasedNormals(geo, THREE.MathUtils.degToRad(35));
    flattenCaps(geo);
    geo.computeBoundingBox();
    if (opts.relief && opts.relief.mode !== 'none') {
      // The faces sit at the extremes in z (the bevel stays between them).
      const relief = buildRelief(shape, { ...opts.relief, cell: RELIEF_CELL, uvOf, frontZ: geo.boundingBox.max.z, backZ: geo.boundingBox.min.z });
      if (relief) { geo = appendGeometry(geo, relief); geo.computeBoundingBox(); }
    }
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
    mesh.userData.extent = geo.boundingBox.getSize(new THREE.Vector3());   // to scale a piece from its base
    mesh.userData.index = i;
    mesh.userData.layer = layer;
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
    m.userData.rankLayer = top ? m.userData.layer / top : 0;
  });
  group.userData.layerCount = top + 1;
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
