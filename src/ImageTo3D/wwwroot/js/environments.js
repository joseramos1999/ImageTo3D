// Reflection environments: what metal, glass and glossy materials reflect. Each is a small scene
// of light panels around the logo (HDR colours on unlit materials, as three's RoomEnvironment
// does), baked by the stage into a PMREM map. Built here, so they work without a connection.
//
// The camera looks at the logo from +z, so a face turned to the camera reflects what is behind
// the viewer (+z); the bevels and sides catch ±x and ±y, and a turning logo sweeps all of it.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const ENVIRONMENTS = [
  { id: 'studio', label: 'Estudio' },
  { id: 'softbox', label: 'Softbox' },
  { id: 'lightbox', label: 'Caja de luz' },
  { id: 'ring', label: 'Anillo de joyería' },
  { id: 'strip', label: 'Tira de luz' },
  { id: 'sunset', label: 'Atardecer' },
  { id: 'city', label: 'Ciudad de noche' },
  { id: 'neon', label: 'Neón' },
  { id: 'brand', label: 'Color de marca' },
];

/** A fixed pseudo-random 0..1 per index (the same city every time). */
const hash = n => { const s = Math.sin(n * 91.345 + 47.853) * 43758.5453; return s - Math.floor(s); };

/** A flat light (unlit, HDR) of w × h centred at pos, facing the logo. */
function panel(scene, w, h, pos, color, intensity) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
  m.position.set(...pos);
  m.lookAt(0, 0, 0);
  scene.add(m);
  return m;
}

/** A sky dome: colour by height (y of the direction), as vertex colours on a big sphere. */
function dome(scene, colorAt) {
  const geo = new THREE.SphereGeometry(40, 64, 32);
  const pos = geo.attributes.position, colors = new Float32Array(pos.count * 3), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    colorAt(pos.getY(i) / 40, c);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
}

const BUILD = {
  // Product photography: a large softbox overhead and in front, two tall strips at the sides.
  softbox(scene) {
    scene.background = new THREE.Color(0.012, 0.012, 0.014);
    panel(scene, 12, 6, [0, 9, 7], '#ffffff', 5);
    panel(scene, 1.4, 11, [-10, 1, 1], '#ffffff', 7);
    panel(scene, 1.4, 11, [10, 1, 1], '#ffffff', 7);
    panel(scene, 14, 7, [0, 2.5, 11], '#ffffff', 1.4);   // the bounce card the front face catches
  },
  // A light tent: bright almost everywhere, for clean, even reflections.
  lightbox(scene) {
    scene.background = new THREE.Color(0.85, 0.86, 0.88);
    panel(scene, 14, 14, [0, 11, 0], '#ffffff', 2.4);
    panel(scene, 16, 8, [0, 0, 12], '#ffffff', 1.4);
    panel(scene, 16, 10, [0, -9, 0], '#ffffff', 0.35);
  },
  // A jeweller's ring light in front: a bright circle in every polished face.
  ring(scene) {
    scene.background = new THREE.Color(0.01, 0.01, 0.012);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.38, 24, 96),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff6ea').multiplyScalar(9) }));
    ring.position.set(0, 0.6, 10);
    ring.lookAt(0, 0, 0);
    scene.add(ring);
    panel(scene, 6, 3, [0, 10, -2], '#ffffff', 1.2);
  },
  // Black with one long horizontal strip of light (and a fainter one behind): the car-advert look.
  strip(scene) {
    scene.background = new THREE.Color(0, 0, 0);
    panel(scene, 26, 0.55, [0, 4.5, 9], '#ffffff', 14);
    panel(scene, 22, 0.28, [0, -1.5, -10], '#ffffff', 5);
    panel(scene, 0.3, 14, [-11, 0, 3], '#ffffff', 3);
  },
  // Golden hour: a warm horizon under a violet sky, a low sun to one side, dark ground.
  sunset(scene) {
    const horizon = new THREE.Color(1.7, 0.62, 0.24), sky = new THREE.Color(0.14, 0.11, 0.36), ground = new THREE.Color(0.07, 0.045, 0.05);
    dome(scene, (y, c) => {
      if (y >= 0) c.copy(horizon).lerp(sky, Math.pow(Math.min(1, y / 0.55), 0.7));
      else c.copy(horizon).multiplyScalar(0.35).lerp(ground, Math.min(1, -y / 0.15));
    });
    const sun = new THREE.Mesh(new THREE.SphereGeometry(1.6, 24, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffc58a').multiplyScalar(24) }));
    sun.position.set(-13, 2.2, 15);
    scene.add(sun);
  },
  // Night city: rows of lit windows all round the horizon, and two neon signs.
  city(scene) {
    scene.background = new THREE.Color(0.006, 0.008, 0.02);
    const geo = new THREE.PlaneGeometry(0.42, 0.62);
    const mats = [new THREE.Color(1, 0.72, 0.38), new THREE.Color(0.55, 0.72, 1), new THREE.Color(1, 0.9, 0.7)]
      .map(c => new THREE.MeshBasicMaterial({ color: c.multiplyScalar(3.2), side: THREE.DoubleSide }));
    for (let i = 0; i < 220; i++) {
      const a = hash(i * 3 + 1) * Math.PI * 2, y = -2.5 + hash(i * 3 + 2) * 7, r = 14 + hash(i * 3 + 3) * 4;
      const w = new THREE.Mesh(geo, mats[Math.floor(hash(i * 7 + 5) * 3)]);
      w.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      w.lookAt(0, y, 0);
      scene.add(w);
    }
    panel(scene, 3.5, 1.1, [-9, 3.5, 8], '#ff2fa8', 6);
    panel(scene, 1.2, 4, [10, 2, -5], '#23e6ff', 6);
  },
  // Neon tubes: magenta and cyan at the sides, violet above.
  neon(scene) {
    scene.background = new THREE.Color(0.012, 0.006, 0.02);
    panel(scene, 0.6, 12, [-8, 0, 5], '#ff2fa8', 11);
    panel(scene, 0.6, 12, [8, 0, 5], '#23e6ff', 11);
    panel(scene, 9, 0.6, [0, 8, 2], '#8a5cff', 7);
    panel(scene, 10, 0.4, [0, -3, 10], '#ff7ad9', 3);
  },
  // The softbox, tinted with the brand colour (the material's «Color»): reflections in that colour.
  brand(scene, color) {
    const c = new THREE.Color(color);
    scene.background = c.clone().multiplyScalar(0.03);
    panel(scene, 12, 6, [0, 9, 7], c.clone().lerp(new THREE.Color(1, 1, 1), 0.55), 4.5);
    panel(scene, 1.4, 11, [-10, 1, 1], c, 8);
    panel(scene, 1.4, 11, [10, 1, 1], c, 8);
    panel(scene, 14, 7, [0, 2.5, 11], c.clone().lerp(new THREE.Color(1, 1, 1), 0.3), 1.4);
  },
};

/** The scene to bake for an environment, and the blur (sigma) for PMREMGenerator.fromScene. */
export function environmentScene(id, color = '#ffffff') {
  if (!BUILD[id]) return { scene: new RoomEnvironment(), sigma: 0.04 };
  const scene = new THREE.Scene();
  BUILD[id](scene, color);
  return { scene, sigma: 0.02 };
}

/** Frees what environmentScene built once it has been baked. */
export function disposeEnvironmentScene(scene) {
  scene.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
}
