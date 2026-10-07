// Exports: MP4 / WebM / AVI video, PNG sequence (ZIP), PNG still, GLB and STL models.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import * as MP4 from '../vendor/mp4-muxer/mp4-muxer.mjs';
import * as WEBM from '../vendor/webm-muxer/webm-muxer.mjs';
import { ZipWriter } from './zip.js';
import { AviWriter } from './avi.js';

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

/** Video containers: what each can hold and how its muxer names the codec. */
const CODECS = {
  // H.264 High → Main → Baseline, levels high enough for 4K60 down to 1080p; VP9 / AV1 as a last resort
  mp4: [
    ...['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.64002A', 'avc1.4D0034', 'avc1.4D0033', 'avc1.4D002A', 'avc1.42003E', 'avc1.42002A']
      .map(codec => ({ codec, muxCodec: 'avc', avc: { format: 'avc' } })),
    { codec: 'vp09.00.51.08', muxCodec: 'vp9' },
    { codec: 'av01.0.12M.08', muxCodec: 'av1' },
  ],
  webm: [
    { codec: 'vp09.00.51.08', muxCodec: 'V_VP9' },
    { codec: 'vp09.00.41.08', muxCodec: 'V_VP9' },
    { codec: 'vp8', muxCodec: 'V_VP8' },
  ],
};

/** Finds an encoder config the machine supports, best first. */
async function pickCodec(container, width, height, fps, bitrate) {
  for (const c of CODECS[container]) {
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

/** ≈12 Mbps at 1080p30, ≈50 Mbps at 4K30. */
export const videoBitrate = (width, height, fps) => Math.round(width * height * fps * 0.2);

/** Expected file size in bytes (the encoder targets this bitrate; real files land close).
 *  A transparent WebM carries a second (alpha) stream; PNG frames of a logo on a clear
 *  background run around 0.6 bytes per pixel. */
export function estimateBytes(kind, width, height, fps, seconds, alpha) {
  if (kind === 'pngseq') return width * height * 0.6 * fps * seconds;
  if (kind === 'avi') return width * height * 0.06 * fps * seconds;   // JPEG at quality 0.92 (measured 0.035 on a dark plain background)
  if (kind === 'avi-rgba') return (width * height * 4 + 32) * fps * seconds;   // uncompressed: exact
  return videoBitrate(width, height, fps) * seconds / 8 * (alpha ? 1.35 : 1);
}

const supportCache = new Map();
/** Can this machine render (GPU) and, for video, encode at this size? → { ok, reason } */
export async function checkVideoSupport(renderer, kind, width, height, fps) {
  const gl = renderer.getContext();
  const maxRender = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE));
  if (Math.max(width, height) > maxRender) {
    return { ok: false, reason: `Tu tarjeta gráfica no puede renderizar a ${width}×${height} (máximo ${maxRender} px). Elige un tamaño menor.` };
  }
  if (kind === 'pngseq' || kind.startsWith('avi')) return { ok: true };   // image encoders, no video codec needed
  if (typeof VideoEncoder === 'undefined') return { ok: false, reason: 'Este sistema no soporta codificación de vídeo (WebCodecs).' };
  const key = `${kind}:${width}x${height}@${fps}`;
  if (!supportCache.has(key)) supportCache.set(key, pickCodec(kind, width, height, fps, videoBitrate(width, height, fps)));
  return (await supportCache.get(key))
    ? { ok: true }
    : { ok: false, reason: `Tu equipo no tiene un codificador ${kind === 'webm' ? 'VP9' : 'H.264'} para ${width}×${height} a ${fps} fps. Prueba un tamaño menor o 30 fps.` };
}

/**
 * Reads the rendered frame back (WebGL rows run bottom-up, colours premultiplied) and
 * produces what a transparent WebM needs: the colour image with straight alpha, and the
 * alpha plane as the luma of an I420 frame (chroma flat at 128) for its own VP9 stream.
 */
class AlphaSplitter {
  constructor(gl, width, height) {
    this.gl = gl; this.w = width; this.h = height;
    this.pixels = new Uint8Array(width * height * 4);
    this.color = new Uint8Array(width * height * 4);
    this.alpha = new Uint8Array(width * height * 3 / 2).fill(128);
  }

