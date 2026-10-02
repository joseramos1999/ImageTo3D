// Minimal streaming ZIP writer for PNG sequences. Entries are STORED (PNG is already
// compressed), names are UTF-8, and everything is written strictly in order through
// write(position, bytes), so it can stream straight into a file. Limited to 4 GB
// (no ZIP64): addFile() throws before crossing it.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = s => new TextEncoder().encode(s);

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipLimitError extends Error {}

export class ZipWriter {
  /** write(position, Uint8Array) must keep the bytes it is given (or copy them). */
  constructor(write) {
    this.write = write;
    this.pos = 0;
    this.entries = [];
    this.stamp = dosDateTime();
  }

  addFile(name, data) {
    const nameBytes = utf8(name);
    if (this.pos + 30 + nameBytes.length + data.length + 1024 * 1024 > 0xffffffff) {
      throw new ZipLimitError('La secuencia superaría 4 GB, el máximo de un ZIP normal. Acorta el vídeo o reduce el tamaño.');
    }
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);       // local file header
    h.setUint16(4, 20, true);               // version needed
    h.setUint16(6, 0x0800, true);           // UTF-8 names
    h.setUint16(8, 0, true);                // stored
    h.setUint16(10, this.stamp.time, true);
    h.setUint16(12, this.stamp.date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true);
    const offset = this.pos;
    this.put(new Uint8Array(h.buffer));
    this.put(nameBytes);
    this.put(data);
    this.entries.push({ nameBytes, crc, size: data.length, offset });
  }

  finish() {
    const start = this.pos;
    for (const e of this.entries) {
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);     // central directory header
      c.setUint16(4, 20, true);             // made by
      c.setUint16(6, 20, true);             // version needed
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, this.stamp.time, true);
      c.setUint16(14, this.stamp.date, true);
      c.setUint32(16, e.crc, true);
      c.setUint32(20, e.size, true);
      c.setUint32(24, e.size, true);
      c.setUint16(28, e.nameBytes.length, true);
      c.setUint32(42, e.offset, true);      // (extra, comment, disk, attributes stay 0)
      this.put(new Uint8Array(c.buffer));
      this.put(e.nameBytes);
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);     // end of central directory
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, this.pos - start, true);
    end.setUint32(16, start, true);
    this.put(new Uint8Array(end.buffer));
  }

  put(bytes) {
    this.write(this.pos, bytes);
    this.pos += bytes.length;
  }
}
