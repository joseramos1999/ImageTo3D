// Animation presets. Every preset is a pure function of time, so a frame can be
// rendered at any instant (that is what makes video export deterministic).
//
// Loops declare `period` (seconds per cycle at speed 1). The exporter fits a whole
// number of cycles into the clip so the last frame flows into the first.
// Intros declare `duration` and then hold the final pose.

const TAU = Math.PI * 2;
const clamp01 = x => Math.max(0, Math.min(1, x));
const easeInOut = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const easeOutCubic = x => 1 - Math.pow(1 - x, 3);
const easeOutQuart = x => 1 - Math.pow(1 - x, 4);
const easeInCubic = x => x * x * x;
const easeOutBack = (x, s = 1.70158) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2);
const easeOutElastic = x => x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * TAU / 3) + 1;
const easeOutBounce = x => {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
};
const hash = n => { const s = Math.sin(n * 91.345 + 47.853) * 43758.5453; return s - Math.floor(s); };

/** Staggered 0..1 progress for one piece: pieces start one after another by `rank`. */
const stagger = (q, rank, spread = 0.45) => clamp01((q - rank * spread) / (1 - spread));

// m = motion group, ps = pieces, p = phase 0..1 within the cycle, t = seconds
export const ANIMATIONS = [
  { id: 'none', label: 'Estático', kind: 'loop', period: 0, apply() {} },

  // ── Loops ──
  { id: 'rotate-y', label: 'Giro Y', kind: 'loop', period: 4,
    apply: ({ m, p }) => { m.rotation.y = TAU * p; } },
  { id: 'rotate-x', label: 'Giro X', kind: 'loop', period: 4, tall: true,
    apply: ({ m, p }) => { m.rotation.x = TAU * p; } },
  { id: 'spin-all', label: 'Giro total', kind: 'loop', period: 6, tall: true,
    apply: ({ m, p }) => { m.rotation.y = TAU * p; m.rotation.x = TAU * p; } },
  { id: 'turntable', label: 'Plato', kind: 'loop', period: 8,
    apply: ({ m, p }) => { m.rotation.y = TAU * p; m.rotation.x = -0.18; } },
  { id: 'swing', label: 'Vaivén', kind: 'loop', period: 3,
    apply: ({ m, p }) => { m.rotation.y = Math.sin(TAU * p) * 0.6; } },
  { id: 'float', label: 'Flotar', kind: 'loop', period: 4,
    apply: ({ m, p }) => {
      m.position.y = Math.sin(TAU * p) * 0.16;
      m.rotation.y = Math.sin(TAU * p) * 0.18;
      m.rotation.z = Math.sin(TAU * p + 1.2) * 0.04;
    } },
  { id: 'levitate', label: 'Levitar', kind: 'loop', period: 8,
    apply: ({ m, p }) => { m.rotation.y = TAU * p; m.position.y = Math.sin(TAU * 2 * p) * 0.12; } },
  { id: 'bounce', label: 'Rebote', kind: 'loop', period: 1.2,
    apply: ({ m, p }) => {
      const h = Math.abs(Math.sin(Math.PI * p));
      m.position.y = h * 0.7;
      const squash = Math.max(0, 1 - h * 5) * 0.14;   // squash only near the floor
      m.scale.set(1 + squash * 0.6, 1 - squash, 1 + squash * 0.6);
    } },
  { id: 'wobble', label: 'Tambaleo', kind: 'loop', period: 2,
    apply: ({ m, p }) => { m.rotation.z = Math.sin(TAU * p) * 0.18; m.rotation.x = Math.sin(TAU * 2 * p) * 0.08; } },
  { id: 'pulse', label: 'Pulso', kind: 'loop', period: 1.5,
    apply: ({ m, p }) => { m.scale.setScalar(1 + 0.08 * Math.sin(TAU * p)); } },
  { id: 'breathe', label: 'Respirar', kind: 'loop', period: 4,
    apply: ({ m, p }) => { const s = 1 + 0.05 * Math.sin(TAU * p); m.scale.set(s, s, 1 + 0.4 * Math.sin(TAU * p)); } },
  { id: 'flip', label: 'Voltereta', kind: 'loop', period: 2.5, tall: true,
    apply: ({ m, p }) => { m.rotation.x = TAU * easeInOut(clamp01(p / 0.7)); } },
  { id: 'coin-flip', label: 'Moneda', kind: 'loop', period: 2,
    apply: ({ m, p }) => {
      const q = clamp01(p / 0.75);
      m.rotation.y = TAU * 2 * easeInOut(q);
      m.position.y = Math.sin(Math.PI * q) * 0.6;
    } },
  { id: 'tumble', label: 'Caída libre', kind: 'loop', period: 6, tall: true,
    apply: ({ m, p }) => { m.rotation.x = TAU * p; m.rotation.y = TAU * 2 * p; m.rotation.z = Math.sin(TAU * p) * 0.3; } },
  { id: 'zoom-spin', label: 'Zoom giro', kind: 'loop', period: 4,
    apply: ({ m, p }) => { m.rotation.y = TAU * p; m.scale.setScalar(1 + 0.15 * Math.sin(TAU * 2 * p)); } },
  { id: 'orbit', label: 'Órbita', kind: 'loop', period: 5,
    apply: ({ m, p }) => {
      m.position.x = Math.sin(TAU * p) * 0.5;
      m.position.z = Math.cos(TAU * p) * 0.5 - 0.5;
      m.rotation.y = Math.sin(TAU * p) * 0.35;
      m.position.y = Math.sin(TAU * 2 * p) * 0.08;
    } },
  { id: 'glitch', label: 'Glitch', kind: 'loop', period: 2,
    apply: ({ m, ps, p }) => {
      const burst = (p > 0.08 && p < 0.18) || (p > 0.6 && p < 0.65);
      if (!burst) return;
      const f = Math.floor(p * 60);
      m.position.x = (hash(f) - 0.5) * 0.3;
      m.scale.x = 1 + (hash(f + 3) - 0.5) * 0.25;
      m.rotation.y = (hash(f + 7) - 0.5) * 0.3;
      ps.forEach((piece, i) => { piece.position.x += (hash(f * 13 + i) - 0.5) * 0.25; piece.position.z += (hash(f * 7 + i) - 0.5) * 0.4; });
    } },
  { id: 'wave', label: 'Ola', kind: 'loop', period: 2.5, pieces: true,
    apply: ({ ps, p }) => ps.forEach(piece => {
      const a = TAU * p - piece.userData.rankX * TAU;
      piece.position.z += Math.sin(a) * 0.35;
      piece.position.y += Math.sin(a) * 0.12;
      piece.rotation.x = Math.cos(a) * 0.35;
    }) },
  { id: 'cascade', label: 'Cascada', kind: 'loop', period: 4, pieces: true,
    apply: ({ ps, p }) => ps.forEach(piece => {
      piece.rotation.y = TAU * easeInOut(stagger(clamp01(p / 0.8), piece.userData.rankX, 0.5));
    }) },
  { id: 'explode', label: 'Explosión', kind: 'loop', period: 3, pieces: true,
    apply: ({ m, ps, p }) => {
      const k = Math.pow(Math.sin(Math.PI * p), 2);
      ps.forEach(piece => {
        const u = piece.userData, h = u.home;
        const len = Math.max(0.3, h.length());
        piece.position.x += (h.x / len) * k * 1.4;
        piece.position.y += (h.y / len) * k * 1.4;
        piece.position.z += (u.rand - 0.3) * k * 2.5;
        piece.rotation.set((u.rand - 0.5) * k * 3, (u.rand2 - 0.5) * k * 3, 0);
      });
      m.rotation.y = Math.sin(TAU * p) * 0.2;
    } },
  { id: 'dance', label: 'Baile', kind: 'loop', period: 2, pieces: true,
    apply: ({ ps, p }) => ps.forEach(piece => {
      const a = TAU * 2 * p + piece.userData.index * 1.3;
      piece.position.y += Math.abs(Math.sin(a / 2)) * 0.25;
      piece.rotation.z = Math.sin(a) * 0.15;
    }) },

  // ── Intros (play once, then hold) ──
  { id: 'intro-pop', label: 'Pop', kind: 'intro', duration: 1.2,
    apply: ({ m, q }) => { m.scale.setScalar(Math.max(0.001, easeOutBack(q, 2.2))); } },
  { id: 'intro-spin', label: 'Entrar girando', kind: 'intro', duration: 2,
    apply: ({ m, q }) => { const e = easeOutCubic(q); m.rotation.y = (1 - e) * TAU * 2; m.scale.setScalar(Math.max(0.001, e)); } },
  { id: 'intro-rise', label: 'Ascender', kind: 'intro', duration: 1.6,
    apply: ({ m, q }) => { const e = easeOutQuart(q); m.position.y = (1 - e) * -3; m.rotation.x = (1 - e) * 0.9; } },
  { id: 'intro-drop', label: 'Caer', kind: 'intro', duration: 1.6,
    apply: ({ m, q }) => { m.position.y = (1 - easeOutBounce(q)) * 4; } },
  { id: 'intro-dolly', label: 'Acercar', kind: 'intro', duration: 2.2,
    apply: ({ m, q }) => { const e = easeOutCubic(q); m.position.z = (1 - e) * -25; m.rotation.y = (1 - e) * -0.6; } },
  { id: 'intro-cardflip', label: 'Carta', kind: 'intro', duration: 1.6,
    apply: ({ m, q }) => { m.rotation.y = (1 - easeOutBack(q, 1.4)) * Math.PI; } },
  { id: 'intro-stamp', label: 'Sello', kind: 'intro', duration: 1.4,
    apply: ({ m, q }) => {
      if (q < 0.45) { const e = easeInCubic(q / 0.45); m.scale.setScalar(3.2 - 2.2 * e); m.rotation.z = (1 - e) * 0.3; return; }
      const r = (q - 0.45) / 0.55;
      const s = 1 + Math.sin(r * Math.PI * 3) * 0.06 * (1 - r);
      m.scale.set(s, 2 - s, 1);
    } },
  { id: 'intro-extrude', label: 'Extruir', kind: 'intro', duration: 1.6,
    apply: ({ m, q }) => { m.scale.z = Math.max(0.001, easeOutElastic(q)); m.rotation.y = (1 - easeOutCubic(q)) * -0.8; } },
  { id: 'intro-assemble', label: 'Ensamblar', kind: 'intro', duration: 2.4, pieces: true,
    apply: ({ ps, q }) => ps.forEach(piece => {
      const u = piece.userData;
      const e = easeOutCubic(stagger(q, u.rankX));
      const k = 1 - e;
      piece.position.x += (u.rand - 0.5) * 8 * k;
      piece.position.y += (u.rand2 - 0.5) * 6 * k;
      piece.position.z += 6 * k;
      piece.rotation.set((u.rand - 0.5) * 6 * k, (u.rand2 - 0.5) * 6 * k, 0);
      piece.scale.setScalar(Math.max(0.001, e));
    }) },
  { id: 'intro-cascade', label: 'Dominó', kind: 'intro', duration: 2, pieces: true,
    apply: ({ ps, q }) => ps.forEach(piece => {
      const e = easeOutBack(stagger(q, piece.userData.rankX, 0.6), 1.6);
      piece.rotation.x = (1 - e) * -Math.PI / 2;
      piece.position.y += (1 - e) * -0.5;
      piece.scale.setScalar(Math.max(0.001, clamp01(e * 3)));
    }) },
];

