// «Mis looks»: the user's own complete looks — scene, material and animation (a single one, a
// sequence or keyframes) — saved from the app, listed first in «Predeterminadas», usable in a
// batch, and shared as .i3dlook files:
//   { app: 'ImageTo3D', kind: 'look', version: 1, name, set }
// A look read from a file is untrusted: only known keys are kept, every id must exist in its
// catalogue (else it is dropped and the default applies), numbers are clamped to the
// controls' ranges, colours must be #rrggbb.
import { ANIMATIONS } from './animations.js';
import { MATERIALS, BEVEL_MATERIALS } from './materials.js';
import { LIGHTING, FLOORS, CAMERA_MOVES, BACKGROUNDS } from './stage.js';
import { ENVIRONMENTS } from './environments.js';
import { KEY_PARAMS, KEY_EASES } from './keys.js';
import { PRESET_BASE } from './presets.js';

export const LOOK_EXT = 'i3dlook';
const APP_ID = 'ImageTo3D', KIND = 'look', VERSION = 1;
const MAX_BYTES = 256 * 1024;
export const NAME_MAX = 60;

const idsOf = (list, extra = []) => new Set([...list.map(x => x.id), ...extra]);
const animIds = kind => idsOf(ANIMATIONS.filter(a => a.kind === kind && (kind !== 'loop' || a.period)));
const COLOR = /^#[0-9a-f]{6}$/i;

/** Every key a look carries and how it is checked: a set of ids, a [min, max] range, or a type. */
const SPEC = {
  mode: new Set(['single', 'sequence', 'keys']),
  anim: idsOf(ANIMATIONS),
  speed: [0.1, 3],
  seqIntro: new Set([...animIds('intro'), 'none']),
  seqLoop: new Set([...animIds('loop'), 'none', 'still']),
  seqOutro: new Set([...animIds('outro'), 'none']),
  seqReps: [1, 20, 'int'],
  seqTransition: [0, 1.5],
  seqLoopSpeed: [0.25, 3],
  keys: 'keys',
  intensity: 'intensity',
  material: idsOf(MATERIALS),
  color: 'color',
  sideMode: new Set(['logo', 'custom', 'gradient']),
  sideColor: 'color',
  bevelMat: idsOf(BEVEL_MATERIALS),
  bevelColor: 'color',
  tune: 'tune',
  lighting: idsOf(LIGHTING),
  lightGain: [0.3, 2],
  lightAz: [-180, 180],
  lightEl: [-40, 70],
  env: idsOf(ENVIRONMENTS),
  envSpin: 'bool',
  floor: idsOf(FLOORS),
  bg: idsOf(BACKGROUNDS),
  camMove: idsOf(CAMERA_MOVES),
  camAmount: [0.2, 2],
  bloom: [0, 1.5],
  bloomTh: [0, 1],
  bloomRadius: [0, 1],
  bloomAlpha: 'bool',
  shine: 'bool',
  shineGain: [0.2, 3],
  particles: 'bool',
  density: [0.3, 3],
};
export const LOOK_KEYS = Object.keys(SPEC);

const clamp = (v, [lo, hi, int]) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const c = Math.max(lo, Math.min(hi, n));
  return int ? Math.round(c) : c;
};
const plainObject = v => v && typeof v === 'object' && !Array.isArray(v);

const TUNE = { roughness: [0, 1], metalness: [0, 1], clearcoat: [0, 1], emissive: [0, 2] };
const KEY_RANGES = Object.fromEntries(KEY_PARAMS.map(p => [p.id, [p.min, p.max]]));
const EASES = idsOf(KEY_EASES);

