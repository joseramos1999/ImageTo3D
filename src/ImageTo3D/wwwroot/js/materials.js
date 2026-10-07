// Material presets. Each returns [faceMaterial, sideMaterial] for the two
// groups ExtrudeGeometry produces (0 = front/back caps, 1 = walls + bevel).
import * as THREE from 'three';

const canvasTex = (w, h, draw, repeat = 1) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  if (repeat !== 1) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  return t;
};

const gradientTex = (stops, angle = 135) => canvasTex(512, 512, (ctx, w, h) => {
  const a = angle * Math.PI / 180, r = w / 2;
  const g = ctx.createLinearGradient(r - Math.cos(a) * r, r - Math.sin(a) * r, r + Math.cos(a) * r, r + Math.sin(a) * r);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
});

let cache = {};
const tex = (name, make) => cache[name] || (cache[name] = make());

const carbon = () => tex('carbon', () => canvasTex(256, 256, (ctx, w) => {
  ctx.fillStyle = '#0d0e10'; ctx.fillRect(0, 0, w, w);
  const s = w / 8;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const g = ctx.createLinearGradient(x * s, y * s, (x + 1) * s, (y + 1) * s);
    const on = (x + y) % 2 === 0;
    g.addColorStop(0, on ? '#2a2d33' : '#16181c'); g.addColorStop(1, on ? '#15171a' : '#2a2d33');
    ctx.fillStyle = g; ctx.fillRect(x * s + 1, y * s + 1, s - 2, s - 2);
  }
}, 6));

const marble = () => tex('marble', () => canvasTex(512, 512, (ctx, w, h) => {
  ctx.fillStyle = '#f2f0ec'; ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 14; i++) {
    ctx.strokeStyle = i % 3 ? '#b9b4ad' : '#8d877f';
    ctx.lineWidth = 0.6 + (i % 4) * 0.7;
    ctx.beginPath();
    let x = 0, y = (i * 53) % h;
    ctx.moveTo(x, y);
    while (x < w) { x += 18; y += Math.sin(x * 0.03 + i) * 9 + Math.sin(x * 0.11 + i * 2) * 4; ctx.lineTo(x, y); }
    ctx.stroke();
  }
}));

/**
 * Preset catalogue. `tint: true` means the color picker drives the base color.
 * make(o) receives { color: THREE.Color, logoMap, sideMode, sideColor }.
 */
