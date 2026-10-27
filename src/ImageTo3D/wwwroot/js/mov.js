// QuickTime (.mov) writer with one video track whose frames are PNG images (codec 'png ',
// depth 32): lossless, with an alpha channel, and read with their transparency by Final Cut
// Pro, Premiere, After Effects, DaVinci Resolve and Motion — on a Mac as on Windows, which the
// WebM with alpha and the RGBA AVI are not.
// Written strictly in order through write(position, bytes) so it can stream to disk:
//   ftyp · wide · mdat (the frames) · moov (the index, built once every frame size is known)
// The 8-byte 'wide' atom reserves room for a 64-bit mdat header, used if the frames pass 4 GB;
// the chunk offsets switch to 'co64' then too.

const U32 = 2 ** 32;

/** Big-endian atom builder: atom(type, ...parts) with parts Uint8Arrays or nested atoms. */
class Writer {
  constructor() { this.parts = []; this.size = 0; }
  bytes(b) { this.parts.push(b); this.size += b.length; return this; }
  u8(v) { return this.bytes(Uint8Array.of(v)); }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return this.bytes(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return this.bytes(b); }
  u64(v) { return this.u32(Math.floor(v / U32)).u32(v % U32); }
  i16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v); return this.bytes(b); }
  fourcc(s) { return this.bytes(Uint8Array.from(s, c => c.charCodeAt(0))); }
  zeros(n) { return this.bytes(new Uint8Array(n)); }
  /** A Pascal string padded to `size` bytes (QuickTime names). */
  pascal(s, size) { const b = new Uint8Array(size); b[0] = s.length; b.set(Uint8Array.from(s, c => c.charCodeAt(0)), 1); return this.bytes(b); }
  /** The 3×3 display matrix of tkhd / mvhd: identity in 16.16 / 2.30 fixed point. */
  matrix() { return this.u32(0x10000).u32(0).u32(0).u32(0).u32(0x10000).u32(0).u32(0).u32(0).u32(0x40000000); }
  out() { const o = new Uint8Array(this.size); let p = 0; for (const b of this.parts) { o.set(b, p); p += b.length; } return o; }
}

function atom(type, build) {
  const body = new Writer();
  build(body);
  return new Writer().u32(8 + body.size).fourcc(type).bytes(body.out()).out();
}

export class MovWriter {
  /** write(position, Uint8Array) must keep or copy the bytes it is given. */
  constructor(write, { width, height, fps }) {
    this.write = write;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.sizes = [];
    this.offsets = [];
    this.pos = 0;
    this.put(atom('ftyp', w => w.fourcc('qt  ').u32(0x20050300).fourcc('qt  ')));
    this.wideAt = this.pos;
    this.put(atom('wide', () => {}));
    this.mdatAt = this.pos;
    this.put(new Writer().u32(0).fourcc('mdat').out());   // size patched in finish()
  }

  /** Adds one frame: the bytes of a PNG (straight alpha). */
  addFrame(png) {
    this.offsets.push(this.pos);
    this.sizes.push(png.length);
    this.put(png);
  }

  finish() {
    // mdat: 32-bit size, or (past 4 GB) a 64-bit one over the 'wide' placeholder.
    const mdatSize = this.pos - this.mdatAt;
    if (mdatSize < U32) this.write(this.mdatAt, new Writer().u32(mdatSize).out());
    else this.write(this.wideAt, new Writer().u32(1).fourcc('mdat').u64(this.pos - this.wideAt).out());
    this.put(this.moov());
  }

  moov() {
    const { width, height, fps } = this, n = this.sizes.length;
    const movieScale = 1000, mediaScale = fps * 100, delta = 100;   // 30 fps → 3000 units, 100 a frame
    const movieDuration = Math.round(n / fps * movieScale), mediaDuration = n * delta;
    const wide64 = this.offsets.length && this.offsets[this.offsets.length - 1] >= U32;
    return atom('moov', moov => {
      moov.bytes(atom('mvhd', w => w
        .u32(0).u32(0).u32(0)                          // version/flags, creation, modification
        .u32(movieScale).u32(movieDuration)
        .u32(0x10000).u16(0x100).zeros(10)             // rate 1.0, volume 1.0, reserved
        .matrix()
        .zeros(24)                                     // preview, poster, selection, current time
        .u32(2)));                                     // next track id
      moov.bytes(atom('trak', trak => {
        trak.bytes(atom('tkhd', w => w
          .u32(0x0000000f)                             // version 0; enabled, in movie, preview, poster
          .u32(0).u32(0).u32(1).u32(0)                 // creation, modification, track id, reserved
          .u32(movieDuration).zeros(8)
          .u16(0).u16(0).u16(0).u16(0)                 // layer, alternate group, volume, reserved
          .matrix()
          .u32(width * 0x10000).u32(height * 0x10000)));
        trak.bytes(atom('mdia', mdia => {
          mdia.bytes(atom('mdhd', w => w.u32(0).u32(0).u32(0).u32(mediaScale).u32(mediaDuration).u16(0x7fff).u16(0)));
          mdia.bytes(atom('hdlr', w => w.u32(0).fourcc('mhlr').fourcc('vide').u32(0).u32(0).u32(0).pascal('VideoHandler', 13)));
          mdia.bytes(atom('minf', minf => {
            minf.bytes(atom('vmhd', w => w.u32(1).u16(0x40).u16(0x8000).u16(0x8000).u16(0x8000)));   // dither copy
            minf.bytes(atom('hdlr', w => w.u32(0).fourcc('dhlr').fourcc('alis').u32(0).u32(0).u32(0).pascal('DataHandler', 12)));
            minf.bytes(atom('dinf', dinf => dinf.bytes(atom('dref', w => w.u32(0).u32(1).bytes(atom('alis', a => a.u32(1)))))));   // the data is in this file
            minf.bytes(atom('stbl', stbl => {
              stbl.bytes(atom('stsd', w => w.u32(0).u32(1).bytes(atom('png ', d => d
                .zeros(6).u16(1)                       // reserved, data reference index
                .u16(0).u16(0).fourcc('appl')          // version, revision, vendor
                .u32(0).u32(1024)                      // temporal quality, spatial quality (lossless)
                .u16(width).u16(height)
                .u32(72 * 0x10000).u32(72 * 0x10000)   // 72 dpi
                .u32(0).u16(1)                         // data size, frames per sample
                .pascal('PNG', 32)
                .u16(32).i16(-1)))));                  // depth 32: colour + alpha; no colour table
              stbl.bytes(atom('stts', w => w.u32(0).u32(1).u32(n).u32(delta)));
              stbl.bytes(atom('stsc', w => w.u32(0).u32(1).u32(1).u32(1).u32(1)));   // one frame per chunk
              stbl.bytes(atom('stsz', w => { w.u32(0).u32(0).u32(n); for (const s of this.sizes) w.u32(s); }));
              stbl.bytes(wide64
                ? atom('co64', w => { w.u32(0).u32(n); for (const o of this.offsets) w.u64(o); })
                : atom('stco', w => { w.u32(0).u32(n); for (const o of this.offsets) w.u32(o); }));
            }));
          }));
        }));
      }));
    });
  }

  put(bytes) {
    this.write(this.pos, bytes);
    this.pos += bytes.length;
  }
}
