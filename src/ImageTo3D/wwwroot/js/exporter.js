// Exports: MP4 video, PNG still, GLB and STL models.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer/mp4-muxer.mjs';

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

/** Finds an encoder config the machine supports, best first. */
async function pickCodec(width, height, fps, bitrate) {
  const candidates = [
    // H.264 High → Main → Baseline, levels high enough for 4K60 down to 1080p
    ...['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.64002A', 'avc1.4D0034', 'avc1.4D0033', 'avc1.4D002A', 'avc1.42003E', 'avc1.42002A']
      .map(codec => ({ codec, muxCodec: 'avc', avc: { format: 'avc' } })),
    { codec: 'vp09.00.51.08', muxCodec: 'vp9' },
    { codec: 'av01.0.12M.08', muxCodec: 'av1' },
  ];
  for (const c of candidates) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      const config = { codec: c.codec, width, height, bitrate, framerate: fps, hardwareAcceleration, latencyMode: 'quality' };
      if (c.avc) config.avc = c.avc;
      try {
        const { supported } = await VideoEncoder.isConfigSupported(config);
        if (supported) return { config, muxCodec: c.muxCodec };
      } catch { /* try the next one */ }
    }
  }
  return null;
}

/**
 * Renders the animation frame by frame at exact timestamps and encodes it.
 * renderFrame(i, timeSeconds) must pose and render the scene onto `canvas`.
 * Every frame is rendered regardless of machine speed, so nothing is dropped.
 */
export async function exportVideo({ canvas, width, height, fps, seconds, renderFrame, onProgress, isCancelled }) {
  if (typeof VideoEncoder === 'undefined') throw new Error('Este sistema no soporta codificación de vídeo (WebCodecs).');
  const bitrate = Math.round(width * height * fps * 0.2);   // ≈12 Mbps at 1080p30, ≈50 Mbps at 4K30
  const picked = await pickCodec(width, height, fps, bitrate);
  if (!picked) throw new Error(`No hay códec de vídeo disponible para ${width}×${height}.`);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: picked.muxCodec, width, height, frameRate: fps },
    fastStart: 'in-memory',
  });
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { encodeError = e; },
  });
  encoder.configure(picked.config);

  const total = Math.round(seconds * fps);
  const frameUs = 1e6 / fps;
  try {
    for (let i = 0; i < total; i++) {
      if (encodeError) throw encodeError;
      if (isCancelled()) { encoder.close(); return null; }
      renderFrame(i, i / fps);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      // Back-pressure: let the encoder drain so memory stays flat on long 4K clips.
      while (encoder.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 2));
      if (i % 4 === 0) { onProgress((i + 1) / total); await new Promise(r => setTimeout(r, 0)); }
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  muxer.finalize();
  onProgress(1);
  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }),
    filename: `logo3d-${width}x${height}-${stamp()}.mp4`,
    codec: picked.config.codec,
  };
}

export async function exportPNG({ canvas, renderFrame, width, height }) {
  renderFrame();
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  return { blob, filename: `logo3d-${width}x${height}-${stamp()}.png` };
}

/** A copy of the logo at rest with world transforms baked in. */
function restClone(logoGroup, userScale) {
  const root = new THREE.Group();
  root.scale.setScalar(userScale);
  const clone = logoGroup.clone(true);
  clone.children.forEach(m => {
    m.position.copy(m.userData.home);
    m.rotation.set(0, 0, 0);
    m.scale.set(1, 1, 1);
  });
  root.add(clone);
  root.updateMatrixWorld(true);
  return root;
}

export async function exportGLB(logoGroup, userScale) {
  const root = restClone(logoGroup, userScale);
  root.name = 'Logo3D';
  const result = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
  return { blob: new Blob([result], { type: 'model/gltf-binary' }), filename: `logo3d-${stamp()}.glb` };
}

/** STL in millimetres, scaled so the logo is `widthMm` across, ready for a slicer. */
export function exportSTL(logoGroup, widthMm = 100) {
  const root = restClone(logoGroup, 1);
  const box = new THREE.Box3().setFromObject(root);
  const w = box.max.x - box.min.x;
  const holder = new THREE.Group();
  holder.scale.setScalar(widthMm / w);
  holder.add(root);
  holder.updateMatrixWorld(true);
  const data = new STLExporter().parse(holder, { binary: true });
  return { blob: new Blob([data], { type: 'model/stl' }), filename: `logo3d-${widthMm}mm-${stamp()}.stl` };
}
