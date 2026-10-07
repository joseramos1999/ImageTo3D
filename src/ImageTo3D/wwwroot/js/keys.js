// Keyframe animation, the simple way: three points (start, middle, end) for the logo's
// position, rotation, scale, opacity and glow, the camera and the light, interpolated over
// the clip ("Duración"). Optionally it comes back to the start, closing a seamless loop.
// Like every animation it is a pure function of time: export and preview match.
import { resetPose, fx } from './animations.js';

/** Every keyable value: its group in the panel, range and resting value. */
export const KEY_PARAMS = [
  { id: 'px', group: 'Posición', label: 'X', min: -4, max: 4, step: 0.05, rest: 0 },
  { id: 'py', group: 'Posición', label: 'Y', min: -3, max: 3, step: 0.05, rest: 0 },
  { id: 'pz', group: 'Posición', label: 'Z (profundidad)', min: -12, max: 4, step: 0.1, rest: 0 },
  { id: 'rx', group: 'Rotación', label: 'X', min: -360, max: 360, step: 5, rest: 0, unit: '°' },
  { id: 'ry', group: 'Rotación', label: 'Y', min: -360, max: 360, step: 5, rest: 0, unit: '°' },
  { id: 'rz', group: 'Rotación', label: 'Z', min: -360, max: 360, step: 5, rest: 0, unit: '°' },
  { id: 's', group: 'Logo', label: 'Escala', min: 0, max: 3, step: 0.05, rest: 1, unit: 'x' },
  { id: 'op', group: 'Logo', label: 'Opacidad', min: 0, max: 1, step: 0.05, rest: 1, unit: '%' },
  { id: 'glow', group: 'Logo', label: 'Brillo propio', min: 0, max: 1.5, step: 0.05, rest: 0 },
  { id: 'zoom', group: 'Cámara', label: 'Zoom', min: 0.4, max: 3, step: 0.05, rest: 1, unit: 'x' },
  { id: 'orbit', group: 'Cámara', label: 'Órbita', min: -180, max: 180, step: 5, rest: 0, unit: '°' },
  { id: 'height', group: 'Cámara', label: 'Altura', min: -60, max: 60, step: 5, rest: 0, unit: '°' },
  { id: 'laz', group: 'Luz', label: 'Dirección', min: -180, max: 180, step: 5, rest: 0, unit: '°' },
  { id: 'lel', group: 'Luz', label: 'Elevación', min: -60, max: 60, step: 5, rest: 0, unit: '°' },
  { id: 'lgain', group: 'Luz', label: 'Intensidad', min: 0, max: 2.5, step: 0.05, rest: 1, unit: '%' },
];

export const KEY_POINTS = ['Inicio', 'Medio', 'Final'];
export const KEY_EASES = [
  { id: 'smooth', label: 'Curva suave' },      // through the middle without stopping
  { id: 'pause', label: 'Pausa en el medio' }, // eases in and out of every point
  { id: 'linear', label: 'Lineal' },
];

/** A first example: comes from the back turning, overshoots a little, settles. */
export const DEFAULT_KEYS = {
  ease: 'smooth',
  loop: false,
  points: [{ pz: -6, ry: -90, s: 0.6, op: 0 }, { ry: 15, s: 1.05, glow: 0.3 }, {}],
};

const rest = Object.fromEntries(KEY_PARAMS.map(p => [p.id, p.rest]));
export const keyValue = (point, id) => point?.[id] ?? rest[id];
const easeInOut = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** Value of one parameter at u (0..1 through the clip). */
function interpolate(keys, id, u) {
  const v = keys.points.map(p => keyValue(p, id));
  // With «loop», the points sit at 0, ⅓ and ⅔ and the curve comes back to the start at 1.
  const pts = keys.loop ? [v[0], v[1], v[2], v[0]] : v;
  const segs = pts.length - 1;
  const x = Math.max(0, Math.min(1, u)) * segs;
  const i = Math.min(segs - 1, Math.floor(x)), s = x - i;
  const a = pts[i], b = pts[i + 1];
  if (keys.ease === 'linear') return a + (b - a) * s;
  if (keys.ease === 'pause') return a + (b - a) * easeInOut(s);
  // Smooth: a Hermite curve with Catmull-Rom tangents, so it passes through the middle point
  // at speed; at the ends of an open clip it starts and stops at rest, in a loop it wraps.
  const at = k => keys.loop ? pts[((k % segs) + segs) % segs] : pts[Math.max(0, Math.min(segs, k))];
  const tangent = k => {
    if (!keys.loop && (k === 0 || k === segs)) return 0;
    return (at(k + 1) - at(k - 1)) / 2;
  };
  const m0 = tangent(i), m1 = tangent(i + 1);
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * a + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * b + (s3 - s2) * m1;
}

/** Whether any point leaves this parameter off its resting value (so its effect is needed). */
const used = (keys, id) => keys.points.some(p => Math.abs(keyValue(p, id) - rest[id]) > 1e-6);

/** The keyframes as a timeline: { kind: 'keys', clip, pose(t, motion, pieces) }. */
export function keysTimeline(keys = DEFAULT_KEYS, seconds = 6) {
  const deg = Math.PI / 180;
  const k = { ...DEFAULT_KEYS, ...keys, points: [0, 1, 2].map(i => keys?.points?.[i] || {}) };
  const on = Object.fromEntries(KEY_PARAMS.map(p => [p.id, used(k, p.id)]));
  return {
    kind: 'keys',
    clip: seconds,
    keys: k,
    pose(t, motion, pieces) {
      resetPose(motion, pieces);
      const u = seconds > 0 ? t / seconds : 0, v = id => interpolate(k, id, u);
      motion.position.set(v('px'), v('py'), v('pz'));
      motion.rotation.set(v('rx') * deg, v('ry') * deg, v('rz') * deg);
      motion.scale.setScalar(Math.max(0.001, v('s')));
      if (on.op) fx.opacity(Math.max(0, Math.min(1, v('op'))));
      if (on.glow) fx.glow(Math.max(0, v('glow')));
      if (on.zoom || on.orbit || on.height) fx.camera({ zoom: Math.max(0.1, v('zoom')), orbit: v('orbit') * deg, height: v('height') * deg });
      if (on.laz || on.lel || on.lgain) fx.light({ az: v('laz'), el: v('lel'), gain: Math.max(0, v('lgain')) });
    },
  };
}
