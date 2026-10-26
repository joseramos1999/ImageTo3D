// Bridge to the native host: WebView2 on Windows (src/ImageTo3D), or Electron on macOS (mac/,
// whose preload exposes window.imageto3dHost). In a plain browser it degrades to a no-op, so
// the engine can also be developed and tested in Chrome/Edge.
const webview = window.chrome?.webview;
const electron = window.imageto3dHost;
const handlers = new Map();
const dispatch = msg => handlers.get(msg?.type)?.slice().forEach(fn => fn(msg));

webview?.addEventListener('message', e => dispatch(e.data));
// Memory shared with the host (streamed exports): dispatched like a message, with the
// ArrayBuffer as `buffer`.
webview?.addEventListener('sharedbufferreceived', e => dispatch({ ...e.additionalData, buffer: e.getBuffer() }));
electron?.onMessage(dispatch);

export const host = {
  isDesktop: !!(webview || electron),
  /** 'win32' (WebView2), 'darwin' / 'win32' / 'linux' (Electron), or 'web'. */
  platform: electron ? electron.platform : webview ? 'win32' : 'web',
  /** Electron's messages carry binary data as is, so file chunks need no shared buffer or base64. */
  binary: !!electron,
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(fn);
    return () => handlers.set(type, handlers.get(type).filter(f => f !== fn));
  },
  post(msg) { (webview || electron)?.postMessage(msg); },

  /** Posts `msg` and resolves with the first reply of one of `types` carrying the same id.
   *  A 'file-error' reply for that id rejects. */
  request(msg, types) {
    return new Promise((resolve, reject) => {
      const offs = [];
      const done = () => offs.forEach(off => off());
      for (const t of [...types, 'file-error']) {
        offs.push(host.on(t, reply => {
          if (reply.id !== msg.id) return;
          done();
          if (t === 'file-error') reject(new Error(reply.message || 'error de escritura')); else resolve(reply);
        }));
      }
      host.post(msg);
    });
  },
};

/** Shortcut labels as the system writes them: "Ctrl+Z" on Windows, "⌘Z" on a Mac. */
const mac = host.platform === 'darwin' || /^Mac/.test(navigator.platform);
export const keys = text => mac ? text.replace(/Ctrl\+Y/g, '⌘⇧Z').replace(/Ctrl\+/g, '⌘') : text;

/** Rewrites the shortcut labels already in the page (titles and text) for this system. */
export function localizeKeys(root = document.body) {
  if (!mac) return;
  for (const el of root.querySelectorAll('[title*="Ctrl+"]')) el.title = keys(el.title);
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.includes('Ctrl+')) n.nodeValue = keys(n.nodeValue);
}