export const INTRO_HOLD = 1.6;   // preview pause between intro replays

export function getAnimation(id) {
  return ANIMATIONS.find(a => a.id === id) || ANIMATIONS[0];
}

/** Puts the motion group and pieces back at rest. */
export function resetPose(motion, pieces) {
  motion.position.set(0, 0, 0);
  motion.rotation.set(0, 0, 0);
  motion.scale.set(1, 1, 1);
  for (const piece of pieces) {
    piece.position.copy(piece.userData.home);
    piece.rotation.set(0, 0, 0);
    piece.scale.set(1, 1, 1);
  }
}

/**
 * Poses the logo at animation time `t` (seconds, already scaled by speed).
 * `once` = true plays intros once and holds (export); false loops them (preview).
 */
export function poseAt(anim, t, motion, pieces, once) {
  resetPose(motion, pieces);
  if (anim.kind === 'intro') {
    const span = anim.duration + INTRO_HOLD;
    const local = once ? t : ((t % span) + span) % span;
    anim.apply({ m: motion, ps: pieces, q: clamp01(local / anim.duration), t });
  } else if (anim.period > 0) {
    const p = ((t / anim.period) % 1 + 1) % 1;
    anim.apply({ m: motion, ps: pieces, p, t });
  }
}

/**
 * Seamless loop fitting: for a clip of `seconds` at user speed `speed`, returns
 * the effective speed that makes a whole number of cycles fit exactly.
 */
export function fitLoop(anim, seconds, speed) {
  if (anim.kind !== 'loop' || !anim.period) return { speed, cycles: 0 };
  const cycles = Math.max(1, Math.round(seconds * speed / anim.period));
  return { speed: cycles * anim.period / seconds, cycles };
}
