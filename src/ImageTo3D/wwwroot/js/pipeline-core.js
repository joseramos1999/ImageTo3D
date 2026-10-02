// The image → outlines pipeline, shared by the Web Worker and the in-thread fallback.
// Steps are split so each control only redoes what it affects:
//   mask settings → analyze (ink field, loops, colour texture) — the expensive part
//   smoothing / denoise / holes → outlines (+ the "after" mask preview)
import { DEFAULT_MASK, inkField, marchingSquares, buildOutlines } from './trace.js';
import { buildColorImage } from './colormap.js';

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
    const color = buildColorImage(this.image, trace.key);
    return { meta: { w: trace.w, h: trace.h, W: trace.W, H: trace.H }, key: trace.key, color };
  }

  outlines(smooth, mask = DEFAULT_MASK) {
    const outlines = buildOutlines(this.rawLoops, this.trace, smooth, mask);
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
    const path = new Path2D();
    const add = loop => loop.forEach((p, i) => {
      const x = (p.x - 0.5) * sx, y = (p.y - 0.5) * sy;
      if (i) path.lineTo(x, y); else path.moveTo(x, y);
    });
    for (const o of outlines) { add(o.outer); path.closePath(); o.holes.forEach(h => { add(h); path.closePath(); }); }
    ctx.fillStyle = '#fff';
    ctx.fill(path, 'evenodd');
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(img, 0, 0, pw, ph);
    return c;
  }
}
