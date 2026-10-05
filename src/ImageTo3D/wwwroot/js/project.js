// Project files (.i3d) and undo / redo history.
//
// An .i3d file is JSON with the original image embedded (base64), so it opens on any
// machine:  { app, version, name, savedAt, settings, mask, camera, image: { name, type, data } }

import { DEFAULT_MASK } from './trace.js';
import { LIMITS } from './imaging.js';

export const PROJECT_EXT = 'i3d';
const APP_ID = 'ImageTo3D', VERSION = 1;
// Same cap as the desktop host: the embedded image is limited to LIMITS.maxBytes, which in
// base64 is 4/3 of that, plus a little JSON around it.
export const MAX_PROJECT_BYTES = 400 * 1024 * 1024;
const MAX_IMAGE_B64 = Math.ceil(LIMITS.maxBytes / 3) * 4;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif', 'image/bmp'];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const mb = n => Math.round(n / 1024 / 1024);

/** Settings that belong to the work (not to the UI): what projects and history store. */
const UI_ONLY = ['animTab', 'format'];
export function workSettings(state) {
  const s = { ...state };
  UI_ONLY.forEach(k => delete s[k]);
  return s;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export async function serializeProject({ name, settings, mask, camera, image }) {
  return JSON.stringify({
    app: APP_ID, version: VERSION, name, savedAt: new Date().toISOString(),
    settings, mask, camera,
    image: { name: image.name, type: image.blob.type || 'image/png', data: await blobToBase64(image.blob) },
  });
}

/** Reads and validates an .i3d file, refusing oversized ones before loading them. */
export async function readProjectFile(file) {
  if (file.size > MAX_PROJECT_BYTES) {
    throw new Error(`El proyecto pesa ${mb(file.size)} MB y el máximo es ${mb(MAX_PROJECT_BYTES)} MB.`);
  }
  return parseProject(await file.text());
}

/** Parses and validates an .i3d file. Throws an Error with a message for the user. */
export function parseProject(text) {
  if (typeof text !== 'string' || text.length > MAX_PROJECT_BYTES) throw new Error('El proyecto es demasiado grande.');
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('El archivo no es un proyecto de ImageTo3D válido.'); }
  if (!p || p.app !== APP_ID) throw new Error('El archivo no es un proyecto de ImageTo3D.');
  if (p.version > VERSION) throw new Error('Este proyecto se creó con una versión más nueva de ImageTo3D. Actualiza la aplicación.');
  const data = p.image?.data;
  if (!data) throw new Error('El proyecto no contiene la imagen.');
  // Checked before decoding: a string of the right size and alphabet, and an image type.
  if (typeof data !== 'string' || data.length % 4 !== 0 || !BASE64.test(data)) throw new Error('La imagen del proyecto está dañada.');
  if (data.length > MAX_IMAGE_B64) throw new Error(`La imagen del proyecto pesa más de ${mb(LIMITS.maxBytes)} MB, el máximo.`);
  const type = IMAGE_TYPES.includes(p.image.type) ? p.image.type : 'image/png';
  return {
    name: String(p.name || 'Proyecto').slice(0, 200),
    settings: p.settings && typeof p.settings === 'object' ? p.settings : {},
    mask: { ...DEFAULT_MASK, ...(p.mask || {}) },
    camera: p.camera || null,
    image: { name: String(p.image.name || 'imagen').slice(0, 200), blob: base64ToBlob(data, type) },
  };
}

/**
 * Snapshot history. An entry is { settings, mask, src: { blob, name } }; the image is
 * referenced, not copied, so undoing an image change costs nothing to keep around.
 */
export class History {
  constructor(limit = 100) { this.limit = limit; this.entries = []; this.cursor = -1; }

  static same(a, b) {
    return !!a && !!b && a.src.blob === b.src.blob &&
      JSON.stringify(a.settings) === JSON.stringify(b.settings) && JSON.stringify(a.mask) === JSON.stringify(b.mask);
  }

  /** Records the current state unless it is what the cursor already points at. */
  push(entry) {
    if (History.same(entry, this.entries[this.cursor])) return false;
    this.entries.splice(this.cursor + 1);
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    this.cursor = this.entries.length - 1;
    return true;
  }

  get canUndo() { return this.cursor > 0; }
  get canRedo() { return this.cursor < this.entries.length - 1; }
  undo() { return this.canUndo ? this.entries[--this.cursor] : null; }
  redo() { return this.canRedo ? this.entries[++this.cursor] : null; }
  clear() { this.entries = []; this.cursor = -1; }
}
