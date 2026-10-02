// Project files (.i3d) and undo / redo history.
//
// An .i3d file is JSON with the original image embedded (base64), so it opens on any
// machine:  { app, version, name, savedAt, settings, mask, camera, image: { name, type, data } }

import { DEFAULT_MASK } from './trace.js';

export const PROJECT_EXT = 'i3d';
const APP_ID = 'ImageTo3D', VERSION = 1;

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

/** Parses and validates an .i3d file. Throws an Error with a message for the user. */
export function parseProject(text) {
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('El archivo no es un proyecto de ImageTo3D válido.'); }
  if (!p || p.app !== APP_ID) throw new Error('El archivo no es un proyecto de ImageTo3D.');
  if (p.version > VERSION) throw new Error('Este proyecto se creó con una versión más nueva de ImageTo3D. Actualiza la aplicación.');
  if (!p.image?.data) throw new Error('El proyecto no contiene la imagen.');
  return {
    name: String(p.name || 'Proyecto'),
    settings: p.settings && typeof p.settings === 'object' ? p.settings : {},
    mask: { ...DEFAULT_MASK, ...(p.mask || {}) },
    camera: p.camera || null,
    image: { name: String(p.image.name || 'imagen'), blob: base64ToBlob(p.image.data, p.image.type || 'image/png') },
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
