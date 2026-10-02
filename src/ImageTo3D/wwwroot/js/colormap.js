// The artwork as a colour texture for the "logo colours" material.
// No imports beyond trace.js and no DOM: this module also runs inside the pipeline Worker.
import { inkValue } from './trace.js';

/**
 * Transparent (non-logo) pixels are filled with the nearest logo colour so the bevel,
 * the side walls and the mip chain never pick up fringes from the background.
 * `key` is the one the tracer resolved, so texture and geometry agree on what is logo.
 * Returns an OffscreenCanvas.
 */
export function buildColorImage(img, key, maxDim = 2048) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(1, maxDim / Math.max(iw, ih));
  const w = Math.max(2, Math.round(iw * s)), h = Math.max(2, Math.round(ih * s));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // Only pixels well inside the artwork are trusted as color sources: the rim of an
  // anti-aliased or JPEG logo is blended with the background, and the side walls
  // repeat whatever color the rim has all the way through the depth.
  let solid = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    solid[p] = inkValue(key, d[i], d[i + 1], d[i + 2], d[i + 3]) > 0.9 ? 1 : 0;
  }
  const radius = Math.max(1, Math.round(Math.max(w, h) / 900));
  for (let i = 0; i < radius; i++) solid = erode(solid, w, h);
  // Near the rim, copy the nearest trusted color exactly; the pyramid fill below
  // only has to cover the far background, where nothing samples it closely.
  solid = dilateColors(d, solid, w, h, radius + 6);
  pushPull(d, solid, w, h);
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/** 3×3 binary erosion. If a pass would wipe out most of the artwork (hairline
 *  line-art), the previous mask is kept instead. */
function erode(src, w, h) {
  const out = new Uint8Array(w * h);
  let kept = 0, before = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!src[p]) continue;
    before++;
    if (x > 0 && x < w - 1 && y > 0 && y < h - 1 &&
        src[p - 1] && src[p + 1] && src[p - w] && src[p + w] &&
        src[p - w - 1] && src[p - w + 1] && src[p + w - 1] && src[p + w + 1]) { out[p] = 1; kept++; }
  }
  return kept > before * 0.2 ? out : src;
}

/** Grows the trusted region `passes` pixels outwards, each new pixel taking the
 *  average color of its trusted 8-neighbours. Returns the grown mask. */
function dilateColors(d, solid, w, h, passes) {
  let cur = solid;
  for (let pass = 0; pass < passes; pass++) {
    const next = cur.slice();
    let grew = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (cur[p]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!cur[q]) continue;
          r += d[q * 4]; g += d[q * 4 + 1]; b += d[q * 4 + 2]; n++;
        }
      }
      if (!n) continue;
      d[p * 4] = r / n; d[p * 4 + 1] = g / n; d[p * 4 + 2] = b / n;
      next[p] = 1;
      grew++;
    }
    cur = next;
    if (!grew) break;
  }
  return cur;
}

function pushPull(d, solid, w, h) {
  // Level 0: premultiplied color + weight.
  const levels = [];
  let lw = w, lh = h;
  let rgb = new Float32Array(w * h * 3), wt = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const a = solid[p];
    wt[p] = a;
    rgb[p * 3] = d[p * 4] * a; rgb[p * 3 + 1] = d[p * 4 + 1] * a; rgb[p * 3 + 2] = d[p * 4 + 2] * a;
  }
  levels.push({ rgb, wt, w: lw, h: lh });
  // Push: average down to 1x1.
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
    const nrgb = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(lw - 1, x * 2 + dx), sy = Math.min(lh - 1, y * 2 + dy);
        const q = sy * lw + sx;
        r += rgb[q * 3]; g += rgb[q * 3 + 1]; b += rgb[q * 3 + 2]; a += wt[q];
      }
      const o = y * nw + x;
      nrgb[o * 3] = r; nrgb[o * 3 + 1] = g; nrgb[o * 3 + 2] = b; nwt[o] = a;
    }
    rgb = nrgb; wt = nwt; lw = nw; lh = nh;
    levels.push({ rgb, wt, w: lw, h: lh });
  }
  // Pull: walk back up, filling empty pixels from the coarser level.
  for (let li = levels.length - 2; li >= 0; li--) {
    const L = levels[li], C = levels[li + 1];
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const p = y * L.w + x;
      if (L.wt[p] > 0) continue;
      const q = Math.min(C.h - 1, y >> 1) * C.w + Math.min(C.w - 1, x >> 1);
      const cw = C.wt[q] || 1;
      L.rgb[p * 3] = C.rgb[q * 3] / cw; L.rgb[p * 3 + 1] = C.rgb[q * 3 + 1] / cw; L.rgb[p * 3 + 2] = C.rgb[q * 3 + 2] / cw;
      L.wt[p] = 1;
    }
    if (li > 0) {
      // Coarse levels hold sums; normalise so the next level down reads averages.
      for (let p = 0; p < L.w * L.h; p++) {
        if (L.wt[p] > 1) { const a = L.wt[p]; L.rgb[p * 3] /= a; L.rgb[p * 3 + 1] /= a; L.rgb[p * 3 + 2] /= a; L.wt[p] = 1; }
      }
    }
  }
  const base = levels[0];
  for (let p = 0; p < w * h; p++) {
    if (!solid[p]) {
      d[p * 4] = base.rgb[p * 3]; d[p * 4 + 1] = base.rgb[p * 3 + 1]; d[p * 4 + 2] = base.rgb[p * 3 + 2];
    }
    d[p * 4 + 3] = 255;
  }
}
