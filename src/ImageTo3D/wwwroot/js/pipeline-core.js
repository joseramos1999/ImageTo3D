// The image → outlines pipeline, shared by the Web Worker and the in-thread fallback.
// Steps are split so each control only redoes what it affects:
//   mask settings → analyze (ink field, loops, colour texture) — the expensive part
//   smoothing / denoise / holes → outlines (+ the "after" mask preview)
import { DEFAULT_MASK, inkField, marchingSquares, buildOutlines } from './trace.js';
import { buildColorImage } from './colormap.js';
import { findColors, layerFields } from './layers.js';

const hex = rgb => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

export const PREVIEW_MAX = 360;

export class PipelineCore {
  setImage(image) {
    this.image?.close?.();
    this.image = image;
  }

  analyze(mask = DEFAULT_MASK) {
    const trace = inkField(this.image, mask);
    this.trace = trace;
    this.rawLoops = marchingSquares(trace);
    // Colour layers: one set of loops per colour (only when there is more than one).
    this.layerLoops = null;
    let layers = null;
    if (mask.split) {
      const colors = findColors(trace.data, trace.field, trace.w, trace.W, trace.h, mask.colors);
      if (colors.length > 1) {
        this.layerLoops = layerFields(trace.data, trace, colors).map(marchingSquares);
        layers = colors.map(c => ({ color: hex(c.rgb), share: c.share }));
      }
    }
    const color = buildColorImage(this.image, trace.key);
    return { meta: { w: trace.w, h: trace.h, W: trace.W, H: trace.H, layers }, key: trace.key, color };
  }

  outlines(smooth, mask = DEFAULT_MASK) {
    const outlines = this.layerLoops
      ? this.layerLoops.flatMap((loops, layer) => buildOutlines(loops, this.trace, smooth, mask).map(o => ({ ...o, layer })))
      : buildOutlines(this.rawLoops, this.trace, smooth, mask);
    return { outlines, after: this.renderAfter(outlines) };
  }

  /** The image cut out by the final outlines: exactly what becomes geometry. */
  renderAfter(outlines) {
    const img = this.image, t = this.trace;
    const k = Math.min(1, PREVIEW_MAX / Math.max(img.width, img.height));
    const pw = Math.max(1, Math.round(img.width * k)), ph = Math.max(1, Math.round(img.height * k));
    const c = new OffscreenCanvas(pw, ph);
    const ctx = c.getContext('2d');
    // Field sample (x+1, y+1) is the centre of trace pixel (x, y).
    const sx = pw / t.w, sy = ph / t.h;
    ctx.fillStyle = '#fff';
    // One fill per outline: colour layers overlap, and a single even-odd path would punch them out.
    for (const o of outlines) {
      const path = new Path2D();
      for (const loop of [o.outer, ...o.holes]) {
        loop.forEach((p, i) => {
          const x = (p.x - 0.5) * sx, y = (p.y - 0.5) * sy;
          if (i) path.lineTo(x, y); else path.moveTo(x, y);
        });
        path.closePath();
      }
      ctx.fill(path, 'evenodd');
    }
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(img, 0, 0, pw, ph);
    return c;
  }
}