function cleanValue(key, v) {
  const spec = SPEC[key];
  if (spec instanceof Set) return typeof v === 'string' && spec.has(v) ? v : undefined;
  if (Array.isArray(spec)) return clamp(v, spec);
  if (spec === 'bool') return typeof v === 'boolean' ? v : undefined;
  if (spec === 'color') return typeof v === 'string' && COLOR.test(v) ? v.toLowerCase() : undefined;
  if (spec === 'tune') {
    if (!plainObject(v)) return undefined;
    const out = {};
    for (const [id, t] of Object.entries(v)) {
      if (!SPEC.material.has(id) || !plainObject(t)) continue;
      const c = {};
      for (const [k, range] of Object.entries(TUNE)) { const n = clamp(t[k], range); if (n !== undefined && t[k] != null) c[k] = n; }
      if (typeof t.tint === 'string' && COLOR.test(t.tint)) c.tint = t.tint.toLowerCase();
      if (Object.keys(c).length) out[id] = c;
    }
    return out;
  }
  if (spec === 'intensity') {
    if (!plainObject(v)) return undefined;
    const out = {};
    for (const [id, k] of Object.entries(v)) { const n = clamp(k, [0.25, 2]); if (SPEC.anim.has(id) && n !== undefined) out[id] = n; }
    return out;
  }
  if (spec === 'keys') {
    if (!plainObject(v) || !Array.isArray(v.points)) return undefined;
    return {
      ease: EASES.has(v.ease) ? v.ease : 'smooth',
      loop: v.loop === true,
      points: [0, 1, 2].map(i => {
        const p = plainObject(v.points[i]) ? v.points[i] : {}, out = {};
        for (const [id, range] of Object.entries(KEY_RANGES)) { const n = clamp(p[id], range); if (n !== undefined && p[id] != null) out[id] = n; }
        return out;
      }),
    };
  }
  return undefined;
}

/** Only known keys with valid values (anything else is dropped). */
export function sanitizeLook(set) {
  const out = {};
  if (!plainObject(set)) return out;
  for (const key of LOOK_KEYS) {
    if (!(key in set)) continue;
    const v = cleanValue(key, set[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** The current look, from the app's state. */
export function lookFromState(state) {
  return sanitizeLook(structuredClone(Object.fromEntries(LOOK_KEYS.filter(k => k in state).map(k => [k, state[k]]))));
}

/** Everything a look sets when applied: the presets' base, untuned, then the look itself. */
export const lookSettings = set => ({ ...PRESET_BASE, tune: {}, intensity: {}, ...set });

const same = (a, b) => (a && typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b ?? {}) : String(a) === String(b));
/** True when the current state is this look (its card shows as selected). */
export function matchesLook(set, state) {
  const full = lookSettings(set);
  const keys = full.mode === 'sequence' ? LOOK_KEYS.filter(k => k !== 'anim' && k !== 'keys')
    : full.mode === 'keys' ? LOOK_KEYS.filter(k => k !== 'anim' && !k.startsWith('seq'))
      : LOOK_KEYS.filter(k => !k.startsWith('seq') && k !== 'keys');
  return keys.every(k => !(k in full) || same(full[k], state[k]));
}

export function serializeLook(name, set) {
  return JSON.stringify({ app: APP_ID, kind: KIND, version: VERSION, name: String(name).slice(0, NAME_MAX), set: sanitizeLook(set) }, null, 2);
}

/** Reads an .i3dlook file → { name, set }. Throws an Error with a message for the user. */
export async function readLookFile(file) {
  if (file.size > MAX_BYTES) throw new Error('Ese archivo es demasiado grande para ser un look.');
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('El archivo no es un look de ImageTo3D válido.'); }
  if (!plainObject(data) || data.app !== APP_ID || data.kind !== KIND) throw new Error('El archivo no es un look de ImageTo3D.');
  if (data.version > VERSION) throw new Error('Este look se creó con una versión más nueva de ImageTo3D. Actualiza la aplicación.');
  const set = sanitizeLook(data.set);
  if (!Object.keys(set).length) throw new Error('El look no tiene ningún ajuste que esta versión entienda.');
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, NAME_MAX) : file.name.replace(/\.[^.]+$/, '').slice(0, NAME_MAX);
  return { name, set };
}
