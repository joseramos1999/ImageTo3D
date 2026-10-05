// New-version notice. The desktop host checks GitHub Releases (UpdateService.cs) and
// posts "update-available"; from here the user can update now (the host downloads,
// verifies and runs the installer, which reopens the app), later, or skip that version.
import { host } from './host.js';

const $ = sel => document.querySelector(sel);
const SKIP_KEY = 'imageto3d.skipVersion';
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

/** Release notes are Markdown from GitHub: shown as plain text lines, never as HTML. */
function notesNodes(md) {
  return String(md || '').split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l && !/^\*\*Full Changelog/.test(l))
    .slice(0, 40)
    .map(l => {
      const heading = /^#{1,6}\s+/.test(l);
      const bullet = /^\s*[-*]\s+/.test(l);
      const text = l.replace(/^#{1,6}\s+/, '').replace(/^\s*[-*]\s+/, '').replace(/\*\*|__|`/g, '');
      return el('p', heading ? 'up-h' : bullet ? 'up-li' : 'up-p', bullet ? '• ' + text : text);
    });
}

export function initUpdates({ toast, beforeInstall, isBusy }) {
  const btn = $('#btn-version');
  if (!host.isDesktop) { btn.hidden = true; return; }
  let current = '', manual = false;

  host.on('host-info', msg => {
    current = msg.version;
    btn.textContent = 'v' + msg.version;
    btn.hidden = false;
  });
  btn.onclick = () => {
    manual = true;
    btn.disabled = true;
    btn.textContent = 'Buscando…';
    host.post({ type: 'update-check' });
  };
  const resetBtn = () => { btn.disabled = false; btn.textContent = current ? 'v' + current : 'Versión'; };

  host.on('update-none', msg => {
    resetBtn();
    if (manual) toast(`Tienes la última versión (${msg.current}).`);
    manual = false;
  });
  host.on('update-error', msg => {
    resetBtn();
    manual = false;
    setPanelBusy(false);
    toast(msg.message, 'error');
  });
  host.on('update-available', msg => {
    resetBtn();
    let skipped = null;
    try { skipped = localStorage.getItem(SKIP_KEY); } catch { /* no storage */ }
    if (!manual && skipped === msg.version) return;   // the user asked not to hear about this one
    manual = false;
    btn.classList.add('has-update');
    btn.title = `Versión ${msg.version} disponible`;
    showPanel(msg);
  });
  host.on('update-progress', msg => {
    const pct = Math.round(msg.p * 100);
    $('#up-status').textContent = `Descargando… ${pct} %`;
    $('#up-bar').style.width = pct + '%';
  });
  host.on('update-installing', msg => {
    $('#up-status').textContent = `Instalando la versión ${msg.version}. ImageTo3D se cerrará y volverá a abrirse en unos segundos.`;
    $('#up-bar').style.width = '100%';
  });

  function setPanelBusy(busy) {
    const panel = $('#update-panel');
    if (!panel) return;
    panel.classList.toggle('busy', busy);
    panel.querySelectorAll('button').forEach(b => { b.disabled = busy; });
  }

  function showPanel(msg) {
    $('#update-panel')?.remove();
    const panel = el('div', 'update-panel');
    panel.id = 'update-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Nueva versión disponible');

    const title = el('div', 'up-title', `Nueva versión ${msg.version}`);
    // A release without a published SHA-256 cannot be checked, so it is not installed from
    // here (the host refuses it too): the button opens its page on GitHub instead.
    const verified = msg.verified !== false;
    const sub = el('div', 'up-sub', verified
      ? `Tienes la ${msg.current}. La actualización tarda menos de un minuto y conserva tus proyectos.`
      : `Tienes la ${msg.current}. Esta versión no publica su huella SHA-256, así que no se puede comprobar ni instalar automáticamente: descárgala desde su página de GitHub.`);
    const notes = el('div', 'up-notes');
    notes.append(...notesNodes(msg.notes));
    notes.hidden = true;
    const toggle = el('button', 'up-link', 'Ver novedades');
    toggle.onclick = () => { notes.hidden = !notes.hidden; toggle.textContent = notes.hidden ? 'Ver novedades' : 'Ocultar novedades'; };

    const progress = el('div', 'bar up-progress');
    const fill = el('div');
    fill.id = 'up-bar';
    progress.append(fill);
    const status = el('div', 'up-status');
    status.id = 'up-status';
    status.setAttribute('aria-live', 'polite');

    const update = el('button', 'btn primary small', verified ? 'Actualizar ahora' : 'Abrir la página de descarga');
    const later = el('button', 'btn small', 'Más tarde');
    const skip = el('button', 'up-link', 'Omitir esta versión');
    update.onclick = async () => {
      if (!verified) { host.post({ type: 'open-release' }); panel.remove(); return; }
      if (isBusy()) { toast('Espera a que termine la exportación para actualizar.', 'error'); return; }
      setPanelBusy(true);
      status.textContent = 'Guardando tu trabajo…';
      try { await beforeInstall(); } catch { /* autosave is best effort */ }
      status.textContent = 'Descargando… 0 %';
      host.post({ type: 'update-install' });
    };
    later.onclick = () => panel.remove();
    skip.onclick = () => { try { localStorage.setItem(SKIP_KEY, msg.version); } catch { /* ignore */ } panel.remove(); };

    const actions = el('div', 'up-actions');
    actions.append(update, later);
    const links = el('div', 'up-links');
    links.append(toggle, skip);
    panel.append(title, sub, links, notes, progress, status, actions);
    document.body.append(panel);
  }
}