  read() {
    const { gl, w, h, pixels, color, alpha } = this;
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let y = 0; y < h; y++) {
      let s = (h - 1 - y) * w * 4, d = y * w * 4, ya = y * w;
      for (let x = 0; x < w; x++, s += 4, d += 4) {
        const a = pixels[s + 3];
        alpha[ya + x] = a;
        if (a === 255) { color[d] = pixels[s]; color[d + 1] = pixels[s + 1]; color[d + 2] = pixels[s + 2]; }
        else if (a === 0) { color[d] = color[d + 1] = color[d + 2] = 0; }
        else {
          const k = 255 / a;
          color[d] = Math.min(255, pixels[s] * k);
          color[d + 1] = Math.min(255, pixels[s + 1] * k);
          color[d + 2] = Math.min(255, pixels[s + 2] * k);
        }
        color[d + 3] = 255;
      }
    }
  }

  frames(timestamp, duration) {
    const init = { codedWidth: this.w, codedHeight: this.h, timestamp, duration };
    return {
      color: new VideoFrame(this.color, { ...init, format: 'RGBA' }),
      alpha: new VideoFrame(this.alpha, { ...init, format: 'I420' }),
    };
  }
}

/**
 * Renders the animation frame by frame at exact timestamps and encodes it.
 * renderFrame(i, timeSeconds) must pose and render the scene onto `canvas`.
 * Every frame is rendered regardless of machine speed, so nothing is dropped.
 *
 * kind 'mp4' (H.264) or 'webm' (VP9; with `alpha` it keeps the transparency).
 * With a `sink` (desktop app) the file is streamed to disk as it encodes, so memory
 * stays flat however long the clip; without one it is built in memory and returned.
 */
export async function exportVideo({ canvas, renderer, kind = 'mp4', alpha = false, width, height, fps, seconds, renderFrame, onProgress, isCancelled, sink = null }) {
  if (typeof VideoEncoder === 'undefined') throw new Error('Este sistema no soporta codificación de vídeo (WebCodecs).');
  const bitrate = videoBitrate(width, height, fps);
  const picked = await pickCodec(kind, width, height, fps, bitrate);
  if (!picked) throw new Error(`No hay códec de vídeo disponible para ${width}×${height}.`);
  const withAlpha = alpha && kind === 'webm';

  const lib = kind === 'webm' ? WEBM : MP4;
  const memory = sink ? null : new lib.ArrayBufferTarget();
  const target = sink
    ? new lib.StreamTarget({ onData: (data, position) => sink.write(position, data), chunked: true, chunkSize: 4 * 1024 * 1024 })
    : memory;
  const muxer = kind === 'webm'
    ? new WEBM.Muxer({ target, video: { codec: picked.muxCodec, width, height, frameRate: fps, alpha: withAlpha } })
    : new MP4.Muxer({
      target,
      video: { codec: picked.muxCodec, width, height, frameRate: fps },
      // Streaming puts the index at the end (the header is patched once all frames are in);
      // in memory it goes first. Both play everywhere.
      fastStart: sink ? false : 'in-memory',
    });

  let encodeError = null;
  const fail = e => { encodeError ||= e; };
  const encoders = [];
  let colorEncoder;
  if (!withAlpha) {
    colorEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
  } else {
    // Two VP9 streams in lockstep: colour, and the alpha plane as luma. Each frame is
    // muxed once both halves exist, with the alpha as its BlockAdditional.
    const pending = new Map();
    const pair = (ts, part, value) => {
      const p = pending.get(ts) || {};
      p[part] = value;
      if (!p.color || !p.alpha) { pending.set(ts, p); return; }
      pending.delete(ts);
      const bytes = new Uint8Array(p.color.chunk.byteLength);
      p.color.chunk.copyTo(bytes);
      muxer.addVideoChunkRaw(bytes, p.color.chunk.type, ts, { ...(p.color.meta || {}), alphaSideData: p.alpha });
    };
    colorEncoder = new VideoEncoder({ output: (chunk, meta) => pair(chunk.timestamp, 'color', { chunk, meta }), error: fail });
    const alphaEncoder = new VideoEncoder({
      output: chunk => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); pair(chunk.timestamp, 'alpha', b); },
      error: fail,
    });
    alphaEncoder.configure({ ...picked.config, bitrate: Math.round(bitrate * 0.35) });
    encoders.push(alphaEncoder);
  }
  colorEncoder.configure(picked.config);
  encoders.unshift(colorEncoder);
  const splitter = withAlpha ? new AlphaSplitter(renderer.getContext(), width, height) : null;

  const total = Math.round(seconds * fps);
  const frameUs = 1e6 / fps;
  const maxQueue = Math.max(2, Math.min(6, Math.floor(100e6 / (width * height * 4))));
  try {
    for (let i = 0; i < total; i++) {
      if (encodeError) throw encodeError;
      if (isCancelled()) { encoders.forEach(e => e.close()); return null; }
      renderFrame(i, i / fps);
      const timestamp = Math.round(i * frameUs), duration = Math.round(frameUs);
      const keyFrame = i % (fps * 2) === 0;
      if (splitter) {
        splitter.read();
        const f = splitter.frames(timestamp, duration);
        colorEncoder.encode(f.color, { keyFrame });
        encoders[1].encode(f.alpha, { keyFrame });
        f.color.close(); f.alpha.close();
      } else {
        const frame = new VideoFrame(canvas, { timestamp, duration });
        colorEncoder.encode(frame, { keyFrame });
        frame.close();
      }
      // Back-pressure: let the encoders drain so memory stays flat on long 4K clips (each
      // queued frame is a full RGBA copy: ~8 MB at 1080p, ~33 MB at 4K → keep ~100 MB)...
      while (encoders.some(e => e.encodeQueueSize > maxQueue)) await new Promise(r => setTimeout(r, 2));
      // ...and the disk keep up, when streaming.
      if (sink) await sink.drain(32 * 1024 * 1024);
      if (i % 4 === 0) { onProgress((i + 1) / total); await new Promise(r => setTimeout(r, 0)); }
    }
    await Promise.all(encoders.map(e => e.flush()));
    if (encodeError) throw encodeError;
  } finally {
    encoders.forEach(e => { if (e.state !== 'closed') e.close(); });
  }
  muxer.finalize();
  if (sink) await sink.close();
  onProgress(1);
  return {
    blob: memory ? new Blob([memory.buffer], { type: kind === 'webm' ? 'video/webm' : 'video/mp4' }) : null,
    path: sink?.path ?? null,
    bytes: memory ? memory.buffer.byteLength : sink.written,
    codec: picked.config.codec,
  };
}

