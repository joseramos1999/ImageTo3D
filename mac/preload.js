// The only thing the engine page sees of Electron: a message channel to the host, the same
// shape as WebView2's on Windows (wwwroot/js/host.js uses either).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('imageto3dHost', {
  platform: process.platform,
  postMessage: msg => ipcRenderer.send('host', msg),
  onMessage: cb => ipcRenderer.on('host', (_event, msg) => cb(msg)),
});
