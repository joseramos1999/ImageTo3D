// Animation presets. Every preset is a pure function of time, so a frame can be
// rendered at any instant (that is what makes video export deterministic).
//
// Loops declare `period` (seconds per cycle at speed 1). The exporter fits a whole
// number of cycles into the clip so the last frame flows into the first.
// Intros declare `duration` and then hold the final pose.
//
// Optional flags: `pieces` animates each piece separately; `tall` means the logo sweeps
// below its resting height (the floor drops to make room); `round` means it spins in its
// own plane, so the camera must frame the circle it sweeps, not its rectangle; `still` is
// the loop phase shown in preset thumbnails.

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
  { id: 'wave', label: 'Ola', kind: 'loop', period: 2.5, pieces: true, still: 0.3,
    apply: ({ ps, p }) => ps.forEach(piece => {
      const a = TAU * p - piece.userData.rankX * TAU;
      piece.position.z += Math.sin(a) * 0.35;
      piece.position.y += Math.sin(a) * 0.12;
      piece.rotation.x = Math.cos(a) * 0.35;
    }) },
  { id: 'cascade', label: 'Cascada', kind: 'loop', period: 4, pieces: true, still: 0.35,
    apply: ({ ps, p }) => ps.forEach(piece => {
      piece.rotation.y = TAU * easeInOut(stagger(clamp01(p / 0.8), piece.userData.rankX, 0.5));
    }) },
  { id: 'explode', label: 'Explosión', kind: 'loop', period: 3, pieces: true, still: 0.4,
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
  { id: 'dance', label: 'Baile', kind: 'loop', period: 2, pieces: true, still: 0.2,
    apply: ({ ps, p }) => ps.forEach(piece => {
      const a = TAU * 2 * p + piece.userData.index * 1.3;
      piece.position.y += Math.abs(Math.sin(a / 2)) * 0.25;
      piece.rotation.z = Math.sin(a) * 0.15;
    }) },

  { id: 'spin-z', label: 'Giro plano', kind: 'loop', period: 4, tall: true, round: true,
    apply: ({ m, p }) => { m.rotation.z = -TAU * p; } },
  { id: 'heartbeat', label: 'Latido', kind: 'loop', period: 1.2,
    apply: ({ m, p }) => {
      const beat = c => Math.exp(-Math.pow((p - c) / 0.055, 2));
      m.scale.setScalar(1 + 0.13 * beat(0.14) + 0.08 * beat(0.34));
    } },
  { id: 'pendulum', label: 'Péndulo', kind: 'loop', period: 2.4,
    apply: ({ m, p, size }) => {
      // Swings from a pivot at the top edge, not from the centre.
      const a = Math.sin(TAU * p) * 0.3, h = size.y / 2;
      m.rotation.z = a;
      m.position.set(Math.sin(a) * h, h * (1 - Math.cos(a)), 0);
    } },
  { id: 'rock', label: 'Mecer', kind: 'loop', period: 3,
    apply: ({ m, p }) => { m.rotation.x = Math.sin(TAU * p) * 0.35; m.position.z = Math.cos(TAU * p) * 0.1; } },
  { id: 'figure8', label: 'Ocho', kind: 'loop', period: 4,
    apply: ({ m, p }) => {
      m.position.x = Math.sin(TAU * p) * 0.6;
      m.position.y = Math.sin(TAU * 2 * p) * 0.22;
      m.rotation.y = Math.cos(TAU * p) * 0.3;
      m.rotation.z = -Math.cos(TAU * p) * 0.06;
    } },
  { id: 'tilt-spin', label: 'Peonza', kind: 'loop', period: 3,
    apply: ({ m, p }) => { m.rotation.x = Math.sin(TAU * p) * 0.32; m.rotation.y = Math.cos(TAU * p) * 0.32; } },
  { id: 'jelly', label: 'Gelatina', kind: 'loop', period: 1.6,
    apply: ({ m, p }) => {
      const w = Math.sin(TAU * 2 * p) * (0.6 + 0.4 * Math.cos(TAU * p));
      m.scale.set(1 + 0.1 * w, 1 - 0.1 * w, 1 + 0.05 * w);
    } },
  { id: 'shake', label: 'Vibrar', kind: 'loop', period: 2,
    apply: ({ m, p }) => {
      const env = Math.pow(Math.sin(Math.PI * clamp01(p / 0.35)), 2);   // short burst, then rest
      m.position.x = Math.sin(TAU * 14 * p) * 0.07 * env;
      m.rotation.z = Math.sin(TAU * 11 * p) * 0.04 * env;
    } },
  { id: 'flip-pause', label: 'Media vuelta', kind: 'loop', period: 4,
    apply: ({ m, p }) => { m.rotation.y = Math.PI * (easeInOut(clamp01(p / 0.35)) + easeInOut(clamp01((p - 0.5) / 0.35))); } },
  { id: 'drift', label: 'Deriva', kind: 'loop', period: 10,
    apply: ({ m, p }) => {
      m.rotation.y = Math.sin(TAU * p) * 0.5;
      m.rotation.x = Math.sin(TAU * 2 * p) * 0.12;
      m.position.y = Math.sin(TAU * p + 1) * 0.1;
    } },
  { id: 'ripple', label: 'Onda radial', kind: 'loop', period: 2.5, pieces: true, still: 0.3,
    apply: ({ ps, p }) => ps.forEach(piece => {
      const a = TAU * p - piece.userData.rankR * TAU;
      piece.position.z += Math.sin(a) * 0.3;
      piece.scale.setScalar(1 + 0.07 * Math.sin(a));
    }) },
  { id: 'typewriter', label: 'Teclear', kind: 'loop', period: 4, pieces: true, still: 0.6,
    apply: ({ ps, p }) => ps.forEach(piece => {
      const inn = easeOutBack(clamp01(stagger(clamp01(p / 0.5), piece.userData.rankX, 0.8)), 2);
      const out = 1 - easeInCubic(clamp01((p - 0.78) / 0.17));
      piece.scale.setScalar(Math.max(0.001, inn * out));
    }) },
  { id: 'flip-seq', label: 'Volteo en cadena', kind: 'loop', period: 3.5, pieces: true,
    apply: ({ ps, p }) => ps.forEach(piece => {
      piece.rotation.x = TAU * easeInOut(stagger(clamp01(p / 0.8), piece.userData.rankX, 0.6));
    }) },
  { id: 'satellite', label: 'Satélites', kind: 'loop', period: 3, pieces: true,
    apply: ({ ps, p }) => ps.forEach(piece => {
      const a = TAU * p + piece.userData.index * 2.4;
      piece.position.x += Math.cos(a) * 0.12;
      piece.position.y += Math.sin(a) * 0.12;
      piece.position.z += Math.sin(a + 1) * 0.25;
    }) },
  { id: 'swirl', label: 'Remolino', kind: 'loop', period: 3, pieces: true, still: 0.4, tall: true, round: true,
    apply: ({ ps, p }) => {
      const k = Math.pow(Math.sin(Math.PI * p), 2);
      ps.forEach(piece => {
        const h = piece.userData.home, a = k * (0.4 + piece.userData.rankR) * 1.3;
        piece.position.x = h.x * Math.cos(a) - h.y * Math.sin(a);
        piece.position.y = h.x * Math.sin(a) + h.y * Math.cos(a);
        piece.rotation.z = a;
      });
    } },
  { id: 'magnet', label: 'Imán', kind: 'loop', period: 2.5, pieces: true, still: 0.35,
    apply: ({ ps, p }) => {
      const k = Math.pow(Math.sin(Math.PI * p), 2);
      ps.forEach(piece => {
        const u = piece.userData;
        piece.position.x -= u.home.x * 0.55 * k;
        piece.position.y -= u.home.y * 0.55 * k;
        piece.position.z += (u.rand - 0.5) * 1.2 * k;
        piece.rotation.y = (u.rand2 - 0.5) * 1.5 * k;
      });
    } },
  { id: 'layers', label: 'Capas', kind: 'loop', period: 3, pieces: true, still: 0.35,
    apply: ({ m, ps, p }) => {
      const k = Math.pow(Math.sin(Math.PI * p), 2);
      ps.forEach(piece => { piece.position.z += (piece.userData.rankY - 0.5) * 1.6 * k; });
      m.rotation.y = Math.sin(TAU * p) * 0.45;
      m.rotation.x = -0.15 * k;
    } },

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
  { id: 'intro-zoom', label: 'Zoom', kind: 'intro', duration: 1.2,
    apply: ({ m, q }) => { const e = easeOutCubic(q); m.scale.setScalar(1 + 5 * (1 - e)); m.rotation.z = (1 - e) * -0.4; } },
  { id: 'intro-slide', label: 'Deslizar', kind: 'intro', duration: 1.4,
    apply: ({ m, q }) => { const e = easeOutBack(q, 1.2); m.position.x = (1 - e) * -9; m.rotation.y = (1 - e) * 0.8; } },
  { id: 'intro-swing', label: 'Bisagra', kind: 'intro', duration: 1.8,
    apply: ({ m, q, size }) => {
      // Falls forward into place, hinged on its bottom edge.
      const a = (1 - easeOutElastic(q)) * -Math.PI / 2, h = size.y / 2;
      m.rotation.x = a;
      m.position.set(0, -h + h * Math.cos(a), -h * Math.sin(a));
    } },
  { id: 'intro-tumble', label: 'Volteretas', kind: 'intro', duration: 2,
    apply: ({ m, q }) => { const e = easeOutCubic(q); m.rotation.x = (1 - e) * TAU * 1.5; m.position.z = (1 - e) * -14; } },
  { id: 'intro-glitch', label: 'Glitch', kind: 'intro', duration: 1.5, pieces: true,
    apply: ({ m, ps, q }) => {
      if (q >= 1) return;
      const f = Math.floor(q * 40), amp = 1 - q;
      m.position.x = (hash(f) - 0.5) * 0.5 * amp;
      m.scale.x = 1 + (hash(f + 5) - 0.5) * 0.5 * amp;
      ps.forEach((piece, i) => {
        if (hash(f * 17 + i) > q * 1.3) piece.scale.setScalar(0.001);
        piece.position.x += (hash(f * 3 + i) - 0.5) * 0.6 * amp;
      });
    } },
  { id: 'intro-typewriter', label: 'Teclear', kind: 'intro', duration: 2, pieces: true,
    apply: ({ ps, q }) => ps.forEach(piece => {
      piece.scale.setScalar(Math.max(0.001, easeOutBack(stagger(q, piece.userData.rankX, 0.85), 2.2)));
    }) },
  { id: 'intro-sprout', label: 'Brotar', kind: 'intro', duration: 2, pieces: true,
    apply: ({ ps, q }) => ps.forEach(piece => {
      const s = stagger(q, piece.userData.rankX, 0.6), e = easeOutBack(s, 1.8);
      piece.position.y += (1 - e) * -2.5;
      piece.scale.setScalar(Math.max(0.001, clamp01(s * 4)));
    }) },
  { id: 'intro-spiral', label: 'Espiral', kind: 'intro', duration: 2.4, pieces: true,
    apply: ({ ps, q }) => ps.forEach(piece => {
      const u = piece.userData, k = 1 - easeOutCubic(stagger(q, u.rankR, 0.4));
      const a = k * TAU * 1.5 + u.index, r = k * 6;
      piece.position.x += Math.cos(a) * r;
      piece.position.y += Math.sin(a) * r;
      piece.position.z += k * -4;
      piece.rotation.z = k * TAU;
      piece.scale.setScalar(Math.max(0.001, 1 - k * 0.7));
    }) },
  { id: 'intro-tiles', label: 'Fichas', kind: 'intro', duration: 2, pieces: true,
    apply: ({ ps, q }) => ps.forEach(piece => {
      const s = stagger(q, piece.userData.rankX, 0.6);
      piece.rotation.y = (1 - easeOutBack(s, 1.6)) * Math.PI;
      if (s <= 0) piece.scale.setScalar(0.001);
    }) },
  { id: 'intro-rain', label: 'Lluvia', kind: 'intro', duration: 2.4, pieces: true,
    apply: ({ ps, q }) => ps.forEach(piece => {
      const s = stagger(q, piece.userData.rand, 0.5);
      piece.position.y += (1 - easeOutBounce(s)) * 5;
      if (s <= 0) piece.scale.setScalar(0.001);
    }) },
  { id: 'intro-unfold', label: 'Desplegar', kind: 'intro', duration: 1.8, pieces: true,
    apply: ({ ps, q }) => ps.forEach(piece => {
      const s = stagger(q, 1 - piece.userData.rankY, 0.5);
      piece.rotation.x = (1 - easeOutBack(s, 1.4)) * Math.PI / 2;
      if (s <= 0) piece.scale.setScalar(0.001);
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
  const size = pieces[0]?.parent?.userData.size || { x: 4, y: 2, z: 0.4 };
  if (anim.kind === 'intro') {
    const span = anim.duration + INTRO_HOLD;
    const local = once ? t : ((t % span) + span) % span;
    anim.apply({ m: motion, ps: pieces, q: clamp01(local / anim.duration), t, size });
  } else if (anim.period > 0) {
    const p = ((t / anim.period) % 1 + 1) % 1;
    anim.apply({ m: motion, ps: pieces, p, t, size });
  }
}

/** A representative instant for a still (preset thumbnails). Loops may set `still`, the
 *  phase where they look most characteristic (an explosion mid-burst, not at rest). */
export function stillTime(anim) {
  if (anim.kind === 'intro') return anim.duration;
  return anim.period ? anim.period * (anim.still ?? 0.08) : 0;
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
