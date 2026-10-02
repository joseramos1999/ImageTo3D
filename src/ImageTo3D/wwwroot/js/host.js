// Bridge to the native Windows host (WebView2). In a plain browser it degrades
// to a no-op, so the engine can also be developed and tested in Chrome/Edge.
const webview = window.chrome?.webview;
const handlers = new Map();

webview?.addEventListener('message', e => {
  const msg = e.data;
  handlers.get(msg?.type)?.forEach(fn => fn(msg));
});

export const host = {
  isDesktop: !!webview,
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(fn);
  },
  post(msg) { webview?.postMessage(msg); },
};
