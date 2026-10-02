// Streams an export straight into a file chosen with the native "Save as" dialog,
// through the desktop host, so a long 4K video never has to fit in memory.
// Only available in the desktop app; in a browser openSink() returns null.
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
  constructor(id, path) {
    this.id = id;
    this.path = path;
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
      const b64 = await toBase64(bytes);
      await host.request({ type: 'file-write', id: this.id, pos: position, data: b64 }, ['file-ack']);
      this.written += bytes.byteLength;
    }).catch(e => { this.error ||= e; }).finally(() => { this.inflight -= bytes.byteLength; });
  }

  /** Back-pressure: waits until at most `limit` bytes are still in flight. */
  async drain(limit = 0) {
    while (this.inflight > limit && !this.error) await this.chain;
    if (this.error) throw this.error;
  }

  async close() {
    await this.drain(0);
    await host.request({ type: 'file-close', id: this.id }, ['file-closed']);
  }

  async abort() {
    try { await this.chain; } catch { /* already failed */ }
    await host.request({ type: 'file-abort', id: this.id }, ['file-closed']);
  }
}

/** Shows the native save dialog; resolves to a sink, or null if the user cancelled
 *  (or there is no desktop host). */
export async function openSink(suggestedName) {
  if (!host.isDesktop) return null;
  const id = String(nextId++);
  const reply = await host.request({ type: 'file-open', id, name: suggestedName }, ['file-opened', 'file-cancelled']);
  return reply.type === 'file-opened' ? new FileSink(id, reply.path) : null;
}
