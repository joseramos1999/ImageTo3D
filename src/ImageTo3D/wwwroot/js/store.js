// Local project storage (IndexedDB): the recent-projects list and crash / restart
// recovery. Images and settings live in separate stores so the settings can be
// autosaved after every change without rewriting the image each time.
//   projects: { id, name, updatedAt, thumb: Blob, settings, mask, camera, imageName }
//   images:   { id, blob }
//   looks:    { id, name, createdAt, set }   («Mis looks», looks.js)
// Everything is best-effort: if IndexedDB is unavailable the app simply works without it.

const DB_NAME = 'imageto3d', DB_VERSION = 2;
export const MAX_RECENT = 12;

let dbPromise = null;
function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('looks')) d.createObjectStore('looks', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      // A newer version of the app (another window, an update) needs to upgrade: step aside.
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onblocked = () => console.warn('IndexedDB: otra ventana con una versión anterior bloquea la actualización');
    req.onerror = () => reject(req.error);
  });
}

/** Runs fn(transaction) and resolves when the transaction commits, with fn's request result. */
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const store = {
  putProject: meta => tx(['projects'], 'readwrite', t => t.objectStore('projects').put(meta)),
  putImage: (id, blob) => tx(['images'], 'readwrite', t => t.objectStore('images').put({ id, blob })),

  /** Recent projects, newest first (metadata only). */
  async list() {
    const all = await tx(['projects'], 'readonly', t => t.objectStore('projects').getAll());
    return (all || []).sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async get(id) {
    const [meta, image] = await Promise.all([
      tx(['projects'], 'readonly', t => t.objectStore('projects').get(id)),
      tx(['images'], 'readonly', t => t.objectStore('images').get(id)),
    ]);
    return meta && image ? { meta, blob: image.blob } : null;
  },

  remove: id => tx(['projects', 'images'], 'readwrite', t => {
    t.objectStore('projects').delete(id);
    t.objectStore('images').delete(id);
  }),

  /** «Mis looks», oldest first (the order they were saved in). */
  async looks() {
    const all = await tx(['looks'], 'readonly', t => t.objectStore('looks').getAll());
    return (all || []).sort((a, b) => a.createdAt - b.createdAt);
  },
  putLook: look => tx(['looks'], 'readwrite', t => t.objectStore('looks').put(look)),
  removeLook: id => tx(['looks'], 'readwrite', t => t.objectStore('looks').delete(id)),

  /** Keeps the newest MAX_RECENT projects. */
  async prune() {
    const list = await this.list();
    for (const p of list.slice(MAX_RECENT)) await this.remove(p.id);
  },
};
