// AVI writer with one video stream, in two flavours:
//  - 'mjpg': Motion JPEG (fourcc MJPG), the most widely compatible AVI there is.
//  - 'rgba': uncompressed 32-bit DIB (BI_RGB, BGRA, bottom-up rows) with an alpha channel:
//    what After Effects writes with codec «None» and Channels «RGB + Alpha», and imports
//    back with its transparency (as do Premiere, DaVinci Resolve, VirtualDub, ffmpeg).
// Written strictly in order through write(position, bytes) so it can stream to disk; the
// fields that depend on what comes later are patched at the end.
// OpenDML (AVI 2.0): the file is split into RIFF segments of up to 1 GB (the first 'AVI ',
// the rest 'AVIX'), each indexed by an 'ix00' chunk listed in the stream's 'indx' super
// index, so it can grow past the 2 GB of classic AVI (uncompressed 1080p is ~8 MB a frame).
// The first segment also carries a classic 'idx1' for readers that only know AVI 1.0.

export class AviLimitError extends Error {}

const SEGMENT = 1 << 30;     // bytes per RIFF segment
const MAX_SEGMENTS = 256;    // super index slots reserved in the header (256 GB)

const CODECS = {
  mjpg: { handler: 'MJPG', compression: 'MJPG', bits: 24, chunk: '00dc' },
  rgba: { handler: 'DIB ', compression: 0, bits: 32, chunk: '00db' },
};

/** Little-endian header builder over a fixed-size buffer. */
class Bytes {
  constructor(size) { this.view = new DataView(new ArrayBuffer(size)); this.o = 0; }
  fourcc(s) { for (let i = 0; i < 4; i++) this.view.setUint8(this.o++, s.charCodeAt(i)); }
  u8(v) { this.view.setUint8(this.o++, v); }
  u16(v) { this.view.setUint16(this.o, v, true); this.o += 2; }
  u32(v) { this.view.setUint32(this.o, v, true); this.o += 4; }
  u64(v) { this.u32(v % 2 ** 32); this.u32(Math.floor(v / 2 ** 32)); }
  skip(n) { this.o += n; }
  get bytes() { return new Uint8Array(this.view.buffer); }
}

export class AviWriter {
  /**
   * write(position, Uint8Array) must keep or copy the bytes it is given.
   * The header is written now with placeholders; finish() patches it.
   */
  constructor(write, { width, height, fps, codec = 'mjpg', segmentBytes = SEGMENT }) {
    this.write = write;
    this.segmentBytes = segmentBytes;
    this.fps = fps;
    this.codec = CODECS[codec];
    this.pos = 0;
    this.segments = [];     // closed segments: { ixAt, ixSize, frames }
    this.frames = 0;
    this.firstFrames = 0;   // frames in the first RIFF (classic readers stop there)
    this.maxFrame = 0;

    const strlSize = 4 + (8 + 56) + (8 + 40) + (8 + 24 + 16 * MAX_SEGMENTS);
    const odmlSize = 4 + (8 + 248);
    const hdrlSize = 4 + (8 + 56) + (8 + strlSize) + (8 + odmlSize);
    const h = new Bytes(12 + 8 + hdrlSize + 12);

    h.fourcc('RIFF'); this.riffSizeAt = h.o; h.u32(0); h.fourcc('AVI ');
    h.fourcc('LIST'); h.u32(hdrlSize); h.fourcc('hdrl');
    // Main header
    h.fourcc('avih'); h.u32(56);
    h.u32(Math.round(1e6 / fps));          // microseconds per frame
    this.maxBytesAt = h.o; h.u32(0);       // max bytes per second (patched)
    h.u32(0);                              // padding granularity
    h.u32(0x10);                           // AVIF_HASINDEX
    this.totalFramesAt = h.o; h.u32(0);    // frames in the first RIFF (patched)
    h.u32(0);                              // initial frames
    h.u32(1);                              // streams
    this.bufferAt = h.o; h.u32(0);         // suggested buffer size (patched)
    h.u32(width); h.u32(height);
    h.skip(16);                            // reserved
    // Stream list
    h.fourcc('LIST'); h.u32(strlSize); h.fourcc('strl');
    h.fourcc('strh'); h.u32(56);
    h.fourcc('vids'); h.fourcc(this.codec.handler);
    h.u32(0);                              // flags
    h.u16(0); h.u16(0);                    // priority, language
    h.u32(0);                              // initial frames
    h.u32(1); h.u32(fps);                  // scale, rate → fps
    h.u32(0);                              // start
    this.lengthAt = h.o; h.u32(0);         // length in frames, all segments (patched)
    this.streamBufferAt = h.o; h.u32(0);   // suggested buffer size (patched)
    h.u32(0xffffffff);                     // quality: default
    h.u32(0);                              // sample size (varies per frame)
    h.u16(0); h.u16(0); h.u16(width); h.u16(height);   // rcFrame
    h.fourcc('strf'); h.u32(40);           // BITMAPINFOHEADER
    h.u32(40); h.u32(width); h.u32(height);            // positive height: rows bottom-up
    h.u16(1); h.u16(this.codec.bits);
    if (typeof this.codec.compression === 'string') h.fourcc(this.codec.compression); else h.u32(this.codec.compression);
    h.u32(width * height * this.codec.bits / 8);
    h.skip(16);
    // OpenDML super index: one entry per RIFF segment (patched)
    h.fourcc('indx'); h.u32(24 + 16 * MAX_SEGMENTS);
    h.u16(4); h.u8(0); h.u8(0);            // longs per entry, sub type, AVI_INDEX_OF_INDEXES
    this.indxCountAt = h.o; h.u32(0);      // entries in use
    h.fourcc(this.codec.chunk);
    h.skip(12);                            // reserved
    this.indxEntriesAt = h.o; h.skip(16 * MAX_SEGMENTS);
    // OpenDML extended header
    h.fourcc('LIST'); h.u32(odmlSize); h.fourcc('odml');
    h.fourcc('dmlh'); h.u32(248);
    this.dmlhFramesAt = h.o; h.u32(0);     // total frames (patched)
    h.skip(244);
    // First segment's frame data
    h.fourcc('LIST'); this.moviSizeAt = h.o; h.u32(0);
    this.moviAt = h.o; h.fourcc('movi');

    this.segStart = 0;
    this.segIndex = [];     // frames of the open segment: { at (chunk position), size }
    this.put(h.bytes);
  }

