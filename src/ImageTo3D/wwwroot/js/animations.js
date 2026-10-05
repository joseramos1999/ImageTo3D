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

/** Linear keyframes: keys = [[q, value], ...] with q ascending (Animate.css-style curves). */
const kf = (q, keys) => {
  if (q <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [q1, v1] = keys[i];
    if (q <= q1) { const [q0, v0] = keys[i - 1]; return v0 + (v1 - v0) * (q - q0) / (q1 - q0); }
  }
  return keys[keys.length - 1][1];
};
/** Keyframes eased in and out between keys: holds that start and stop softly. */
const ekf = (q, keys) => {
  if (q <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [q1, v1] = keys[i];
    if (q <= q1) { const [q0, v0] = keys[i - 1]; return v0 + (v1 - v0) * easeInOut((q - q0) / (q1 - q0)); }
  }
  return keys[keys.length - 1][1];
};
const deg = d => d * Math.PI / 180;
/** Bottom-anchored vertical scale: how far to lower an object of height h scaled by sy. */
const sink = (sy, h) => -(1 - sy) * h / 2;

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

  // Attention seekers after Animate.css: the move, then a rest, so they read as a "beat".
  { id: 'rubber-band', label: 'Goma', kind: 'loop', period: 1.8,
    apply: ({ m, p }) => {
      const q = clamp01(p / 0.6);
      m.scale.set(
        kf(q, [[0, 1], [0.3, 1.25], [0.4, 0.75], [0.5, 1.15], [0.65, 0.95], [0.75, 1.05], [1, 1]]),
        kf(q, [[0, 1], [0.3, 0.75], [0.4, 1.25], [0.5, 0.85], [0.65, 1.05], [0.75, 0.95], [1, 1]]), 1);
    } },
  { id: 'tada', label: '¡Tachán!', kind: 'loop', period: 2.2,
    apply: ({ m, p }) => {
      const q = clamp01(p / 0.55);
      m.scale.setScalar(kf(q, [[0, 1], [0.1, 0.9], [0.2, 0.9], [0.3, 1.1], [0.9, 1.1], [1, 1]]));
      m.rotation.z = kf(q, [[0, 0], [0.1, deg(-3)], [0.2, deg(-3)], [0.3, deg(3)], [0.4, deg(-3)], [0.5, deg(3)],
        [0.6, deg(-3)], [0.7, deg(3)], [0.8, deg(-3)], [0.9, deg(3)], [1, 0]]);
    } },
  { id: 'head-shake', label: 'Negar', kind: 'loop', period: 2,
    apply: ({ m, p }) => {
      const q = clamp01(p / 0.5);
      m.position.x = kf(q, [[0, 0], [0.065, -0.12], [0.185, 0.1], [0.315, -0.06], [0.435, 0.04], [0.5, 0], [1, 0]]);
      m.rotation.y = kf(q, [[0, 0], [0.065, deg(-12)], [0.185, deg(10)], [0.315, deg(-6)], [0.435, deg(4)], [0.5, 0], [1, 0]]);
    } },
  { id: 'nod', label: 'Asentir', kind: 'loop', period: 4,
    // Quiet micro-motion: one small nod, then stillness for most of the cycle.
    apply: ({ m, p }) => {
      const q = clamp01(p / 0.25), b = Math.sin(Math.PI * q);
      m.rotation.x = b * 0.12 * (1 - 0.4 * q);
      m.position.y = -b * 0.04;
    } },
  { id: 'bounce-spin', label: 'Rebote con giro', kind: 'loop', period: 1.6,
    apply: ({ m, p }) => { m.position.y = Math.abs(Math.sin(Math.PI * p)) * 0.7; m.rotation.y = TAU * p; } },
  { id: 'spin-pulse', label: 'Giro con pulso', kind: 'loop', period: 3,
    apply: ({ m, p }) => { m.rotation.y = TAU * p; m.scale.setScalar(1 + 0.1 * Math.sin(TAU * 2 * p)); } },
  { id: 'sweep', label: 'Barrido', kind: 'loop', period: 3.5, still: 0.5,
    // Wipes in from the left, holds, wipes out to the right (hidden at both ends: seamless).
    apply: ({ p, size, clip }) => {
      const half = size.x / 2 + 0.2;
      if (p < 0.35) clip('x', -half + 2 * half * easeInOut(p / 0.35));
      else if (p > 0.65) clip('x', -half + 2 * half * easeInOut((p - 0.65) / 0.35), true);
    } },
  { id: 'helix', label: 'Hélice', kind: 'loop', period: 3, pieces: true,
    apply: ({ ps, p }) => ps.forEach(piece => {
      const a = TAU * p + piece.userData.rankX * TAU;
      piece.position.z += Math.sin(a) * 0.5;
      piece.position.y += Math.cos(a) * 0.18;
      piece.rotation.y = Math.sin(a) * 0.6;
    }) },
  { id: 'wave-crest', label: 'Cresta', kind: 'loop', period: 2.2, pieces: true, still: 0.35,
    // A single crest runs along the logo and lifts each piece as it passes.
    apply: ({ ps, p }) => ps.forEach(piece => {
      const d = ((p - piece.userData.rankX * 0.7) % 1 + 1) % 1;
      const bump = Math.exp(-Math.pow((d - 0.15) / 0.07, 2));
      piece.position.y += bump * 0.5;
      piece.rotation.x = -bump * 0.4;
    }) },
  { id: 'flicker', label: 'Parpadeo neón', kind: 'loop', period: 3, pieces: true,
    apply: ({ ps, p }) => {
      if (!((p > 0.02 && p < 0.14) || (p > 0.55 && p < 0.6))) return;
      const f = Math.floor(p * 90);
      ps.forEach((piece, i) => { if (hash(f * 31 + i * 7) > 0.55) piece.visible = false; });
    } },
  { id: 'equalizer', label: 'Ecualizador', kind: 'loop', period: 2, pieces: true, still: 0.3,
    // Each piece jumps like a bar of a music visualiser, from its base, at its own whole-number rate.
    apply: ({ ps, p }) => ps.forEach(piece => {
      const u = piece.userData, f = 1 + Math.floor(u.rand * 3);
      const sy = 1 + 0.7 * Math.pow(Math.sin(Math.PI * (f * p + u.rand2)), 2);
      piece.scale.y = sy;
      piece.position.y -= sink(sy, u.extent.y);
    }) },
  { id: 'relief', label: 'Relieve', kind: 'loop', period: 2.5, pieces: true, still: 0.3,
    // A wave of depth: each piece pushes out of the logo and sinks back, left to right.
    apply: ({ m, ps, p }) => {
      ps.forEach(piece => {
        const a = TAU * p - piece.userData.rankX * TAU;
        piece.scale.z = 1 + 1.4 * Math.pow(0.5 + 0.5 * Math.sin(a), 2);
      });
      m.rotation.y = Math.sin(TAU * p) * 0.35;
    } },
  { id: 'zero-g', label: 'Gravedad cero', kind: 'loop', period: 8, pieces: true, still: 0.25,
    // Pieces drift apart and turn slowly, each on its own path, as if weightless.
    apply: ({ m, ps, p }) => {
      const a = TAU * p;
      ps.forEach(piece => {
        const u = piece.userData, ph = u.rand * TAU, ph2 = u.rand2 * TAU;
        piece.position.x += Math.sin(a + ph) * 0.08;
        piece.position.y += Math.sin(2 * a + ph2) * 0.1;
        piece.position.z += Math.sin(a + ph2) * 0.35;
        piece.rotation.set(Math.sin(a + ph2) * 0.25, Math.sin(a + ph) * 0.3, Math.sin(2 * a + ph) * 0.12);
      });
      m.position.y = Math.sin(a) * 0.08;
    } },
  { id: 'cylinder', label: 'Cilindro', kind: 'loop', period: 5, pieces: true, still: 0.3,
    // The logo curls into a ring, spins once around it and lies flat again.
    apply: ({ m, ps, p, size }) => {
      const k = Math.pow(Math.sin(Math.PI * p), 2);
      m.rotation.y = TAU * easeInOut(p);
      if (k < 1e-4) return;
      const r0 = size.x / (TAU * 0.8), c = k / r0;   // bent into 80 % of a ring at the peak
      ps.forEach(piece => {
        const h = piece.userData.home, th = h.x * c;
        piece.position.x = Math.sin(th) / c;
        piece.position.z = h.z + (Math.cos(th) - 1) / c + k * r0;   // centred on the spin axis
        piece.rotation.y = th;
      });
    } },
  { id: 'step-turn', label: 'Paso a paso', kind: 'loop', period: 4,
    // Four snappy quarter turns with a little hop, each followed by a pause.
    apply: ({ m, p }) => {
      const s = p * 4, i = Math.floor(s), f = clamp01((s - i) / 0.45);
      m.rotation.y = (i + easeOutBack(f, 2.2)) * TAU / 4;
      m.position.y = Math.sin(Math.PI * f) * 0.08;
    } },
  { id: 'flag', label: 'Bandera', kind: 'loop', period: 2, pieces: true, still: 0.25,
    // Ripples like a flag on a pole: still at the left edge, waving more toward the right.
    apply: ({ ps, p }) => ps.forEach(piece => {
      const r = piece.userData.rankX, a = TAU * p - r * 4, amp = r * r;
      piece.position.z += Math.sin(a) * 0.45 * amp;
      piece.position.y += Math.sin(a - 0.8) * 0.06 * amp;
      piece.rotation.y = Math.cos(a) * 0.45 * amp;   // follows the slope of the wave
    }) },
  { id: 'glance', label: 'Mirada', kind: 'loop', period: 5,
    // Looks up to one side, then down to the other, and blinks.
    apply: ({ m, p }) => {
      m.rotation.y = ekf(p, [[0, 0], [0.1, 0.42], [0.32, 0.42], [0.45, -0.42], [0.7, -0.42], [0.82, 0], [1, 0]]);
      m.rotation.x = ekf(p, [[0, 0], [0.1, -0.12], [0.32, -0.12], [0.45, 0.08], [0.7, 0.08], [0.82, 0], [1, 0]]);
      m.position.x = m.rotation.y * 0.15;
      m.scale.y = 1 - 0.14 * Math.exp(-Math.pow((p - 0.9) / 0.012, 2));
    } },
  { id: 'backflip', label: 'Mortal', kind: 'loop', period: 2, tall: true,
    // Crouches, jumps into a backflip and lands with a squash.
    apply: ({ m, p, size }) => {
      let sy = 1, sx = 1;
      if (p < 0.15) {
        const c = Math.sin(Math.PI * p / 0.15);
        sy = 1 - 0.12 * c; sx = 1 + 0.08 * c;
      } else if (p < 0.75) {
        const q = (p - 0.15) / 0.6;
        m.position.y = Math.sin(Math.PI * q) * 1.5;
        m.rotation.x = -TAU * easeInOut(q);
      } else {
        const c = Math.sin(Math.PI * (p - 0.75) / 0.25);
        sy = 1 - 0.14 * c; sx = 1 + 0.1 * c;
      }
      m.scale.set(sx, sy, sx);
      m.position.y += sink(sy, size.y);
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
  // Entrances after Animate.css (back, bounce, flip, light speed, rotate, jack-in-the-box, roll)
  { id: 'intro-back-in', label: 'Desde el fondo', kind: 'intro', duration: 1.4,
    apply: ({ m, q }) => {
      const a = easeOutCubic(clamp01(q / 0.7)), b = easeOutBack(clamp01((q - 0.7) / 0.3), 2);
      m.position.y = (1 - a) * 5;
      m.position.z = (1 - a) * -4;
      m.scale.setScalar(0.7 + 0.3 * b);
    } },
  { id: 'intro-bounce-in', label: 'Rebote', kind: 'intro', duration: 1.1,
    apply: ({ m, q }) => { m.scale.setScalar(Math.max(0.001, kf(q, [[0, 0.3], [0.2, 1.1], [0.4, 0.9], [0.6, 1.03], [0.8, 0.97], [1, 1]]) * clamp01(q * 8))); } },
  { id: 'intro-flip-x', label: 'Voltear', kind: 'intro', duration: 1.3,
    apply: ({ m, q }) => { m.rotation.x = kf(q, [[0, deg(90)], [0.4, deg(-20)], [0.6, deg(10)], [0.8, deg(-5)], [1, 0]]); } },
  { id: 'intro-lightspeed', label: 'Velocidad luz', kind: 'intro', duration: 1.1,
    apply: ({ m, q }) => {
      const a = easeOutCubic(clamp01(q / 0.6));
      m.position.x = (1 - a) * 11;
      m.scale.x = 1 + (1 - a) * 0.8;
      m.rotation.z = kf(q, [[0, deg(-12)], [0.6, deg(8)], [0.8, deg(-3)], [1, 0]]);
    } },
  { id: 'intro-rotate-corner', label: 'Girar desde esquina', kind: 'intro', duration: 1.4,
    apply: ({ m, q, size }) => {
      // Swings up into place around its bottom-left corner.
      const a = (1 - easeOutBack(q, 1.3)) * deg(-110);
      const px = -size.x / 2, py = -size.y / 2, c = Math.cos(a), s = Math.sin(a);
      m.rotation.z = a;
      m.position.set(px - (c * px - s * py), py - (s * px + c * py), 0);
    } },
  { id: 'intro-jack', label: 'Sorpresa', kind: 'intro', duration: 1.5,
    apply: ({ m, q, size }) => {
      const s = Math.max(0.001, kf(q, [[0, 0.1], [0.5, 1.05], [0.7, 0.97], [1, 1]]));
      m.scale.setScalar(s);
      m.position.y = -(1 - s) * size.y / 2;   // grows from the bottom edge
      m.rotation.z = kf(q, [[0, deg(30)], [0.5, deg(-10)], [0.7, deg(3)], [1, 0]]);
    } },
  { id: 'intro-roll', label: 'Rodar', kind: 'intro', duration: 1.5,
    apply: ({ m, q }) => { const e = easeOutCubic(q); m.position.x = (1 - e) * -10; m.rotation.z = (1 - e) * TAU; } },
  // From the original 3D animator's catalogue
  { id: 'intro-split', label: 'Dividir', kind: 'intro', duration: 1.6, pieces: true,
    apply: ({ ps, q }) => ps.forEach(piece => {
      const e = easeOutCubic(q), side = piece.userData.home.x < 0 ? -1 : 1;
      piece.position.x += side * (1 - e) * 7;
      piece.rotation.y = side * (1 - e) * -0.8;
    }) },
  { id: 'intro-stretch', label: 'Estirar', kind: 'intro', duration: 1.4,
    apply: ({ m, q }) => { const e = easeOutElastic(q); m.scale.set(Math.max(0.001, e), 1 + (1 - clamp01(e)) * 0.6, 1); } },
  { id: 'intro-emerge', label: 'Emerger', kind: 'intro', duration: 2,
    // Rises out of an invisible floor at its own baseline.
    apply: ({ m, q, size, clip }) => {
      if (q >= 1) return;
      m.position.y = (1 - easeOutCubic(q)) * -(size.y + 0.3);
      clip('y', -size.y / 2 - 0.02, true);
    } },
  { id: 'intro-print', label: 'Impresión 3D', kind: 'intro', duration: 2.6,
    // Built up layer by layer from the bottom, like a 3D printer.
    apply: ({ q, size, clip }) => {
      if (q >= 1) return;
      const layers = 28, h = Math.floor(q * layers + 1) / layers;
      clip('y', -size.y / 2 - 0.05 + (size.y + 0.1) * h);
    } },
  { id: 'intro-neon', label: 'Neón', kind: 'intro', duration: 1.8, pieces: true,
    // Each piece buzzes on like a neon tube: a few flickers, then steady.
    apply: ({ ps, q }) => ps.forEach((piece, i) => {
      const on = 0.15 + piece.userData.rand * 0.55;
      if (q < on) { piece.visible = false; return; }
      const f = Math.floor(q * 60);
      if (q < on + 0.12 && hash(f * 13 + i * 5) > 0.5) piece.visible = false;
    }) },
  { id: 'intro-iris', label: 'Iris', kind: 'intro', duration: 1.6, pieces: true,
    // Opens from the centre outwards.
    apply: ({ ps, q }) => ps.forEach(piece => {
      const e = easeOutBack(stagger(q, piece.userData.rankR, 0.55), 1.8);
      piece.scale.setScalar(Math.max(0.001, e));
      piece.rotation.z = (1 - clamp01(e)) * 0.6;
    }) },
  { id: 'intro-orbit', label: 'Órbita', kind: 'intro', duration: 2.4,
    // Spirals in from far away, circling round to land in front of the camera.
    apply: ({ m, q }) => {
      const k = 1 - easeOutCubic(q), a = k * TAU * 1.25;
      m.position.set(Math.sin(a) * 7 * k, k * 1.5, -(1 - Math.cos(a)) * 5 * k - k * 4);
      m.rotation.y = -a * 0.5;
      m.scale.setScalar(Math.max(0.001, clamp01(q * 4)));
    } },
  { id: 'intro-wipe', label: 'Cortina', kind: 'intro', duration: 1.6,
    // Revealed from left to right while it turns to face the camera.
    apply: ({ m, q, size, clip }) => {
      if (q >= 1) return;
      const half = size.x / 2 + 0.2;
      clip('x', -half + 2 * half * easeInOut(q));
      m.rotation.y = (1 - easeOutCubic(q)) * 0.5;
    } },
  { id: 'intro-swing-in', label: 'Columpio', kind: 'intro', duration: 2.2,
    // Swings down from the side, hanging from its top edge, and settles.
    apply: ({ m, q, size }) => {
      const a = deg(95) * Math.exp(-2.5 * q) * Math.cos(TAU * 1.6 * q) * (1 - q), h = size.y / 2;
      m.rotation.z = a;
      m.position.set(Math.sin(a) * h, h * (1 - Math.cos(a)), 0);
    } },
  { id: 'intro-meteor', label: 'Meteoro', kind: 'intro', duration: 1.8,
    // Falls from high up and far back, faster and faster, and lands with a squash and a shake.
    apply: ({ m, q, size }) => {
      if (q < 0.5) {
        const k = 1 - easeInCubic(q / 0.5);
        m.position.set(k * 7, k * 6, k * -12);
        m.rotation.set(k * 2.5, k * -1.5, k * 1.2);
        return;
      }
      const r = (q - 0.5) / 0.5, d = Math.exp(-5 * r) * Math.cos(TAU * 2.5 * r) * (1 - r);
      m.scale.set(1 + 0.18 * d, 1 - 0.22 * d, 1 + 0.1 * d);
      m.position.set(Math.sin(TAU * 7 * r) * 0.06 * (1 - r) ** 2, sink(1 - 0.22 * d, size.y), 0);
    } },
  { id: 'intro-fan', label: 'Abanico', kind: 'intro', duration: 1.8, pieces: true,
    // The pieces start stacked in a column and open out like a hand fan around a point below.
    apply: ({ ps, q, size }) => {
      const k = 1 - easeOutBack(q, 1.3), py = -size.y * 0.9;
      ps.forEach(piece => {
        const h = piece.userData.home, dy = h.y - py;
        const f = k * Math.atan2(h.x, dy), c = Math.cos(f), s = Math.sin(f);
        piece.position.x = c * h.x - s * dy;
        piece.position.y = py + s * h.x + c * dy;
        piece.rotation.z = f;
        piece.scale.setScalar(Math.max(0.001, clamp01(q * 5)));
      });
    } },
  { id: 'intro-boomerang', label: 'Bumerán', kind: 'intro', duration: 2.2,
    // Thrown in from the right: it curves away behind, comes back round from the left, spinning.
    apply: ({ m, q }) => {
      const k = 1 - easeOutCubic(q), a = k * TAU * 0.75;
      m.position.set(-Math.sin(a) * 6, k * 0.8, (Math.cos(a) - 1) * 4);
      m.rotation.z = a * 2;
      m.rotation.x = -0.4 * k;
    } },
  { id: 'intro-sculpt', label: 'Esculpir', kind: 'intro', duration: 2, pieces: true,
    // Starts as a flat cut-out and each piece springs out into depth, left to right.
    apply: ({ m, ps, q }) => {
      ps.forEach(piece => { piece.scale.z = Math.max(0.001, easeOutElastic(stagger(q, piece.userData.rankX, 0.6))); });
      m.rotation.y = (1 - easeInOut(q)) * -0.7;
      m.rotation.x = (1 - easeInOut(q)) * 0.25;
    } },
];

// ── Outros (exits): the last part of a complete clip ──
// Most are intros played backwards: an intro ends exactly at rest, so its reverse starts
// there and joins the loop without a jump, and its easing turns into an accelerating exit.
const REVERSED_INTROS = [
  ['intro-pop', 'outro-shrink', 'Encoger'],
  ['intro-spin', 'outro-spin', 'Salir girando'],
  ['intro-zoom', 'outro-zoom', 'Zoom a cámara'],
  ['intro-dolly', 'outro-dolly', 'Alejarse'],
  ['intro-rise', 'outro-sink', 'Hundirse'],
  ['intro-slide', 'outro-slide', 'Deslizar fuera'],
  ['intro-tumble', 'outro-tumble', 'Volteretas fuera'],
  ['intro-cardflip', 'outro-cardflip', 'Carta fuera'],
  ['intro-extrude', 'outro-flatten', 'Aplanar'],
  ['intro-stretch', 'outro-squeeze', 'Aplastar'],
  ['intro-back-in', 'outro-back', 'Hacia el fondo'],
  ['intro-flip-x', 'outro-flip-x', 'Voltear fuera'],
  ['intro-lightspeed', 'outro-lightspeed', 'Velocidad luz'],
  ['intro-roll', 'outro-roll', 'Rodar fuera'],
  ['intro-jack', 'outro-jack', 'Sorpresa fuera'],
  ['intro-swing', 'outro-swing', 'Bisagra fuera'],
  ['intro-emerge', 'outro-submerge', 'Sumergirse'],
  ['intro-print', 'outro-unprint', 'Desimprimir'],
  ['intro-assemble', 'outro-disassemble', 'Desmontar'],
  ['intro-typewriter', 'outro-backspace', 'Borrar'],
  ['intro-split', 'outro-split', 'Separar'],
  ['intro-spiral', 'outro-spiral', 'Espiral fuera'],
  ['intro-unfold', 'outro-fold', 'Plegar'],
  ['intro-iris', 'outro-iris', 'Cerrar iris'],
  ['intro-neon', 'outro-neon', 'Apagar neón'],
  ['intro-glitch', 'outro-glitch', 'Glitch fuera'],
  ['intro-orbit', 'outro-orbit', 'Órbita fuera'],
  ['intro-wipe', 'outro-wipe', 'Cerrar cortina'],
  ['intro-fan', 'outro-fan', 'Cerrar abanico'],
  ['intro-boomerang', 'outro-boomerang', 'Bumerán fuera'],
];
for (const [from, id, label] of REVERSED_INTROS) {
  const src = ANIMATIONS.find(a => a.id === from);
  if (!src) continue;
  ANIMATIONS.push({ id, label, kind: 'outro', duration: src.duration, pieces: src.pieces, tall: src.tall,
    apply: ctx => src.apply({ ...ctx, q: 1 - ctx.q }) });
}
ANIMATIONS.push(
  { id: 'outro-fall', label: 'Caer', kind: 'outro', duration: 1.2,
    apply: ({ m, q }) => { const e = easeInCubic(q); m.position.y = -e * 7; m.rotation.z = e * 0.5; m.rotation.x = e * 0.4; } },
  { id: 'outro-fly-up', label: 'Salir volando', kind: 'outro', duration: 1.2,
    apply: ({ m, q }) => {
      const e = q < 0.25 ? -Math.sin(Math.PI * q / 0.25) * 0.08 : easeInCubic((q - 0.25) / 0.75);   // crouch, then launch
      m.position.y = e * 7;
      m.scale.set(1 + (q < 0.25 ? 0.06 * Math.sin(Math.PI * q / 0.25) : 0), 1 - (q < 0.25 ? 0.08 * Math.sin(Math.PI * q / 0.25) : -0.15 * e), 1);
    } },
  { id: 'outro-explode', label: 'Explotar', kind: 'outro', duration: 1.4, pieces: true,
    apply: ({ ps, q }) => {
      const e = easeInCubic(q);
      ps.forEach(piece => {
        const u = piece.userData, h = u.home, len = Math.max(0.3, h.length());
        piece.position.x += (h.x / len) * e * 6;
        piece.position.y += (h.y / len) * e * 6 + (u.rand2 - 0.5) * e * 2;
        piece.position.z += (u.rand - 0.2) * e * 8;
        piece.rotation.set((u.rand - 0.5) * e * 8, (u.rand2 - 0.5) * e * 8, (u.rand - 0.5) * e * 4);
        piece.scale.setScalar(Math.max(0.001, 1 - clamp01((q - 0.6) / 0.4)));
      });
    } },
  { id: 'outro-vortex', label: 'Sumidero', kind: 'outro', duration: 1.8, pieces: true,
    // Swallowed by a whirlpool: the outer pieces first, spinning ever faster into the centre.
    apply: ({ ps, q }) => ps.forEach(piece => {
      const u = piece.userData, h = u.home;
      const s = easeInCubic(stagger(q, 1 - u.rankR, 0.4)), a = s * TAU * 1.5, r = 1 - s;
      piece.position.x = (h.x * Math.cos(a) - h.y * Math.sin(a)) * r;
      piece.position.y = (h.x * Math.sin(a) + h.y * Math.cos(a)) * r;
      piece.position.z = h.z - s * 2;
      piece.rotation.z = a;
      piece.scale.setScalar(Math.max(0.001, 1 - s));
    }) },
  { id: 'outro-melt', label: 'Derretir', kind: 'outro', duration: 2, pieces: true,
    // Each piece slumps and spreads into a puddle at the foot of the logo, which then dries up.
    apply: ({ ps, q, size }) => ps.forEach(piece => {
      const u = piece.userData, ext = u.extent, h = u.home;
      const d = easeInCubic(clamp01(q * 1.3 - u.rand * 0.3));
      const sy = Math.max(0.02, 1 - d), dry = 1 - clamp01((q - 0.85) / 0.15);
      const bottom = h.y - ext.y / 2 + (-size.y / 2 - (h.y - ext.y / 2)) * d;
      piece.scale.set(Math.max(0.001, (1 + 0.35 * d) * dry), sy, Math.max(0.001, (1 + 0.35 * d) * dry));
      piece.position.y = bottom + sy * ext.y / 2;
    }) },
  { id: 'outro-wind', label: 'Viento', kind: 'outro', duration: 2, pieces: true,
    // Blown away piece by piece from the right edge, tumbling like leaves.
    apply: ({ ps, q }) => ps.forEach(piece => {
      const u = piece.userData, s = stagger(q, 1 - u.rankX, 0.55), e = easeInCubic(s);
      piece.position.x += e * 12;
      piece.position.y += Math.sin(Math.PI * s) * (u.rand - 0.3) * 1.2 + e * u.rand2 * 2;
      piece.position.z += e * (u.rand - 0.5) * 4;
      piece.rotation.set(e * (u.rand - 0.5) * 9, e * 4, e * (u.rand2 - 0.5) * 9);
      piece.scale.setScalar(Math.max(0.001, 1 - e * 0.6));
    }) },
  { id: 'outro-tv-off', label: 'Apagar TV', kind: 'outro', duration: 1,
    // An old television switching off: squashed to a line, then to a dot, then gone.
    apply: ({ m, q }) => {
      const a = easeInCubic(clamp01(q / 0.45)), b = easeInCubic(clamp01((q - 0.45) / 0.35)), c = clamp01((q - 0.8) / 0.2);
      m.scale.set(Math.max(0.001, (1 + 0.15 * a) * (1 - 0.98 * b) * (1 - c)), Math.max(0.001, 1 - 0.97 * a), Math.max(0.001, 1 - 0.9 * a));
    } },
  { id: 'outro-dive', label: 'Zambullida', kind: 'outro', duration: 2, pieces: true,
    // Piece by piece, left to right, each hops up and dives head first under its baseline.
    apply: ({ ps, q, size, clip }) => {
      clip('y', -size.y / 2 - 0.02, true);
      ps.forEach(piece => {
        const s = stagger(q, piece.userData.rankX, 0.5);
        piece.position.y += Math.sin(Math.PI * clamp01(s / 0.6)) * 0.6 - easeInCubic(clamp01((s - 0.3) / 0.7)) * (size.y + 3);
        piece.rotation.x = easeInOut(clamp01((s - 0.15) / 0.6)) * Math.PI;
      });
    } },
  { id: 'outro-bubbles', label: 'Pompas', kind: 'outro', duration: 1.8, pieces: true,
    // Each piece swells like a soap bubble, floats up a little and pops, at its own moment.
    apply: ({ ps, q }) => ps.forEach(piece => {
      const u = piece.userData, s = clamp01((q - u.rand * 0.6) / 0.4);
      const scale = s < 0.75
        ? 1 + 0.35 * easeOutCubic(s / 0.75) + Math.sin(s * TAU * 3) * 0.04 * s
        : 1.35 * (1 - easeInCubic((s - 0.75) / 0.25));
      piece.scale.setScalar(Math.max(0.001, scale));
      piece.position.y += easeInOut(s) * 0.5;
    }) },
);

export const INTRO_HOLD = 1.6;   // preview pause between intro replays

export function getAnimation(id) {
  return ANIMATIONS.find(a => a.id === id) || ANIMATIONS[0];
}

/** Puts the motion group and pieces back at rest. */
/**
 * Engine hooks available to animations. clip(axis, value, keepAbove) keeps the part of the
 * logo whose 'x' or 'y' coordinate (logo units, centred on the logo) is ≤ value, or ≥ value
 * with keepAbove; clip(null) clears it. Installed by the app; a no-op otherwise.
 */
export const fx = { clip: () => {} };

export function resetPose(motion, pieces) {
  fx.clip(null);
  motion.position.set(0, 0, 0);
  motion.rotation.set(0, 0, 0);
  motion.scale.set(1, 1, 1);
  for (const piece of pieces) {
    piece.position.copy(piece.userData.home);
    piece.rotation.set(0, 0, 0);
    piece.scale.set(1, 1, 1);
    piece.visible = true;
  }
}

/**
 * Poses the logo at animation time `t` (seconds, already scaled by speed).
 * `once` = true plays intros once and holds (export); false loops them (preview).
 */
export function poseAt(anim, t, motion, pieces, once) {
  resetPose(motion, pieces);
  const size = pieces[0]?.parent?.userData.size || { x: 4, y: 2, z: 0.4 };
  if (anim.kind === 'intro' || anim.kind === 'outro') {
    const span = anim.duration + INTRO_HOLD;
    const local = once ? t : ((t % span) + span) % span;
    anim.apply({ m: motion, ps: pieces, q: clamp01(local / anim.duration), t, size, clip: fx.clip });
  } else if (anim.period > 0) {
    const p = ((t / anim.period) % 1 + 1) % 1;
    anim.apply({ m: motion, ps: pieces, p, t, size, clip: fx.clip });
  }
}

const smoothstep01 = x => { const c = clamp01(x); return c * c * (3 - 2 * c); };

/** Pulls the current pose a fraction (1 - w) of the way back to rest (w = 1 leaves it). */
function towardRest(w, motion, pieces) {
  const blend = (o, home) => {
    o.position.lerpVectors(home, o.position.clone(), w);
    o.scale.set(1 + (o.scale.x - 1) * w, 1 + (o.scale.y - 1) * w, 1 + (o.scale.z - 1) * w);
    const q = o.quaternion.clone();
    o.quaternion.slerpQuaternions(q.clone().identity(), q, w);
  };
  blend(motion, motion.position.clone().set(0, 0, 0));
  for (const p of pieces) blend(p, p.userData.home);
}

/**
 * The full clip as a timeline: [intro] → [loop] → [outro], each optional, on a
 * `clip`-second clip (t in real seconds). Intro and outro play at the user's speed;
 * the loop fills the middle with a whole number of cycles (or the logo holds still),
 * so the outro always starts from rest and the joins never jump.
 */
export const DEFAULT_TRANSITION = 0.6;   // seconds of easing at each join between parts

/**
 * Loop time with the joins eased: after an intro the loop starts from standstill and
 * accelerates evenly over `inT` seconds, and before an outro it slows evenly to a stop over
 * `outT` — so speed, not just position, carries across each join. u is real time into the
 * loop part (0..mid); the result is the time to play the loop at.
 */
function easedLoopTime(u, mid, inT, outT) {
  let tau = u < inT ? (u * u) / (2 * inT) : u - inT / 2;
  const v = mid - u, span = mid - inT / 2 - outT / 2;
  if (outT > 0 && v < outT) tau = span - (v * v) / (2 * outT);
  // Easing in and out loses (inT + outT) / 2 of loop time; cruising that much faster keeps
  // the loop's whole number of cycles, so it ends exactly where it began — otherwise the
  // pull to rest at the end would have to unwind the missing part of a turn.
  return Math.max(0, tau) * (span > 0 ? mid / span : 1);
}

export function timelineOf({ intro = null, loop = null, outro = null, clip, speed, reps = null, hold = 0, transition = DEFAULT_TRANSITION }) {
  const introSecs = intro ? intro.duration / speed : 0;
  const outroSecs = outro ? outro.duration / speed : 0;
  // Built from parts (the "Secuencia" tab): the loop runs exactly `reps` times — or, with no
  // loop, the logo holds still for `hold` seconds — and the clip lasts as long as that adds up to.
  // Otherwise the parts are fitted into a given `clip` length.
  let mid, fit;
  if (reps != null) {
    mid = loop ? reps * loop.period / speed : Math.max(0, hold);
    fit = loop ? { speed, cycles: reps } : null;
    clip = introSecs + mid + outroSecs;
  } else {
    mid = Math.max(0, clip - introSecs - outroSecs);
    fit = loop && mid > 0 ? fitLoop(loop, mid, speed) : null;
  }
  return {
    introSecs, mid, outroSecs, fit, clip,
    fits: introSecs + outroSecs <= clip + 1e-6,
    pose(t, motion, pieces) {
      if (intro && t < introSecs) return poseAt(intro, t * speed, motion, pieces, true);
      if (t < introSecs + mid || !outro) {
        if (!loop || !fit) return resetPose(motion, pieces);
        // The transition: where the loop meets an intro or an outro it accelerates from / slows
        // to a standstill (eased time), and its pose is pulled toward rest — many loops don't
        // start at rest (a float already tilted, a wave mid-swell).
        const T = Math.max(0, Math.min(transition, mid / 2)), local = t - introSecs;
        const inT = intro ? T : 0, outT = outro ? T : 0;
        poseAt(loop, easedLoopTime(local, mid, inT, outT) * fit.speed, motion, pieces, true);
        let w = 1;
        if (inT > 0) w = Math.min(w, smoothstep01(local / inT));
        if (outT > 0) w = Math.min(w, smoothstep01((mid - local) / outT));
        if (w < 1) towardRest(w, motion, pieces);
        return;
      }
      poseAt(outro, (t - introSecs - mid) * speed, motion, pieces, true);
    },
  };
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

/**
 * Settings saved before the "Secuencia" tab chained a loop after an intro (`afterIntro`)
 * and an exit (`outro`) onto the single animation. Those become a sequence with the same
 * parts, the loop repeated as many times as fitted the old duration.
 */
export function migrateAnimationSettings(s) {
  if (!s || (!('afterIntro' in s) && !('outro' in s))) return s;
  const out = { ...s };
  delete out.afterIntro;
  delete out.outro;
  const anim = getAnimation(s.anim);
  const pick = (id, kind) => { const a = id && id !== 'none' ? getAnimation(id) : null; return a?.kind === kind ? a : null; };
  const intro = anim.kind === 'intro' ? anim : null;
  const after = intro ? pick(s.afterIntro, 'loop') : null, outro = pick(s.outro, 'outro');
  if (!after && !outro) return out;
  const loop = intro ? after : (anim.period ? anim : null);
  const speed = s.speed || 1, clip = s.seconds || 6;
  const mid = Math.max(0, clip - (intro ? intro.duration / speed : 0) - (outro ? outro.duration / speed : 0));
  return Object.assign(out, {
    mode: 'sequence',
    seqIntro: intro ? intro.id : 'none',
    seqLoop: loop ? loop.id : 'still',
    seqReps: loop ? Math.max(1, Math.round(mid * speed / loop.period)) : Math.max(1, Math.round(mid)),
    seqOutro: outro ? outro.id : 'none',
  });
}
