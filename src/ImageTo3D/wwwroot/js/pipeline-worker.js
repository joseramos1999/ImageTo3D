// Web Worker: runs the image pipeline off the main thread so a large or complex
// logo never freezes the interface. Messages are handled strictly in order.
import { PipelineCore } from './pipeline-core.js';

const core = new PipelineCore();

self.onmessage = ({ data: msg }) => {
  if (msg.op === 'ping') { self.postMessage({ id: msg.id }); return; }
  try {
    const out = { id: msg.id };
    const transfer = [];
    if (msg.image) core.setImage(msg.image);
    if (msg.op === 'load' || msg.op === 'mask') {
      const a = core.analyze(msg.mask);
      out.meta = a.meta;
      out.key = a.key;
      out.color = a.color.transferToImageBitmap();
      transfer.push(out.color);
    }
    const o = core.outlines(msg.smooth, msg.mask);
    out.outlines = o.outlines;
    out.after = o.after.transferToImageBitmap();
    transfer.push(out.after);
    self.postMessage(out, transfer);
  } catch (e) {
    self.postMessage({ id: msg.id, error: e.message || String(e) });
  }
};