  /** Adds one frame: a JPEG ('mjpg') or width·height·4 bytes of BGRA, bottom-up ('rgba'). */
  addFrame(data) {
    const padded = data.length + (data.length & 1);
    const n = this.segIndex.length + 1;
    const indexes = 32 + n * 8 + (this.segments.length === 0 ? 8 + n * 16 : 0);
    if (this.segIndex.length && this.pos + 8 + padded + indexes - this.segStart > this.segmentBytes) {
      this.closeSegment();
      this.openSegment();
    }
    const head = new Bytes(8);
    head.fourcc(this.codec.chunk); head.u32(data.length);
    this.segIndex.push({ at: this.pos, size: data.length });
    this.put(head.bytes);
    this.put(data);
    if (data.length & 1) this.put(new Uint8Array(1));   // chunks are word-aligned
    this.frames++;
    this.maxFrame = Math.max(this.maxFrame, data.length);
  }

  /** Ends the open segment: its 'ix00' at the end of the movi list, plus 'idx1' in the first. */
  closeSegment() {
    const entries = this.segIndex, first = this.segments.length === 0;
    const ix = new Bytes(32 + entries.length * 8);
    ix.fourcc('ix00'); ix.u32(24 + entries.length * 8);
    ix.u16(2); ix.u8(0); ix.u8(1);         // longs per entry, sub type, AVI_INDEX_OF_CHUNKS
    ix.u32(entries.length);
    ix.fourcc(this.codec.chunk);
    ix.u64(this.segStart);                 // base offset
    ix.u32(0);
    // Offsets point at each chunk's data; every frame is a key frame (bit 31 clear).
    for (const e of entries) { ix.u32(e.at + 8 - this.segStart); ix.u32(e.size); }
    this.segments.push({ ixAt: this.pos, ixSize: ix.bytes.length, frames: entries.length });
    this.put(ix.bytes);
    this.patch(this.moviSizeAt, this.pos - this.moviAt);

    if (first) {
      this.firstFrames = entries.length;
      const idx = new Bytes(8 + entries.length * 16);
      idx.fourcc('idx1'); idx.u32(entries.length * 16);
      for (const e of entries) {
        idx.fourcc(this.codec.chunk);
        idx.u32(0x10);                     // AVIIF_KEYFRAME
        idx.u32(e.at - this.moviAt);       // relative to the 'movi' fourcc
        idx.u32(e.size);
      }
      this.put(idx.bytes);
    }
    this.patch(this.riffSizeAt, this.pos - this.segStart - 8);
    this.segIndex = [];
  }

  /** Starts an 'AVIX' segment. */
  openSegment() {
    if (this.segments.length >= MAX_SEGMENTS) {
      throw new AviLimitError(`El AVI superaría ${MAX_SEGMENTS} GB. Acórtalo o reduce el tamaño.`);
    }
    this.segStart = this.pos;
    const h = new Bytes(24);
    h.fourcc('RIFF'); this.riffSizeAt = this.pos + h.o; h.u32(0); h.fourcc('AVIX');
    h.fourcc('LIST'); this.moviSizeAt = this.pos + h.o; h.u32(0);
    this.moviAt = this.pos + h.o; h.fourcc('movi');
    this.put(h.bytes);
  }

  /** Closes the last segment and patches the counts, sizes and super index into the header. */
  finish() {
    this.closeSegment();
    const sup = new Bytes(16 * this.segments.length);
    for (const s of this.segments) { sup.u64(s.ixAt); sup.u32(s.ixSize); sup.u32(s.frames); }
    this.write(this.indxEntriesAt, sup.bytes);
    this.patch(this.indxCountAt, this.segments.length);

    const buffer = this.maxFrame + 8;
    this.patch(this.totalFramesAt, this.firstFrames);
    this.patch(this.lengthAt, this.frames);
    this.patch(this.dmlhFramesAt, this.frames);
    this.patch(this.bufferAt, buffer);
    this.patch(this.streamBufferAt, buffer);
    this.patch(this.maxBytesAt, Math.min(2 ** 32 - 1, Math.round(buffer * this.fps)));
  }

  patch(at, value) {
    const b = new Bytes(4);
    b.u32(value);
    this.write(at, b.bytes);
  }

  put(bytes) {
    this.write(this.pos, bytes);
    this.pos += bytes.length;
  }
}
