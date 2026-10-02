// Raster logo → closed outlines.
//
// Pipeline: image → soft "ink" field (0..1 per pixel) → marching squares with
// linear interpolation on the cell edges → oriented loops → corner-preserving
// smoothing → Douglas-Peucker simplification → outlines with their holes.
//
// The field is soft rather than thresholded, so an anti-aliased PNG gives
// sub-pixel accurate outlines instead of 1px stair steps.

const ISO = 0.5;

/** Reads the image into an ink field. Transparent PNGs use alpha; opaque images
 *  (JPG, screenshots) key out the background color sampled from the border. */
export function inkField(img, maxDim = 1000) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  // Small logos are upscaled (smoothly) so the tracer has enough resolution.
  const scale = Math.min(4, maxDim / Math.max(iw, ih));
  const w = Math.max(2, Math.round(iw * scale)), h = Math.max(2, Math.round(ih * scale));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const key = detectKey(data, w, h);
  // 1px of empty padding all round guarantees every contour closes.
  const W = w + 2, H = h + 2;
  const field = new Float32Array(W * H);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      field[(y + 1) * W + x + 1] = inkValue(key, data[i], data[i + 1], data[i + 2], data[i + 3]);
    }
  }
  return { field, W, H, w, h, key };
}

/** Decides how "ink" is told apart from background. */
export function detectKey(data, w, h) {
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparent++;
  if (transparent / (w * h) > 0.01) return { mode: 'alpha' };

  // Opaque image: the background is the dominant border color.
  const buckets = new Map();
  const sample = (x, y) => {
    const i = (y * w + x) * 4;
    const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const b = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
    buckets.set(k, b);
  };
  for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y++) { sample(0, y); sample(w - 1, y); }
  let best = null;
  buckets.forEach(b => { if (!best || b.n > best.n) best = b; });
  return { mode: 'key', r: best.r / best.n, g: best.g / best.n, b: best.b / best.n, lo: 28, hi: 90 };
}

export function inkValue(key, r, g, b, a) {
  if (key.mode === 'alpha') return a / 255;
  const d = Math.hypot(r - key.r, g - key.g, b - key.b);
  return Math.max(0, Math.min(1, (d - key.lo) / (key.hi - key.lo)));
}

/** Marching squares over the field. Returns closed loops of {x,y} points in
 *  field coordinates, all oriented with the ink on the same side, so outlines
 *  and holes come out with opposite signed areas. */
