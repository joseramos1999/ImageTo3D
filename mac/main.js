// ImageTo3D for macOS: the same 3D engine as the Windows app (src/ImageTo3D/wwwroot), hosted
// in Electron instead of WPF + WebView2. This process plays the part of MainWindow.xaml.cs:
// it serves the engine, shows the native dialogs, writes exports to disk, opens .i3d projects,
// shows a recoverable error screen and checks for new versions.
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { Files } = require('./host/files');
const { checkForUpdate, isReleasePage } = require('./host/updates');
const { runSmoke, runSmokeNoGpu } = require('./host/smoke');

const HOST = 'imageto3d';
const ENGINE_URL = `app://${HOST}/index.html`;
const SMOKE = process.argv.includes('--smoke-test') || process.env.IMAGETO3D_SMOKE === '1';
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'wwwroot') : path.join(__dirname, '..', 'src', 'ImageTo3D', 'wwwroot');
const MAX_PROJECT = 400 * 1024 * 1024;

// The engine is served from app://imageto3d/ — a standard, secure scheme, so ES modules,
// the Web Worker, fetch and WebCodecs behave as on https.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);
app.setName('ImageTo3D');
// CI Macs are virtual machines, often without a usable GPU: let the smoke test fall back to
// Chrome's software WebGL instead of failing (a real Mac always has Metal).
if (SMOKE) app.commandLine.appendSwitch('enable-unsafe-swiftshader');
// GitHub's Intel Macs have neither a GPU nor a working software WebGL: there
// (IMAGETO3D_SMOKE_NO_GPU=1) the engine's WebGL error is expected and the test checks the rest.
const SMOKE_NO_GPU = SMOKE && process.env.IMAGETO3D_SMOKE_NO_GPU === '1';
let smokeStarted = false;

let win = null, files = null, ready = false, readyTimer = null, updateTimer = null, available = null;
let pendingProject = process.argv.slice(1).find(a => a.toLowerCase().endsWith('.i3d') && fs.existsSync(a)) || null;
const listeners = new Set();   // the smoke test watches what the host tells the page

function post(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('host', msg);
  for (const l of listeners) l(msg);
}

/** Only the engine's own page may talk to the host (it opens dialogs and writes files). */
const fromEngine = frame => {
  try { const u = new URL(frame.url); return u.protocol === 'app:' && u.host === HOST; } catch { return false; }
};

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 680,
    title: 'ImageTo3D', backgroundColor: '#0e0e12', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      backgroundThrottling: !SMOKE,   // the smoke test renders in an unfocused window
    },
  });
  files = new Files({ window: win, post, smokeDir: SMOKE ? fs.mkdtempSync(path.join(os.tmpdir(), 'imageto3d-smoke-')) : null });
  files.attachDownloads(win.webContents.session);

  // The window only ever shows the engine: no navigation elsewhere, no pop-ups.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`app://${HOST}/`)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => { if (isMain) showError(`La página del motor no se pudo abrir (${desc || code}).`); });
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') showError(`El motor 3D se ha detenido (${details.reason}). Tu último trabajo se recupera al reintentar.`);
  });
  win.webContents.on('did-finish-load', () => {
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => { if (!ready) showError('El motor 3D no ha terminado de arrancar. Puede que la tarjeta gráfica no admita WebGL 2.'); }, 25000);
  });
  // The smoke test shows the window without focus: a never-shown window may not paint on macOS.
  win.once('ready-to-show', () => { if (SMOKE) win.showInactive(); else win.show(); });
  win.on('closed', () => { files.discardAll(); win = null; });
  win.loadURL(ENGINE_URL);
}

async function showError(message) {
  if (!win || win.isDestroyed()) return;
  if (SMOKE) {
    if (SMOKE_NO_GPU && /WebGL context/i.test(message)) { smoke(message); return; }
    console.error('ENGINE ERROR:', message); app.exit(2); return;
  }
  const r = await dialog.showMessageBox(win, {
    type: 'error', title: 'ImageTo3D', message: 'No se pudo cargar el motor 3D', detail: message,
    buttons: ['Reintentar', 'Salir'], defaultId: 0, cancelId: 1,
  });
  if (r.response === 0) { ready = false; win.loadURL(ENGINE_URL); } else app.quit();
}

function openProject(file) {
  if (!file) return;
  if (!ready) { pendingProject = file; return; }
  try {
    if (fs.statSync(file).size > MAX_PROJECT) throw new Error('el archivo pesa más de 400 MB');
    post({ type: 'open-project', name: path.basename(file), text: fs.readFileSync(file, 'utf8') });
  } catch (e) {
    dialog.showMessageBox(win, { type: 'warning', message: 'No se pudo abrir el proyecto', detail: `${file}\n\n${e.message}` });
  }
}

