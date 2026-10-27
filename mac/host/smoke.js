// Smoke test, run with --smoke-test (CI on a real Mac, or by hand): drives the engine like a
// user would and checks every result on disk. Prints a JSON report and exits 0 if all passed.
const fs = require('fs');
const path = require('path');

const MAGIC = {
  mp4: buf => buf.subarray(4, 8).toString('latin1') === 'ftyp',
  webm: buf => buf.readUInt32BE(0) === 0x1a45dfa3,
  mov: buf => buf.subarray(4, 12).toString('latin1') === 'ftypqt  ' && buf.includes(Buffer.from('moov')),
  png: buf => buf.subarray(1, 4).toString('latin1') === 'PNG',
  stl: buf => buf.length > 84 && buf.readUInt32LE(80) * 50 + 84 === buf.length,
};

async function runSmoke({ window, dir, waitFor, consoleErrors }) {
  const wc = window.webContents;
  const exec = code => wc.executeJavaScript(`(async () => { ${code} })()`, true);
  const report = { platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome, checks: [] };
  const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); };

  // Environment the engine depends on.
  const env = await exec(`
    // The demo logo is traced after "ready": give it time.
    for (let i = 0; i < 120 && !(window.__app.logo?.children.length); i++) await new Promise(r => setTimeout(r, 250));
    const gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const out = { webgl2: !!gl, renderer: gl ? gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null, videoEncoder: typeof VideoEncoder !== 'undefined' };
    for (const codec of ['avc1.640028', 'vp09.00.10.08']) {
      try { out[codec] = (await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 4e6, framerate: 30 })).supported; }
      catch (e) { out[codec] = 'error: ' + e.message; }
    }
    out.hud = document.querySelector('#hud').textContent;
    out.pieces = window.__app.logo?.children.length || 0;
    return out;`);
  report.env = env;
  check('WebGL 2', env.webgl2, env.renderer);
  check('Logo de ejemplo trazado', env.pieces > 0, env.hud);
  check('Codificador H.264', env['avc1.640028'] === true, String(env['avc1.640028']));

  // An SVG through the vector importer.
  const svg = await exec(`
    const text = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><circle cx="60" cy="60" r="50" fill="#1e5bd8"/><path d="M60 25 L72 52 L101 52 L77 70 L86 98 L60 81 L34 98 L43 70 L19 52 L48 52 Z" fill="#fff"/><rect x="120" y="20" width="70" height="80" rx="12" fill="#f5c542"/></svg>';
    const dt = new DataTransfer(); dt.items.add(new File([text], 'prueba.svg', { type: 'image/svg+xml' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 60 && !/prueba/.test(document.querySelector('#hud').textContent); i++) await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 500));
    return { hud: document.querySelector('#hud').textContent, pieces: window.__app.logo.children.length };`);
  check('SVG vectorial', /vectorial/.test(svg.hud) && svg.pieces === 3, svg.hud);
  check('Título de la ventana', window.getTitle() === 'prueba.svg — ImageTo3D', window.getTitle());

  // Exports: each one through the real export button, to the smoke folder, then checked on disk.
  const exportAs = async (format, setup = '') => {
    const saved = waitFor(m => m.type === 'saved' || m.type === 'file-error' || m.type === 'save-failed', 240000);
    await exec(`
      const q = s => document.querySelector(s), st = window.__app.state;
      q('#format [data-v=${format}]').click();
      const z = q('#size'); z.value = 'hd720'; z.dispatchEvent(new Event('change'));
      st.mode = 'single'; st.anim = 'rotate-y'; st.seconds = 2;
      ${setup}
      await new Promise(r => setTimeout(r, 300));
      q('#btn-export').click();`);
    const msg = await saved;
    if (msg.type !== 'saved') return { ok: false, detail: msg.message || msg.reason || msg.type };
    const buf = fs.readFileSync(msg.path);
    const ext = path.extname(msg.path).slice(1);
    return { ok: buf.length > 1000 && (MAGIC[ext] ? MAGIC[ext](buf) : true), detail: `${path.basename(msg.path)} · ${buf.length} bytes` };
  };
  for (const [name, format, setup] of [
    ['Vídeo MP4 (H.264)', 'mp4', ''],
    ['Vídeo WebM con transparencia', 'webm', "document.querySelector('#backgrounds [data-id=transparent]').click();"],
    ['Vídeo MOV (PNG + alfa)', 'mov', "document.querySelector('#backgrounds [data-id=transparent]').click();"],
    ['Vídeo MP4 con desenfoque de movimiento', 'mp4', "document.querySelector('#backgrounds [data-id=vignette]').click(); const mb = document.querySelector('#motion-blur'); mb.value = '180'; mb.dispatchEvent(new Event('change')); document.querySelector('#blur-samples [data-v=\"4\"]').click();"],
    ['Imagen PNG', 'png', "const mb = document.querySelector('#motion-blur'); mb.value = '0'; mb.dispatchEvent(new Event('change'));"],
    ['Modelo STL', 'stl', ''],
  ]) {
    try {
      const r = await exportAs(format, setup);
      check(name, r.ok, r.detail);
    } catch (e) {
      check(name, false, e.message);
    }
  }

  // A batch: a folder picked once, then two files written into it without dialogs.
  try {
    const before = new Set(fs.readdirSync(dir));
    const status = await exec(`
      const q = s => document.querySelector(s), wait = ms => new Promise(r => setTimeout(r, ms));
      q('#format [data-v=png]').click();
      q('#btn-batch').click();
      const svg = c => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="' + c + '"/></svg>';
      const dt = new DataTransfer();
      dt.items.add(new File([svg('#e33')], 'lote-a.svg', { type: 'image/svg+xml' }));
      dt.items.add(new File([svg('#3a3')], 'lote-b.svg', { type: 'image/svg+xml' }));
      q('#bt-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      q('#bt-folder').click();
      for (let i = 0; i < 40 && q('#bt-start').disabled; i++) await wait(250);
      q('#bt-start').click();
      for (let i = 0; i < 480 && !/Terminado|Cancelado/.test(q('#bt-status').textContent); i++) await wait(250);
      const text = q('#bt-status').textContent;
      q('#bt-close').click();
      return text;`);
    const made = fs.readdirSync(dir).filter(f => !before.has(f));
    const pngs = made.filter(f => f.endsWith('.png') && MAGIC.png(fs.readFileSync(path.join(dir, f))));
    check('Exportar en lote', pngs.length === 2, `${status} · ${made.join(', ')}`);
  } catch (e) {
    check('Exportar en lote', false, e.message);
  }

  // The effect shaders compile and draw.
  const fx = await exec(`
    const A = await import('/js/animations.js');
    const { stage } = window.__app, m = stage.motion, ps = window.__app.logo.children;
    for (const id of ['deform-wave', 'outro-dissolve', 'intro-trace', 'intro-portal']) {
      const a = A.getAnimation(id); A.poseAt(a, (a.period || a.duration) * 0.45, m, ps, true); stage.render(0);
    }
    A.resetPose(m, ps);
    return true;`);
  check('Efectos (shaders)', fx && !consoleErrors.some(e => /shader|program|webgl/i.test(e)), consoleErrors.slice(0, 3).join(' | '));

  report.consoleErrors = consoleErrors.slice(0, 10);
  report.ok = report.checks.every(c => c.ok);
  return report;
}

