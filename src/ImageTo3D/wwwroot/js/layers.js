// Colour layers for traced images: the logo's area is split by colour, and each colour gets
// its own ink field, traced like the whole logo. An icon, its text and its border become
// separate layers that can take their own depth and material (an SVG's come from its paths).
//
// No imports and no DOM: this module runs inside the pipeline Web Worker.

const SOLID = 0.9;          // ink above this is trusted for colour (rims blend with the background)
const MERGE_DE = 14;        // colours closer than this (ΔE in Lab) are one layer
const MIN_SHARE = 0.012;    // smaller colour groups are folded into the nearest layer
const SOFT_DE = 12;         // softness of the boundary between two colours
const OVERLAP = 0.2;        // neighbouring layers overlap a little, so no gap shows between them

// sRGB 0..255 → CIE Lab (D65)
function lab(r, g, b) {
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const de2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** k-means++ with a fixed seed, so the same image always gives the same layers. */
function kmeans(points, k, iterations = 14) {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const centers = [points[Math.floor(rand() * points.length)].slice()];
  const d = new Float64Array(points.length).fill(Infinity);
  while (centers.length < k) {
    let sum = 0;
    points.forEach((p, i) => { d[i] = Math.min(d[i], de2(p, centers[centers.length - 1])); sum += d[i]; });
    if (sum === 0) break;
    let t = rand() * sum, i = 0;
    while (i < points.length - 1 && (t -= d[i]) > 0) i++;
    centers.push(points[i].slice());
  }
  const assign = new Int32Array(points.length);
  for (let it = 0; it < iterations; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    points.forEach((p, i) => {
      let best = 0, bd = Infinity;
      centers.forEach((c, j) => { const v = de2(p, c); if (v < bd) { bd = v; best = j; } });
      assign[i] = best;
      const a = acc[best]; a[0] += p[0]; a[1] += p[1]; a[2] += p[2]; a[3]++;
    });
    centers.forEach((c, j) => { const a = acc[j]; if (a[3]) { c[0] = a[0] / a[3]; c[1] = a[1] / a[3]; c[2] = a[2] / a[3]; } });
  }
  const count = new Array(centers.length).fill(0);
  assign.forEach(j => count[j]++);
  return { centers, count };
}

/**
 * Finds the logo's colours. count: 'auto' (merge similar ones) or a fixed number (2..8).
 * Returns [{ lab, rgb: [r,g,b], share }] sorted by area, largest first.
 */
export function findColors(data, field, w, W, h, count = 'auto') {
  const pts = [], rgbs = [];
  const total = w * h, stride = Math.max(1, Math.floor(total / 40000));
  for (let p = 0; p < total; p += stride) {
    const x = p % w, y = (p - x) / w;
    if (field[(y + 1) * W + x + 1] < SOLID) continue;
    const i = p * 4;
    pts.push(lab(data[i], data[i + 1], data[i + 2]));
    rgbs.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (pts.length < 20) return [];
  const fixed = count !== 'auto' && Number(count) >= 1;
  const k = Math.min(fixed ? Number(count) : 8, pts.length);
  let { centers, count: n } = kmeans(pts, k);
  let groups = centers.map((c, j) => ({ lab: c, n: n[j] })).filter(g => g.n > 0);

  if (!fixed) {
    // Merge colours that read as the same, then fold away crumbs (anti-aliasing between two
    // colours, JPEG noise), always into the nearest remaining colour.
    const merge = (a, b) => {
      const t = a.n + b.n;
      a.lab = a.lab.map((v, i) => (v * a.n + b.lab[i] * b.n) / t);
      a.n = t;
    };
    for (let again = true; again;) {
      again = false;
      outer: for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
        if (de2(groups[i].lab, groups[j].lab) < MERGE_DE * MERGE_DE) { merge(groups[i], groups[j]); groups.splice(j, 1); again = true; break outer; }
      }
    }
    const all = groups.reduce((s, g) => s + g.n, 0);
    groups.sort((a, b) => a.n - b.n);
    while (groups.length > 1 && groups[0].n / all < MIN_SHARE) {
      const small = groups.shift();
      let best = groups[0];
      for (const g of groups) if (de2(g.lab, small.lab) < de2(best.lab, small.lab)) best = g;
      merge(best, small);
    }
  }
  const all = groups.reduce((s, g) => s + g.n, 0);
  groups.sort((a, b) => b.n - a.n);
  // A representative sRGB colour for each layer: the average of its samples.
  return groups.map(g => {
    const acc = [0, 0, 0, 0];
    pts.forEach((p, i) => {
      let best = groups[0];
      for (const o of groups) if (de2(o.lab, p) < de2(best.lab, p)) best = o;
      if (best !== g) return;
      acc[0] += rgbs[i][0]; acc[1] += rgbs[i][1]; acc[2] += rgbs[i][2]; acc[3]++;
    });
    const rgb = acc[3] ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]].map(Math.round) : [128, 128, 128];
    return { lab: g.lab, rgb, share: g.n / all };
  });
}

/**
 * One ink field per colour, the same size as the logo's field. Inside the logo each pixel
 * belongs softly to the colours it is close to; the rim (blended with the background) takes
 * the weights of the nearest solid pixel. Fields are shifted so the usual 0.5 cut sits a
 * little past the 50 % boundary between two colours: neighbours overlap instead of gapping.
 */
export function layerFields(data, trace, colors) {
  const { field, W, H, w, h } = trace;
  const K = colors.length;
  const weights = new Float32Array(w * h * K);
  const known = new Uint8Array(w * h);
  const front = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (field[(y + 1) * W + x + 1] < SOLID) continue;
    const i = p * 4, c = lab(data[i], data[i + 1], data[i + 2]);
    const d = colors.map(col => Math.sqrt(de2(c, col.lab)));
    const m = Math.min(...d);
    let sum = 0;
    for (let k = 0; k < K; k++) { const v = Math.exp(-((d[k] - m) ** 2) / (2 * SOFT_DE * SOFT_DE)); weights[p * K + k] = v; sum += v; }
    for (let k = 0; k < K; k++) weights[p * K + k] /= sum;
    known[p] = 1;
  }
  // Rim and anti-aliased edge: copy the nearest known pixel's weights, ring by ring.
  for (let p = 0; p < w * h; p++) {
    if (known[p]) continue;
    const x = p % w, y = (p - x) / w;
    if ((x > 0 && known[p - 1]) || (x < w - 1 && known[p + 1]) || (y > 0 && known[p - w]) || (y < h - 1 && known[p + w])) front.push(p);
  }
  let ring = front;
  for (let pass = 0; pass < 64 && ring.length; pass++) {
    const filled = [];
    for (const p of ring) {
      if (known[p]) continue;
      const x = p % w, y = (p - x) / w;
      const q = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1].find(n => n >= 0 && known[n] === 1);
      if (q === undefined) continue;
      for (let k = 0; k < K; k++) weights[p * K + k] = weights[q * K + k];
      filled.push(p);
    }
    for (const p of filled) known[p] = 2;
    const next = [];
    for (const p of filled) {
      known[p] = 1;
      const x = p % w, y = (p - x) / w;
      for (const n of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (n >= 0 && !known[n]) { known[n] = 3; next.push(n); }
      }
    }
    for (const n of next) known[n] = 0;
    ring = next;
  }

  return colors.map((_, k) => {
    const f = new Float32Array(W * H);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, ink = field[(y + 1) * W + x + 1];
      f[(y + 1) * W + x + 1] = known[p] ? Math.min(1, ink * weights[p * K + k] + OVERLAP) : 0;
    }
    return { field: f, W, H, w, h };
  });
}