/**
 * The animation as one PNG per frame, packed in a ZIP: the format editors (Premiere,
 * After Effects, DaVinci Resolve) import as a clip with transparency.
 */
export async function exportPngSequence({ canvas, width, height, fps, seconds, renderFrame, onProgress, isCancelled, sink = null }) {
  const parts = [];
  const zip = new ZipWriter(sink ? (pos, bytes) => sink.write(pos, bytes) : (pos, bytes) => parts.push(bytes));
  const total = Math.round(seconds * fps);
  const digits = String(total).length < 5 ? 5 : String(total).length;
  for (let i = 0; i < total; i++) {
    if (isCancelled()) return null;
    renderFrame(i, i / fps);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    zip.addFile(`frame_${String(i + 1).padStart(digits, '0')}.png`, new Uint8Array(await blob.arrayBuffer()));
    if (sink) await sink.drain(32 * 1024 * 1024);
    onProgress((i + 1) / total);
  }
  const readme = `Secuencia PNG de ImageTo3D\n${total} fotogramas · ${width}×${height} · ${fps} fps\n\n` +
    `Importa la carpeta como secuencia de imágenes a ${fps} fps (Premiere: Importar > Secuencia de imágenes;\n` +
    `After Effects: Importar archivo > Secuencia PNG; DaVinci Resolve: arrastra la carpeta).\n`;
  zip.addFile('LEEME.txt', new TextEncoder().encode(readme));
  zip.finish();
  if (sink) await sink.close();
  onProgress(1);
  return { blob: sink ? null : new Blob(parts, { type: 'application/zip' }), path: sink?.path ?? null };
}

/**
 * In-memory target for writers that patch earlier bytes at the end (AVI header): appends
 * in order, and a write to an earlier position is applied to the part already holding it.
 */