/** On a machine with no GPU (GitHub's Intel Macs) the engine cannot start: check that the app
 *  runs, serves the engine, has its host bridge and the H.264 encoder, and that it is WebGL
 *  that failed — not that it rendered. */
async function runSmokeNoGpu({ window, engineError }) {
  const wc = window.webContents;
  const report = { platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome, noGpu: true, engineError, checks: [] };
  const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); };
  const env = await wc.executeJavaScript(`(async () => {
    const out = { url: location.href, bridge: typeof window.imageto3dHost?.postMessage === 'function', webgl2: !!document.createElement('canvas').getContext('webgl2') };
    out.files = await Promise.all(['/index.html', '/js/app.js', '/js/host.js'].map(async f => { try { return (await fetch(f)).ok; } catch { return false; } }));
    try { out.h264 = (await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1280, height: 720, bitrate: 4e6, framerate: 30 })).supported; }
    catch (e) { out.h264 = 'error: ' + e.message; }
    return out;
  })()`, true);
  report.env = env;
  check('La app arranca y abre el motor', env.url === 'app://imageto3d/index.html', env.url);
  check('Archivos del motor servidos', env.files.every(Boolean), env.files.join(', '));
  check('Puente con el host', env.bridge);
  check('Codificador H.264', env.h264 === true, String(env.h264));
  check('Sin GPU: falla solo WebGL', !env.webgl2 && /WebGL context/i.test(engineError), engineError);
  report.ok = report.checks.every(c => c.ok);
  return report;
}

module.exports = { runSmoke, runSmokeNoGpu };