export function marchingSquares({ field, W, H }) {
  const f = (x, y) => field[y * W + x];
  // Edge ids: horizontal edge (x,y)-(x+1,y) = 2*(y*W+x); vertical (x,y)-(x,y+1) = +1.
  const hEdge = (x, y) => 2 * (y * W + x);
  const vEdge = (x, y) => 2 * (y * W + x) + 1;
  const next = new Map();
  const point = new Map();

  const lerpPoint = (id) => {
    if (point.has(id)) return;
    const cell = id >> 1, x = cell % W, y = (cell - x) / W;
    if (id & 1) {
      const a = f(x, y), b = f(x, y + 1);
      point.set(id, { x, y: y + (ISO - a) / (b - a) });
    } else {
      const a = f(x, y), b = f(x + 1, y);
      point.set(id, { x: x + (ISO - a) / (b - a), y });
    }
  };
  const seg = (from, to) => { next.set(from, to); lerpPoint(from); lerpPoint(to); };

  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = f(x, y), b = f(x + 1, y), c = f(x + 1, y + 1), d = f(x, y + 1);
      const idx = (a >= ISO ? 8 : 0) | (b >= ISO ? 4 : 0) | (c >= ISO ? 2 : 0) | (d >= ISO ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const T = hEdge(x, y), B = hEdge(x, y + 1), L = vEdge(x, y), R = vEdge(x + 1, y);
      switch (idx) {
        case 1: seg(L, B); break;
        case 2: seg(B, R); break;
        case 3: seg(L, R); break;
        case 4: seg(R, T); break;
        case 6: seg(B, T); break;
        case 7: seg(L, T); break;
        case 8: seg(T, L); break;
        case 9: seg(T, B); break;
        case 11: seg(T, R); break;
        case 12: seg(R, L); break;
        case 13: seg(R, B); break;
        case 14: seg(B, L); break;
        case 5: // saddle: b & d inked; the cell centre decides whether they join
          if ((a + b + c + d) / 4 >= ISO) { seg(L, T); seg(R, B); } else { seg(R, T); seg(L, B); }
          break;
        case 10: // saddle: a & c inked
          if ((a + b + c + d) / 4 >= ISO) { seg(T, R); seg(B, L); } else { seg(T, L); seg(B, R); }
          break;
      }
    }
  }

  const loops = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const loop = [];
    let e = start;
    while (next.has(e)) {
      loop.push(point.get(e));
      const n = next.get(e);
      next.delete(e);
      e = n;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

export function signedArea(loop) {
  let s = 0;
  for (let i = 0, n = loop.length; i < n; i++) {
    const p = loop[i], q = loop[(i + 1) % n];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

export function pointInLoop(p, loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Laplacian smoothing that leaves sharp corners alone, so curves lose their
 *  pixel stair-steps while the corners of a logo stay crisp. */
export function smoothLoop(loop, iterations, cornerDeg = 55) {
  const n = loop.length;
  if (iterations <= 0 || n < 8) return loop;
  const K = Math.max(2, Math.min(5, Math.floor(n / 10)));
  const cosLimit = Math.cos(cornerDeg * Math.PI / 180);
  const fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = loop[(i - K + n) % n], b = loop[i], c = loop[(i + K) % n];
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu && lv && (ux * vx + uy * vy) / (lu * lv) < cosLimit) fixed[i] = 1;
  }
  let pts = loop.map(p => ({ x: p.x, y: p.y }));
  for (let it = 0; it < iterations; it++) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      if (fixed[i]) { out[i] = pts[i]; continue; }
      const p = pts[(i - 1 + n) % n], q = pts[i], r = pts[(i + 1) % n];
      out[i] = { x: (p.x + 2 * q.x + r.x) / 4, y: (p.y + 2 * q.y + r.y) / 4 };
    }
    pts = out;
  }
  return pts;
}

/** Douglas-Peucker on a closed loop (split at the two farthest-apart points). */
export function simplifyLoop(loop, eps) {
  const n = loop.length;
  if (n < 8) return loop;
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (loop[i].x - loop[0].x) ** 2 + (loop[i].y - loop[0].y) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const eps2 = eps * eps;
  const dp = (pts) => {
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      const a = pts[s], b = pts[e];
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      let maxD = -1, idx = -1;
      for (let i = s + 1; i < e; i++) {
        const p = pts[i];
        let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps2) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  const first = dp(loop.slice(0, far + 1));
  const second = dp(loop.slice(far).concat([loop[0]]));
  return first.slice(0, -1).concat(second.slice(0, -1));
}

/**
 * Raw loops → [{ outer, holes[] }] in field coordinates.
 * smoothness: 0..6 (how much stair-step smoothing to apply).
 */
export function buildOutlines(rawLoops, { W, H }, smoothness = 2) {
  const px = Math.max(W, H) / 1000;           // tolerances scale with trace resolution
  const minArea = Math.max(6, 40 * px * px);  // speck filter
  const iterations = [0, 1, 3, 5, 8, 12, 16][Math.max(0, Math.min(6, smoothness))];

  const loops = rawLoops
    .map(l => simplifyLoop(smoothLoop(l, iterations), 0.35 * Math.max(1, px)))
    .map(l => ({ pts: l, area: signedArea(l) }))
    .filter(l => l.pts.length >= 3 && Math.abs(l.area) > minArea);
  if (!loops.length) return [];

  // All loops share one orientation convention; the largest one is always an outline.
  const outerSign = Math.sign(loops.reduce((m, l) => Math.abs(l.area) > Math.abs(m.area) ? l : m).area);
  const outers = loops.filter(l => Math.sign(l.area) === outerSign).map(l => ({ outer: l.pts, area: Math.abs(l.area), holes: [] }));
  const holes = loops.filter(l => Math.sign(l.area) !== outerSign);
  outers.sort((a, b) => a.area - b.area);   // smallest first → innermost container wins
  for (const h of holes) {
    const owner = outers.find(o => o.area > Math.abs(h.area) && pointInLoop(h.pts[0], o.outer));
    if (owner) owner.holes.push(h.pts);
  }
  return outers;
}