function memoryTarget() {
  const parts = [];
  let size = 0;
  return {
    parts,
    write(pos, bytes) {
      if (pos === size) { parts.push(bytes.slice()); size += bytes.length; return; }
      let start = 0;
      for (const part of parts) {
        if (pos >= start && pos + bytes.length <= start + part.length) { part.set(bytes, pos - start); return; }
        start += part.length;
      }
      throw new Error('escritura fuera de orden');
    },
  };
}

/**
 * Reads the rendered frame back as an uncompressed 32-bit DIB: BGRA with straight alpha.
 * WebGL already returns the rows bottom-up, the order a DIB with positive height uses;
 * the colours come premultiplied and are divided back by the alpha.
 */
function readBgra(gl, width, height, pixels) {
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  for (let s = 0; s < pixels.length; s += 4) {
    const r = pixels[s], b = pixels[s + 2], a = pixels[s + 3];
    if (a === 255) { pixels[s] = b; pixels[s + 2] = r; }
    else if (a === 0) { pixels[s] = pixels[s + 1] = pixels[s + 2] = 0; }
    else {
      const k = 255 / a;
      pixels[s] = Math.min(255, b * k);
      pixels[s + 1] = Math.min(255, pixels[s + 1] * k);
      pixels[s + 2] = Math.min(255, r * k);
    }
  }
  return pixels;
}

/**
 * The animation as an AVI. codec 'mjpg': Motion-JPEG frames, opens in practically any
 * player or editor, but JPEG has no alpha so a transparent background comes out black.
 * codec 'rgba': uncompressed RGB + alpha, like After Effects' «None» codec; keeps the
 * transparency, at width·height·4 bytes per frame.
 */
export async function exportAvi({ canvas, renderer, codec = 'mjpg', width, height, fps, seconds, renderFrame, onProgress, isCancelled, sink = null, quality = 0.92 }) {
  const memory = sink ? null : memoryTarget();
  const avi = new AviWriter(sink ? (pos, bytes) => sink.write(pos, bytes) : memory.write, { width, height, fps, codec });
  const total = Math.round(seconds * fps);
  const gl = renderer?.getContext();
  const pixels = codec === 'rgba' ? new Uint8Array(width * height * 4) : null;
  for (let i = 0; i < total; i++) {
    if (isCancelled()) return null;
    renderFrame(i, i / fps);
    if (pixels) {
      // The sink and the memory target copy what they are given, so one buffer serves all frames.
      avi.addFrame(readBgra(gl, width, height, pixels));
      if (i % 2 === 0) await new Promise(r => setTimeout(r, 0));
    } else {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
      avi.addFrame(new Uint8Array(await blob.arrayBuffer()));
    }
    if (sink) await sink.drain(32 * 1024 * 1024);
    onProgress((i + 1) / total);
  }
  avi.finish();
  if (sink) await sink.close();
  onProgress(1);
  return { blob: sink ? null : new Blob(memory.parts, { type: 'video/x-msvideo' }), path: sink?.path ?? null };
}

const EXT = { mp4: 'mp4', webm: 'webm', avi: 'avi', 'avi-rgba': 'avi', pngseq: 'zip' };
export const animationFileName = (kind, width, height) => `logo3d-${width}x${height}-${stamp()}.${EXT[kind]}`;

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
    m.visible = true;
    m.rotation.set(0, 0, 0);
    m.scale.set(1, 1, 1);
  });
  root.add(clone);
  root.updateMatrixWorld(true);
  return root;
}

/**
 * GLB of the logo. With `animation` the clip is sampled into keyframe tracks for the animated
 * group and every piece (a hidden piece becomes scale 0: glTF has no visibility track), plus
 * an animated camera when `animation.camera` is given. Shader effects (deformation, dissolve,
 * outline, portal) have no glTF equivalent and are left out; the motion is all there.
 *   animation: { seconds, fps, aspect, pose(t, motion, pieces), camera?(t) → { position, quaternion, fov } }
 */
