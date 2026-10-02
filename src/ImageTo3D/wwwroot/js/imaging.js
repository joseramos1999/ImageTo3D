// Safe image decoding: dimensions are read from the file header first, so a huge
// image is rejected or decoded already downscaled instead of freezing the app or
// running out of memory on a full-size decode.

export const LIMITS = {
  maxBytes: 300 * 1024 * 1024,   // file size
  maxPixels: 100e6,              // 100 MP: ~400 MB just to decode, the most worth attempting
  maxSide: 30000,
  workSide: 4096,                // working copy: plenty for a 1000 px trace and a 2048 px texture
};

export class ImageTooLargeError extends Error {}

const mb = n => (n / 1024 / 1024).toFixed(0);

/** Width/height from the header of a PNG, JPEG, GIF, WEBP or BMP; null if unknown. */
export async function readImageSize(blob) {
  const buf = new DataView(await blob.slice(0, 1024 * 1024).arrayBuffer());
  const u8 = i => buf.getUint8(i);
  const len = buf.byteLength;
  const ascii = (i, n) => String.fromCharCode(...Array.from({ length: n }, (_, k) => u8(i + k)));
  try {
    if (len >= 24 && u8(0) === 0x89 && ascii(1, 3) === 'PNG') {
      return { w: buf.getUint32(16), h: buf.getUint32(20) };
    }
    if (len >= 10 && ascii(0, 4) === 'GIF8') {
      return { w: buf.getUint16(6, true), h: buf.getUint16(8, true) };
    }
    if (len >= 26 && ascii(0, 2) === 'BM') {
      return { w: buf.getInt32(18, true), h: Math.abs(buf.getInt32(22, true)) };
    }
    if (len >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
      const chunk = ascii(12, 4);
      if (chunk === 'VP8 ') return { w: buf.getUint16(26, true) & 0x3fff, h: buf.getUint16(28, true) & 0x3fff };
      if (chunk === 'VP8L') {
        const b0 = u8(21), b1 = u8(22), b2 = u8(23), b3 = u8(24);
        return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (chunk === 'VP8X') {
        const u24 = i => u8(i) | (u8(i + 1) << 8) | (u8(i + 2) << 16);
        return { w: 1 + u24(24), h: 1 + u24(27) };
      }
    }
    if (len >= 4 && u8(0) === 0xff && u8(1) === 0xd8) {
      // Walk the segments to the first start-of-frame (EXIF thumbnails sit inside APP1 and are skipped).
      let p = 2;
      while (p + 9 < len) {
        if (u8(p) !== 0xff) { p++; continue; }
        const m = u8(p + 1);
        if (m === 0xff) { p++; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { w: buf.getUint16(p + 7), h: buf.getUint16(p + 5) };
        }
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
        p += 2 + buf.getUint16(p + 2);
      }
    }
  } catch { /* truncated or odd header: fall through */ }
  return null;
}

/** Checks the limits; throws ImageTooLargeError with a message for the user. */
export function checkLimits(bytes, size) {
  if (bytes > LIMITS.maxBytes) {
    throw new ImageTooLargeError(`El archivo pesa ${mb(bytes)} MB y el máximo es ${mb(LIMITS.maxBytes)} MB.`);
  }
  if (size && (size.w * size.h > LIMITS.maxPixels || Math.max(size.w, size.h) > LIMITS.maxSide)) {
    throw new ImageTooLargeError(
      `La imagen mide ${size.w}×${size.h} px (${(size.w * size.h / 1e6).toFixed(0)} megapíxeles) y el máximo es ` +
      `${LIMITS.maxPixels / 1e6} MP. Redúcela con cualquier editor; para un logo bastan 2000–4000 px.`);
  }
}

const fitOpts = (w, h, max) => {
  if (Math.max(w, h) <= max) return {};
  const k = max / Math.max(w, h);
  return { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high' };
};

/**
 * Decodes an image file into a working ImageBitmap no larger than LIMITS.workSide.
 * Returns { bitmap, width, height } where width/height are the ORIGINAL dimensions.
 */
export async function decodeImage(file) {
  checkLimits(file.size, null);

  if (file.type === 'image/svg+xml') {
    // Vectors are rasterised at 2048 px so the tracer sees crisp edges whatever the SVG's own size.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(new Error('decode')); img.src = url; });
      const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024, k = 2048 / Math.max(w, h);
      const c = new OffscreenCanvas(Math.round(w * k), Math.round(h * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return { bitmap: c.transferToImageBitmap(), width: w, height: h };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const size = await readImageSize(file);
  checkLimits(file.size, size);
  let bitmap = await createImageBitmap(file, size ? fitOpts(size.w, size.h, LIMITS.workSide) : {});
  if (!size) {
    // Unknown header: decoded at full size, so at least don't keep the big one around.
    checkLimits(file.size, { w: bitmap.width, h: bitmap.height });
    const opts = fitOpts(bitmap.width, bitmap.height, LIMITS.workSide);
    if (opts.resizeWidth) { const big = bitmap; bitmap = await createImageBitmap(big, opts); big.close(); }
  }
  return { bitmap, width: size?.w ?? bitmap.width, height: size?.h ?? bitmap.height };
}

/** A small copy for previews. */
export function previewBitmap(source, max = 360) {
  return createImageBitmap(source, fitOpts(source.width, source.height, max));
}