async function checkUpdates(manual) {
  try {
    available = await checkForUpdate();
    if (available) post({ type: 'update-available', ...available });
    else if (manual) post({ type: 'update-none', current: app.getVersion() });
  } catch (e) {
    if (manual) post({ type: 'update-error', message: 'No se pudo consultar si hay una versión nueva. Comprueba la conexión.' });
  }
}

ipcMain.on('host', (event, msg) => {
  if (!fromEngine(event.senderFrame) || !msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'ready':
      ready = true;
      clearTimeout(readyTimer);
      post({ type: 'host-info', version: app.getVersion(), platform: process.platform });
      if (pendingProject) { const f = pendingProject; pendingProject = null; openProject(f); }
      if (SMOKE) { smoke(); break; }
      if (app.isPackaged && !updateTimer) {
        setTimeout(() => checkUpdates(false), 4000);
        updateTimer = setInterval(() => checkUpdates(false), 12 * 3600 * 1000);
      }
      break;
    case 'title': if (win) win.setTitle(String(msg.text || 'ImageTo3D')); break;
    case 'reveal': if (typeof msg.path === 'string' && fs.existsSync(msg.path)) shell.showItemInFolder(msg.path); break;
    case 'engine-error': showError('El motor 3D no pudo arrancar: ' + (msg.message || 'error desconocido')); break;
    case 'update-check': checkUpdates(true); break;
    case 'update-install':
    case 'open-release':
      if (available && isReleasePage(available.page)) shell.openExternal(available.page);
      break;
    case 'file-open': case 'file-write-bin': case 'file-close': case 'file-abort': case 'pick-folder':
      files.handle(msg);
      break;
  }
});

/** `noGpu`: the engine's WebGL error on a machine without a GPU; only the rest is checked. */
async function smoke(noGpu = null) {
  if (smokeStarted) return;
  smokeStarted = true;
  clearTimeout(readyTimer);
  const consoleErrors = [];
  win.webContents.on('console-message', e => {
    if (e.level === 'error') consoleErrors.push(String(e.message).slice(0, 300));
  });
  const waitFor = (test, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('tiempo de espera agotado')); }, ms);
    const l = msg => { if (test(msg)) { clearTimeout(t); listeners.delete(l); resolve(msg); } };
    listeners.add(l);
  });
  let report;
  try {
    report = noGpu ? await runSmokeNoGpu({ window: win, engineError: noGpu })
      : await runSmoke({ window: win, dir: files.smokeDir, waitFor, consoleErrors });
  } catch (e) {
    report = { ok: false, error: e.stack || String(e) };
  }
  console.log('SMOKE REPORT ' + JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu', label: 'ImageTo3D', submenu: [
      { role: 'about', label: 'Acerca de ImageTo3D' }, { type: 'separator' },
      { role: 'hide', label: 'Ocultar ImageTo3D' }, { role: 'hideOthers', label: 'Ocultar otros' }, { role: 'unhide', label: 'Mostrar todo' },
      { type: 'separator' }, { role: 'quit', label: 'Salir de ImageTo3D' },
    ] }] : []),
    // No undo / redo here: the engine handles Cmd+Z / Cmd+Shift+Z itself (its own history).
    { label: 'Edición', submenu: [
      { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' },
    ] },
    { label: 'Visualización', submenu: [
      { role: 'togglefullscreen', label: 'Pantalla completa' },
      ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'toggleDevTools' }]),
    ] },
    { role: 'windowMenu', label: 'Ventana' },
    { role: 'help', label: 'Ayuda', submenu: [
      { label: 'ImageTo3D en GitHub', click: () => shell.openExternal('https://github.com/joseramos1999/ImageTo3D') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// A project double-clicked in Finder (may arrive before the app is ready).
app.on('open-file', (e, file) => { e.preventDefault(); openProject(file); });

app.whenReady().then(() => {
  protocol.handle('app', req => {
    const u = new URL(req.url);
    if (u.host !== HOST) return new Response('Not found', { status: 404 });
    const file = path.normalize(path.join(ROOT, decodeURIComponent(u.pathname)));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // The engine asks for nothing (it reads files the user drops or picks): deny every permission.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  app.setAboutPanelOptions({ applicationName: 'ImageTo3D', applicationVersion: app.getVersion(), copyright: 'PNG a 3D animado' });
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