export const MATERIALS = [
  { id: 'logo', label: 'Colores del logo', swatch: 'conic-gradient(#c8f55a,#5ab4f5,#f55a8c,#c8f55a)',
    make: o => {
      const face = new THREE.MeshPhysicalMaterial({ map: o.logoMap, roughness: 0.5, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.35 });
      const side = o.sideMode === 'custom'
        ? new THREE.MeshStandardMaterial({ color: o.sideColor, roughness: 0.45, metalness: 0.2 })
        : new THREE.MeshStandardMaterial({ map: o.logoMap, color: new THREE.Color(0.72, 0.72, 0.72), roughness: 0.45, metalness: 0.05 });
      return [face, side];
    } },
  { id: 'plastic', label: 'Plástico', tint: true, swatch: '#e94b5b',
    make: o => new THREE.MeshPhysicalMaterial({ color: o.color, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.15 }) },
  { id: 'matte', label: 'Mate', tint: true, swatch: '#9aa3b5',
    make: o => new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.92, metalness: 0 }) },
  { id: 'metal', label: 'Metal', tint: true, swatch: 'linear-gradient(135deg,#eee,#777)',
    make: o => new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.28, metalness: 1 }) },
  { id: 'gold', label: 'Oro', swatch: 'linear-gradient(135deg,#fff1b8,#e0a526,#7a5208)',
    make: () => new THREE.MeshPhysicalMaterial({ color: 0xf2bb48, roughness: 0.18, metalness: 1, clearcoat: 0.4, clearcoatRoughness: 0.1 }) },
  { id: 'chrome', label: 'Cromo', swatch: 'linear-gradient(135deg,#fff,#555 50%,#eee)',
    make: () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.04, metalness: 1 }) },
  { id: 'copper', label: 'Cobre', swatch: 'linear-gradient(135deg,#ffc8a8,#c46a3c,#5e2a12)',
    make: () => new THREE.MeshStandardMaterial({ color: 0xdb8459, roughness: 0.25, metalness: 1 }) },
  { id: 'rosegold', label: 'Oro rosa', swatch: 'linear-gradient(135deg,#ffe4dc,#e8a594,#8f5548)',
    make: () => new THREE.MeshStandardMaterial({ color: 0xf2b4a2, roughness: 0.2, metalness: 1 }) },
  { id: 'titanium', label: 'Titanio', swatch: 'linear-gradient(135deg,#d6dbe2,#7c838c)',
    // No anisotropy: without tangents in the geometry it shades flat areas with NaN, which the
    // bloom then spreads over the whole frame. Roughness and a thin clearcoat give the brushed look.
    make: () => new THREE.MeshPhysicalMaterial({ color: 0xa3a9b2, roughness: 0.34, metalness: 1, clearcoat: 0.15, clearcoatRoughness: 0.45 }) },
  { id: 'carbon', label: 'Carbono', swatch: 'repeating-linear-gradient(45deg,#111 0 4px,#2a2d33 4px 8px)',
    make: () => new THREE.MeshPhysicalMaterial({ map: carbon(), roughness: 0.45, metalness: 0.4, clearcoat: 1, clearcoatRoughness: 0.05 }) },
  { id: 'glass', label: 'Cristal', tint: true, swatch: 'linear-gradient(135deg,#e8f6ff,#9fd2f5)',
    // Glass reads as glass through refraction and bright edge reflections, so: no roughness,
    // real thickness, a strong environment, and the tint as absorption rather than surface color.
    make: o => new THREE.MeshPhysicalMaterial({
      color: 0xffffff, transmission: 1, roughness: 0, thickness: 1.6, ior: 1.5, metalness: 0,
      attenuationColor: o.color, attenuationDistance: 1.2, envMapIntensity: 2.2, specularIntensity: 1, clearcoat: 1,
    }) },
  { id: 'diamond', label: 'Diamante', swatch: 'linear-gradient(135deg,#fff,#cfe8ff,#ffd6f5,#fff)',
    make: () => new THREE.MeshPhysicalMaterial({
      color: 0xffffff, transmission: 1, roughness: 0, thickness: 2.2, ior: 2.4, dispersion: 6,
      iridescence: 0.55, iridescenceIOR: 1.8, iridescenceThicknessRange: [200, 700],
      envMapIntensity: 3, specularIntensity: 1, clearcoat: 1,
    }) },
  { id: 'ruby', label: 'Rubí', swatch: 'linear-gradient(135deg,#ff8095,#b0102a,#4a0010)',
    make: () => new THREE.MeshPhysicalMaterial({ color: 0xff3355, transmission: 0.9, roughness: 0.05, thickness: 1, ior: 1.77, attenuationColor: new THREE.Color(0xb0001c), attenuationDistance: 0.6, clearcoat: 1 }) },
  { id: 'emerald', label: 'Esmeralda', swatch: 'linear-gradient(135deg,#8ff5c0,#0f9a55,#003d1f)',
    make: () => new THREE.MeshPhysicalMaterial({ color: 0x33ff99, transmission: 0.9, roughness: 0.05, thickness: 1, ior: 1.58, attenuationColor: new THREE.Color(0x00843d), attenuationDistance: 0.6, clearcoat: 1 }) },
  { id: 'obsidian', label: 'Obsidiana', swatch: 'linear-gradient(135deg,#3a3a44,#050507)',
    make: () => new THREE.MeshPhysicalMaterial({ color: 0x0a0a0d, roughness: 0.06, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02 }) },
  { id: 'pearl', label: 'Perla', swatch: 'linear-gradient(135deg,#fffaf0,#e8dfd0,#f6e9ff)',
    make: () => new THREE.MeshPhysicalMaterial({ color: 0xf5efe6, roughness: 0.3, sheen: 1, sheenColor: new THREE.Color(0xffe6f2), iridescence: 0.6, iridescenceIOR: 1.4, clearcoat: 1 }) },
  { id: 'holo', label: 'Holográfico', swatch: 'linear-gradient(135deg,#a0f0ff,#ffa6f6,#fff3a0,#a0ffcf)',
    make: () => new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.12, metalness: 0.9, iridescence: 1, iridescenceIOR: 1.9, iridescenceThicknessRange: [120, 900] }) },
  { id: 'neon', label: 'Neón', tint: true, swatch: '#2dffd2',
    make: o => new THREE.MeshStandardMaterial({ color: o.color, emissive: o.color, emissiveIntensity: 1.4, roughness: 0.4 }) },
  { id: 'velvet', label: 'Terciopelo', tint: true, swatch: 'radial-gradient(#b23a6b,#4a0d27)',
    make: o => new THREE.MeshPhysicalMaterial({ color: o.color, roughness: 1, sheen: 1, sheenRoughness: 0.4, sheenColor: o.color.clone().lerp(new THREE.Color(1, 1, 1), 0.5) }) },
  { id: 'marble', label: 'Mármol', swatch: 'linear-gradient(135deg,#f6f4f0,#c9c3bb,#f6f4f0)',
    make: () => new THREE.MeshPhysicalMaterial({ map: marble(), roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.08 }) },
  { id: 'sunset', label: 'Atardecer', swatch: 'linear-gradient(135deg,#ffcf5a,#ff5a7a,#7a3cff)',
    make: () => new THREE.MeshPhysicalMaterial({ map: tex('sunset', () => gradientTex(['#ffcf5a', '#ff5a7a', '#7a3cff'])), roughness: 0.3, clearcoat: 0.7 }) },
  { id: 'ocean', label: 'Océano', swatch: 'linear-gradient(135deg,#5af5e0,#2b7bff,#1a1f7a)',
    make: () => new THREE.MeshPhysicalMaterial({ map: tex('ocean', () => gradientTex(['#5af5e0', '#2b7bff', '#1a1f7a'])), roughness: 0.3, clearcoat: 0.7 }) },
  { id: 'rainbow', label: 'Arcoíris', swatch: 'linear-gradient(90deg,#f55,#fb5,#ff5,#5f8,#5bf,#a5f)',
    make: () => new THREE.MeshPhysicalMaterial({ map: tex('rainbow', () => gradientTex(['#ff4d4d', '#ffb84d', '#fff04d', '#4dff88', '#4dbbff', '#a64dff'], 0)), roughness: 0.25, clearcoat: 0.8 }) },
  { id: 'wire', label: 'Wireframe', tint: true, swatch: 'repeating-linear-gradient(0deg,transparent 0 5px,#c8f55a 5px 6px),repeating-linear-gradient(90deg,#111 0 5px,#c8f55a 5px 6px)',
    make: o => new THREE.MeshBasicMaterial({ color: o.color, wireframe: true }) },
];

export function createMaterials(id, opts) {
  const preset = MATERIALS.find(m => m.id === id) || MATERIALS[0];
  const made = preset.make({ ...opts, color: new THREE.Color(opts.color), sideColor: new THREE.Color(opts.sideColor) });
  return Array.isArray(made) ? made : [made, made];
}

export function disposeMaterials(mats) {
  // Shared preset textures (carbon, gradients...) are cached and reused, so only the materials go.
  new Set(mats).forEach(m => m.dispose());
}
