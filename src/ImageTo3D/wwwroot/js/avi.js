// Minimal AVI writer: one Motion-JPEG video stream (fourcc MJPG), the most widely
// compatible AVI there is (Windows players, VLC, Premiere, DaVinci, older software).
// Written strictly in order through write(position, bytes) so it can stream to disk;
// the header fields that depend on the frame count are patched at the end.
// Classic AVI 1.0 (RIFF offsets are 32-bit): kept under ~2 GB, checked as it goes.

export class AviLimitError extends Error {}

const LIMIT = 2_000_000_000;

export class AviWriter {
  /**
   * write(position, Uint8Array) must keep or copy the bytes it is given.
   * The header is written now with placeholders; finish() patches it.
   */
  constructor(write, { width, height, fps }) {
    this.write = write;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.pos = 0;
    this.index = [];       // { offset (from 'movi'), size }
    this.maxFrame = 0;

    const h = new DataView(new ArrayBuffer(224));
    let o = 0;
    const fourcc = s => { for (let i = 0; i < 4; i++) h.setUint8(o++, s.charCodeAt(i)); };
    const u32 = v => { h.setUint32(o, v, true); o += 4; };
    const u16 = v => { h.setUint16(o, v, true); o += 2; };

    fourcc('RIFF'); this.riffSizeAt = o; u32(0); fourcc('AVI ');
    fourcc('LIST'); u32(192); fourcc('hdrl');
    // Main header
    fourcc('avih'); u32(56);
    u32(Math.round(1e6 / fps));          // microseconds per frame
    this.maxBytesAt = o; u32(0);         // max bytes per second (patched)
    u32(0);                              // padding granularity
    u32(0x10);                           // AVIF_HASINDEX
    this.totalFramesAt = o; u32(0);      // total frames (patched)
    u32(0);                              // initial frames
    u32(1);                              // streams
    this.bufferAt = o; u32(0);           // suggested buffer size (patched)
    u32(width); u32(height);
    u32(0); u32(0); u32(0); u32(0);      // reserved
    // Stream list
    fourcc('LIST'); u32(116); fourcc('strl');
    fourcc('strh'); u32(56);
    fourcc('vids'); fourcc('MJPG');
    u32(0);                              // flags
    u16(0); u16(0);                      // priority, language
    u32(0);                              // initial frames
    u32(1); u32(fps);                    // scale, rate → fps
    u32(0);                              // start
    this.lengthAt = o; u32(0);           // length in frames (patched)
    this.streamBufferAt = o; u32(0);     // suggested buffer size (patched)
    u32(0xffffffff);                     // quality: default
    u32(0);                              // sample size (varies per frame)
    u16(0); u16(0); u16(width); u16(height);   // rcFrame
    fourcc('strf'); u32(40);             // BITMAPINFOHEADER
    u32(40); u32(width); u32(height);
    u16(1); u16(24);
    fourcc('MJPG');
    u32(width * height * 3);
    u32(0); u32(0); u32(0); u32(0);
    // Frame data list
    fourcc('LIST'); this.moviSizeAt = o; u32(0);
    this.moviAt = o; fourcc('movi');

    this.header = new Uint8Array(h.buffer);
    this.put(this.header);
  }

  /** Adds one JPEG frame. */
  addFrame(jpeg) {
    const padded = jpeg.length + (jpeg.length & 1);
    if (this.pos + 8 + padded + (this.index.length + 1) * 16 + 1024 > LIMIT) {
      throw new AviLimitError('El AVI superaría 2 GB, el máximo de un AVI normal. Acórtalo, reduce el tamaño o usa MP4.');
    }
    const head = new DataView(new ArrayBuffer(8));
    '00dc'.split('').forEach((c, i) => head.setUint8(i, c.charCodeAt(0)));
    head.setUint32(4, jpeg.length, true);
    this.index.push({ offset: this.pos - this.moviAt, size: jpeg.length });
    this.put(new Uint8Array(head.buffer));
    this.put(jpeg);
    if (jpeg.length & 1) this.put(new Uint8Array(1));   // chunks are word-aligned
    this.maxFrame = Math.max(this.maxFrame, jpeg.length);
  }

  /** Writes the index and patches the sizes and counts into the header. */
  finish() {
    const moviSize = this.pos - this.moviAt;
    const idx = new DataView(new ArrayBuffer(8 + this.index.length * 16));
    'idx1'.split('').forEach((c, i) => idx.setUint8(i, c.charCodeAt(0)));
    idx.setUint32(4, this.index.length * 16, true);
    this.index.forEach((e, i) => {
      const o = 8 + i * 16;
      '00dc'.split('').forEach((c, k) => idx.setUint8(o + k, c.charCodeAt(0)));
      idx.setUint32(o + 4, 0x10, true);          // AVIIF_KEYFRAME: every JPEG frame is one
      idx.setUint32(o + 8, e.offset, true);
      idx.setUint32(o + 12, e.size, true);
    });
    this.put(new Uint8Array(idx.buffer));

    const patch = (at, value) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, value, true);
      this.write(at, b);
    };
    const frames = this.index.length, buffer = this.maxFrame + 8;
    patch(this.riffSizeAt, this.pos - 8);
    patch(this.moviSizeAt, moviSize);
    patch(this.totalFramesAt, frames);
    patch(this.lengthAt, frames);
    patch(this.bufferAt, buffer);
    patch(this.streamBufferAt, buffer);
    patch(this.maxBytesAt, Math.round(buffer * this.fps));
  }

  put(bytes) {
    this.write(this.pos, bytes);
    this.pos += bytes.length;
  }
}