export async function exportGLB(logoGroup, userScale, animation = null) {
  if (!animation) {
    const root = restClone(logoGroup, userScale);
    root.name = 'Logo3D';
    const result = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
    return { blob: new Blob([result], { type: 'model/gltf-binary' }), filename: `logo3d-${stamp()}.glb` };
  }
  // Scene → Logo3D (user scale) → Movimiento (animated) → Logo → Pieza_n; and Camara.
  const scene = new THREE.Group();
  scene.name = 'Escena';
  const root = new THREE.Group();
  root.name = 'Logo3D';
  root.scale.setScalar(userScale);
  const motion = new THREE.Group();
  motion.name = 'Movimiento';
  const logo = logoGroup.clone(true);
  logo.name = 'Logo';
  // clone() turns userData into plain JSON; animations need the real vectors back.
  logo.children.forEach((m, i) => { m.userData = logoGroup.children[i].userData; m.name = `Pieza_${i + 1}`; });
  motion.add(logo);
  root.add(motion);
  scene.add(root);
  let cam = null;
  if (animation.camera) {
    const c0 = animation.camera(0);
    cam = new THREE.PerspectiveCamera(c0.fov, animation.aspect || 16 / 9, 0.1, 200);
    cam.name = 'Camara';
    scene.add(cam);
  }

  const fps = animation.fps || 30, n = Math.max(2, Math.round(animation.seconds * fps) + 1);
  const times = new Float32Array(n);
  const nodes = [motion, ...logo.children];
  const rec = nodes.map(() => ({ p: new Float32Array(n * 3), q: new Float32Array(n * 4), s: new Float32Array(n * 3) }));
  const camRec = cam ? { p: new Float32Array(n * 3), q: new Float32Array(n * 4) } : null;
  for (let i = 0; i < n; i++) {
    const t = Math.min(animation.seconds, i / fps);
    times[i] = t;
    animation.pose(t, motion, logo.children);
    nodes.forEach((o, k) => {
      o.position.toArray(rec[k].p, i * 3);
      o.quaternion.toArray(rec[k].q, i * 4);
      (o.visible ? o.scale : new THREE.Vector3(0.0001, 0.0001, 0.0001)).toArray(rec[k].s, i * 3);
    });
    if (camRec) {
      const c = animation.camera(t);
      c.position.toArray(camRec.p, i * 3);
      c.quaternion.toArray(camRec.q, i * 4);
    }
  }
  // Rest pose for the file's default state; keep only the tracks that actually move.
  nodes.forEach(o => { o.visible = true; });
  motion.position.set(0, 0, 0); motion.quaternion.identity(); motion.scale.set(1, 1, 1);
  logo.children.forEach(m => { m.position.copy(m.userData.home); m.quaternion.identity(); m.scale.set(1, 1, 1); });
  const moves = (arr, size) => { for (let i = size; i < arr.length; i++) if (Math.abs(arr[i] - arr[i % size]) > 1e-5) return true; return false; };
  const tracks = [];
  nodes.forEach((o, k) => {
    const r = rec[k];
    if (moves(r.p, 3)) tracks.push(new THREE.VectorKeyframeTrack(`${o.name}.position`, times, r.p));
    if (moves(r.q, 4)) tracks.push(new THREE.QuaternionKeyframeTrack(`${o.name}.quaternion`, times, r.q));
    if (moves(r.s, 3)) tracks.push(new THREE.VectorKeyframeTrack(`${o.name}.scale`, times, r.s));
  });
  if (cam) {
    cam.position.fromArray(camRec.p, 0);
    cam.quaternion.fromArray(camRec.q, 0);
    if (moves(camRec.p, 3)) tracks.push(new THREE.VectorKeyframeTrack('Camara.position', times, camRec.p));
    if (moves(camRec.q, 4)) tracks.push(new THREE.QuaternionKeyframeTrack('Camara.quaternion', times, camRec.q));
  }
  const clip = new THREE.AnimationClip('Animacion', animation.seconds, tracks);
  scene.updateMatrixWorld(true);
  const result = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false, animations: tracks.length ? [clip] : [] });
  return { blob: new Blob([result], { type: 'model/gltf-binary' }), filename: `logo3d-animado-${stamp()}.glb`, tracks: tracks.length, frames: n };
}

/** STL of the printable part (print.js: millimetres, z up, base and orientation applied). */
export function exportSTL(printGroup, widthMm = 100) {
  printGroup.updateMatrixWorld(true);
  const data = new STLExporter().parse(printGroup, { binary: true });
  return { blob: new Blob([data], { type: 'model/stl' }), filename: `logo3d-${widthMm}mm-${stamp()}.stl` };
}
