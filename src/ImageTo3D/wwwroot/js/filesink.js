// Streams an export straight into a file chosen with the native "Save as" dialog,
// through the desktop host, so a long 4K video never has to fit in memory.
// Only available in the desktop app; in a browser openSink() returns null.
// The bytes go through a buffer the host shares with the page: each chunk is copied in
// and the host writes it out, with no base64 or JSON in between (an uncompressed AVI
// moves ~8 MB per frame). Base64 messages remain as the fallback for older runtimes.
import { host } from './host.js';

let nextId = 1;

function toBase64(bytes) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([bytes]));
  });
}

class FileSink {
  constructor(id, path, shared) {
    this.id = id;
    this.path = path;
    this.shared = shared;       // ArrayBuffer shared with the host, or null
    this.inflight = 0;          // bytes handed over but not yet acknowledged by the host
    this.written = 0;
    this.error = null;
    this.chain = Promise.resolve();
  }

  /** Synchronous for the muxer: copies the bytes and queues them in order. */
  write(position, data) {
    const bytes = data.slice();
    this.inflight += bytes.byteLength;
    this.chain = this.chain.then(async () => {
      if (this.error) return;
      if (this.shared) {
        // One chunk at a time: the buffer is reused once the host has written it out.
        const room = this.shared.byteLength;
        for (let off = 0; off < bytes.length; off += room) {
          const n = Math.min(room, bytes.length - off);
          new Uint8Array(this.shared, 0, n).set(bytes.subarray(off, off + n));
          await host.request({ type: 'file-write-shared', id: this.id, pos: position + off, len: n }, ['file-ack']);
        }
      } else {
        const b64 = await toBase64(bytes);
        await host.request({ type: 'file-write', id: this.id, pos: position, data: b64 }, ['file-ack']);
      }
      this.written += bytes.byteLength;
    }).catch(e => { this.error ||= e; }).finally(() => { this.inflight -= bytes.byteLength; });
  }

  /** Back-pressure: waits until at most `limit` bytes are still in flight. */
  async drain(limit = 0) {
    while (this.inflight > limit && !this.error) await this.chain;
    if (this.error) throw this.error;
  }

  /** quiet: no «Guardado en…» notice (a batch reports its files itself). */
  async close({ quiet = false } = {}) {
    await this.drain(0);
    await host.request({ type: 'file-close', id: this.id, quiet }, ['file-closed']);
    this.release();
  }

  async abort() {
    try { await this.chain; } catch { /* already failed */ }
    await host.request({ type: 'file-abort', id: this.id }, ['file-closed']);
    this.release();
  }

  release() {
    if (this.shared) window.chrome.webview.releaseBuffer(this.shared);
    this.shared = null;
  }
}

/** Shows the native save dialog; resolves to a sink, or null if the user cancelled
 *  (or there is no desktop host). */
export function openSink(suggestedName) {
  return open({ name: suggestedName });
}

/** A sink for `name` inside a folder chosen with pickFolder() (batch export: no dialog). */
export function openSinkIn(dir, name) {
  return open({ name, dir });
}

/** The native folder picker; resolves to the folder's path, or null. Desktop only. */
export async function pickFolder() {
  if (!host.isDesktop) return null;
  const reply = await host.request({ type: 'pick-folder', id: String(nextId++) }, ['folder-picked', 'folder-cancelled']);
  return reply.type === 'folder-picked' ? reply.path : null;
}

/** Writes a whole blob to `name` in a picked folder. */
export async function saveBlobIn(dir, name, blob) {
  const sink = await openSinkIn(dir, name);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  for (let pos = 0; pos < bytes.length; pos += 8 << 20) sink.write(pos, bytes.subarray(pos, pos + (8 << 20)));
  await sink.close({ quiet: true });
}

async function open(request) {
  if (!host.isDesktop) return null;
  const id = String(nextId++);
  // The host shares the buffer just before it confirms the file.
  let shared = null;
  const off = host.on('file-buffer', msg => { if (msg.id === id) shared = msg.buffer; });
  try {
    const reply = await host.request({ type: 'file-open', id, ...request }, ['file-opened', 'file-cancelled']);
    return reply.type === 'file-opened' ? new FileSink(id, reply.path, shared) : null;
  } finally {
    off();
  }
}
