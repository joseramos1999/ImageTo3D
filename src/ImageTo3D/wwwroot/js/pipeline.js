// Main-thread client for the image pipeline. Uses the Web Worker when it starts,
// and the same code in-thread otherwise, behind one promise-based API:
//   load(bitmap, mask, smooth)  new image (the bitmap is handed over to the pipeline)
//   remask(mask, smooth)        mask settings changed
//   outlines(smooth, mask)      only smoothing / denoise / holes changed
// Each resolves to { meta?, key?, color?: ImageBitmap, outlines, after: ImageBitmap }.
import { PipelineCore } from './pipeline-core.js';

let worker = null, nextId = 1;
const pending = new Map();

function viaWorker(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

// Nothing is handed to the worker until it has answered a ping: a worker whose modules
// fail to load would otherwise swallow the first image (transferred, so gone for good).
const ready = (async () => {
  try {
    worker = new Worker(new URL('./pipeline-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error)); else p.resolve(data);
    };
    worker.onerror = e => {
      console.error('pipeline worker failed:', e.message);
      pending.forEach(p => p.reject(new Error('El proceso de imagen se ha detenido.')));
      pending.clear();
    };
    await Promise.race([viaWorker({ op: 'ping' }), new Promise((_, ko) => setTimeout(() => ko(new Error('timeout')), 5000))]);
    return true;
  } catch (e) {
    console.warn('pipeline worker unavailable, running in-thread:', e.message);
    worker?.terminate();
    worker = null;
    return false;
  }
})();

const local = new PipelineCore();

async function viaLocal(msg) {
  // Yield first so the UI can paint its "processing" state.
  await new Promise(r => setTimeout(r, 0));
  if (msg.image) local.setImage(msg.image);
  const out = {};
  if (msg.op === 'load' || msg.op === 'mask') {
    const a = local.analyze(msg.mask);
    Object.assign(out, { meta: a.meta, key: a.key, color: a.color.transferToImageBitmap() });
  }
  const o = local.outlines(msg.smooth, msg.mask);
  return { ...out, outlines: o.outlines, after: o.after.transferToImageBitmap() };
}

async function run(msg, transfer) {
  return (await ready) ? viaWorker(msg, transfer) : viaLocal(msg);
}

export const pipeline = {
  ready,
  load: (image, mask, smooth) => run({ op: 'load', image, mask, smooth }, [image]),
  remask: (mask, smooth) => run({ op: 'mask', mask, smooth }),
  outlines: (smooth, mask) => run({ op: 'outlines', smooth, mask }),
};
