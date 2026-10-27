// Files for the engine, as the Windows host does it (MainWindow.xaml.cs):
//   - streamed exports: a native "Save as" first, then the chunks written at their offset
//     ("file-open", "file-write-bin", "file-close", "file-abort");
//   - batch export: a folder picked once, then files written into it without dialogs — only
//     into a folder the user picked in this session, under a plain file name, never overwriting;
//   - plain downloads (PNG, GLB, STL, projects): a save dialog with the right folder and filter.
const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const FILTERS = {
  mp4: ['Vídeo MP4', ['mp4']], webm: ['Vídeo WebM', ['webm']], mov: ['Vídeo QuickTime', ['mov']], avi: ['Vídeo AVI', ['avi']],
  zip: ['Secuencia PNG (ZIP)', ['zip']], png: ['Imagen PNG', ['png']], glb: ['Modelo GLB', ['glb']],
  stl: ['Modelo STL', ['stl']], i3d: ['Proyecto ImageTo3D', ['i3d']], i3dlook: ['Look de ImageTo3D', ['i3dlook']],
};
const filtersFor = ext => (FILTERS[ext] ? [{ name: FILTERS[ext][0], extensions: FILTERS[ext][1] }] : []);
const folderFor = ext => app.getPath(['mp4', 'webm', 'mov', 'avi', 'zip'].includes(ext) ? 'videos' : ext === 'png' ? 'pictures' : 'documents');
const extOf = name => path.extname(name).slice(1).toLowerCase();

class Files {
  constructor({ window, post, smokeDir = null }) {
    this.window = window;
    this.post = post;
    this.smokeDir = smokeDir;          // smoke test: every save goes here, no dialogs
    this.sinks = new Map();            // id → { fh, path }
    this.folders = new Set();          // folders picked for batches in this session
  }

  async handle(msg) {
    const { type, id } = msg;
    try {
      switch (type) {
        case 'file-open': return await this.open(id, msg.name || 'export', msg.dir);
        case 'file-write-bin': {
          const sink = this.sinks.get(id);
          if (!sink) throw new Error('archivo no abierto');
          const data = msg.data;
          const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          await sink.fh.write(buf, 0, buf.length, msg.pos);
          this.post({ type: 'file-ack', id });
          return;
        }
        case 'file-close': {
          const sink = this.sinks.get(id);
          if (sink) {
            this.sinks.delete(id);
            await sink.fh.close();
            this.post({ type: 'file-closed', id });
            // A batch announces its files itself, not one notice per file.
            if (!msg.quiet) this.post({ type: 'saved', path: sink.path });
          }
          return;
        }
        case 'file-abort': await this.discard(id); this.post({ type: 'file-closed', id }); return;
        case 'pick-folder': return await this.pickFolder(id);
      }
    } catch (e) {
      // Disk full, file locked...: the engine stops the export and tells the user.
      await this.discard(id).catch(() => {});
      this.post({ type: 'file-error', id, message: e.message });
    }
  }

  async open(id, name, dir) {
    let file;
    if (dir != null) file = this.batchPath(dir, name);
    else if (this.smokeDir) file = path.join(this.smokeDir, path.basename(name));
    else {
      const ext = extOf(name);
      const r = await dialog.showSaveDialog(this.window, { defaultPath: path.join(folderFor(ext), path.basename(name)), filters: filtersFor(ext) });
      if (r.canceled || !r.filePath) { this.post({ type: 'file-cancelled', id }); return; }
      file = r.filePath;
    }
    const fh = await fs.promises.open(file, 'w');
    this.sinks.set(id, { fh, path: file });
    this.post({ type: 'file-opened', id, path: file });
  }

  /** Inside a folder picked for a batch, under a plain name, never overwriting (adds " (2)"…). */
  batchPath(dir, name) {
    const folder = path.resolve(dir);
    if (!this.folders.has(folder)) throw new Error('Esa carpeta no se ha elegido para el lote.');
    if (!name || name !== path.basename(name) || /[\\/:*?"<>|\0]/.test(name) || !name.replace(/\./g, '').trim()) {
      throw new Error('Nombre de archivo no válido.');
    }
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    let file = path.join(folder, name);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(folder, `${stem} (${n})${ext}`);
    return file;
  }

  async pickFolder(id) {
    let folder = this.smokeDir;
    if (!folder) {
      const r = await dialog.showOpenDialog(this.window, {
        title: 'Carpeta donde guardar los archivos del lote',
        defaultPath: app.getPath('videos'),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) { this.post({ type: 'folder-cancelled', id }); return; }
      folder = r.filePaths[0];
    }
    folder = path.resolve(folder);
    this.folders.add(folder);
    this.post({ type: 'folder-picked', id, path: folder });
  }

  async discard(id) {
    const sink = this.sinks.get(id);
    if (!sink) return;
    this.sinks.delete(id);
    await sink.fh.close().catch(() => {});
    await fs.promises.unlink(sink.path).catch(() => {});
  }

  /** A window closed mid-export leaves no half-written file behind. */
  discardAll() {
    for (const [id, sink] of this.sinks) {
      this.sinks.delete(id);
      try { fs.closeSync(sink.fh.fd); } catch { /* already closed */ }
      try { fs.unlinkSync(sink.path); } catch { /* best effort */ }
    }
  }

  /** Every export that ends in a blob download (PNG, GLB, STL, project): a native save dialog. */
  attachDownloads(session) {
    session.on('will-download', (_event, item) => {
      const name = item.getFilename(), ext = extOf(name);
      if (this.smokeDir) item.setSavePath(path.join(this.smokeDir, name));
      else item.setSaveDialogOptions({ defaultPath: path.join(folderFor(ext), name), filters: filtersFor(ext) });
      item.once('done', (_e, state) => {
        if (state === 'completed') this.post({ type: 'saved', path: item.getSavePath() });
        else if (state === 'cancelled') this.post({ type: 'save-cancelled' });
        else this.post({ type: 'save-failed', reason: state });
      });
    });
  }
}

module.exports = { Files };
