// Bridge to the native Windows host (WebView2). In a plain browser it degrades
// to a no-op, so the engine can also be developed and tested in Chrome/Edge.
const webview = window.chrome?.webview;
const handlers = new Map();

webview?.addEventListener('message', e => {
  const msg = e.data;
  handlers.get(msg?.type)?.slice().forEach(fn => fn(msg));
});

export const host = {
  isDesktop: !!webview,
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(fn);
    return () => handlers.set(type, handlers.get(type).filter(f => f !== fn));
  },
  post(msg) { webview?.postMessage(msg); },

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
