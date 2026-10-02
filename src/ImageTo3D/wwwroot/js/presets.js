// "Predeterminadas": complete looks (animation + material + scene) applied in one click.
// Every preset sets every scene key, so the result is the same whatever was on before.
import { MATERIALS } from './materials.js';

const BASE = {
  anim: 'rotate-y', speed: 1, afterIntro: 'none', outro: 'none',
  material: 'logo', color: '#c8f55a', sideMode: 'logo',
  lighting: 'studio', lightGain: 1, floor: 'shadow', bg: 'vignette',
  bloom: 0, bloomTh: 0.85, bloomRadius: 0.35, particles: false, density: 1, camMove: 'none', camAmount: 1,
  lightAz: 0, lightEl: 0, shine: false, shineGain: 1,
};

const RAW = [
  { id: 'gold-lux', label: 'Oro de lujo',
    set: { anim: 'turntable', material: 'gold', lighting: 'dramatic', floor: 'mirror', bg: 'black', bloom: 0.25, bloomTh: 0.8, particles: true, density: 0.8, shine: true } },
  { id: 'chrome-y2k', label: 'Cromo Y2K',
    set: { anim: 'zoom-spin', material: 'chrome', lightGain: 1.1, floor: 'grid', bg: 'indigo', bloom: 0.3, bloomTh: 0.75, shine: true } },
  { id: 'neon-night', label: 'Neón nocturno',
    set: { anim: 'float', material: 'neon', color: '#ff2fa8', lighting: 'neon', floor: 'mirror', bg: 'black', bloom: 0.55, bloomTh: 0.75 } },
  { id: 'corporate', label: 'Corporativo',
    set: { anim: 'intro-rise', afterIntro: 'breathe', lighting: 'soft', floor: 'shadow', bg: 'white' } },
  { id: 'glass', label: 'Cristal',
    set: { anim: 'levitate', material: 'glass', color: '#7fd3ff', floor: 'mirror', bg: 'blue', bloom: 0.2 } },
  { id: 'diamond', label: 'Diamante',
    set: { anim: 'rotate-y', material: 'diamond', lightGain: 1.2, floor: 'mirror', bg: 'indigo', bloom: 0.45, bloomTh: 0.7, particles: true, density: 1.2 } },
  { id: 'hologram', label: 'Holograma',
    set: { anim: 'tilt-spin', material: 'holo', lighting: 'neon', floor: 'grid', bg: 'indigo', bloom: 0.5, bloomTh: 0.7, camMove: 'sway' } },
  { id: 'epic', label: 'Intro épica',
    set: { anim: 'intro-assemble', afterIntro: 'float', outro: 'outro-disassemble', lighting: 'dramatic', floor: 'mirror', bg: 'vignette', bloom: 0.2, particles: true, camMove: 'push' } },
  { id: 'toy', label: 'Juguete',
    set: { anim: 'bounce', material: 'plastic', color: '#ff4d5e', lighting: 'soft', floor: 'shadow', bg: 'cream' } },
  { id: 'sunset', label: 'Atardecer',
    set: { anim: 'swing', material: 'sunset', lighting: 'sunset', floor: 'mirror', bg: 'sunset', bloom: 0.3 } },
  { id: 'chroma', label: 'Pantalla verde',
    set: { anim: 'rotate-y', floor: 'none', bg: 'green' } },
  { id: 'gallery', label: 'Galería',
    set: { anim: 'drift', material: 'marble', lighting: 'soft', floor: 'shadow', bg: 'graphite', camMove: 'crane' } },
  { id: 'explosion', label: 'Explosión',
    set: { anim: 'explode', lighting: 'dramatic', floor: 'shadow', bg: 'vignette', bloom: 0.15 } },
  { id: 'cinema', label: 'Cine',
    set: { anim: 'intro-spin', afterIntro: 'levitate', outro: 'outro-dolly', material: 'titanium', lighting: 'dramatic', floor: 'mirror', bg: 'black', particles: true, density: 0.6, camMove: 'crane', shine: true } },
  { id: 'party', label: 'Fiesta',
    set: { anim: 'dance', material: 'rainbow', lighting: 'neon', floor: 'spot', bg: 'pink', bloom: 0.4, bloomTh: 0.7, particles: true, density: 1.5 } },
  { id: 'elegant', label: 'Elegante',
    set: { anim: 'flip-pause', material: 'obsidian', floor: 'mirror', bg: 'white', shine: true, shineGain: 0.7 } },
];

export const PRESETS = RAW.map(p => ({ ...p, set: { ...BASE, ...p.set } }));
export const PRESET_KEYS = Object.keys(BASE);

/** True when the current state is exactly this preset (so its card shows as selected). */
export function matchesPreset(preset, state) {
  const tinted = MATERIALS.find(m => m.id === preset.set.material)?.tint;
  return PRESET_KEYS.every(k => {
    if (k === 'color' && !tinted) return true;   // the tint only matters for materials that use it
    return String(state[k]) === String(preset.set[k]);
  });
}
