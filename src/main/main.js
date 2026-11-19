'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, session, shell, protocol, net, utilityProcess, clipboard } = require('electron');

const store = require('../core/store');
const { importClip, setReference, loadRunDetail } = require('../core/crash');
const { reportMd } = require('../core/export');
const { MOCK } = require('../core/measure');
const media = require('../core/media');

// The SDK's main-process glue backs the live camera screens (record, wind
// tunnel). Crash tests run in a separate utility process because the native
// SDK state is process-global.
const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

const CONSENT_FILE = () => path.join(store.DATA, 'consent.json');
const CONSENT_VERSION = 1;

protocol.registerSchemesAsPrivileged([{ scheme: 'lab', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let win = null;
let worker = null;
const recordings = new Map();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0e1014',
    title: 'TrustFall',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'dist', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  bindSmartSpectraIpc(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), process.env.TRUSTFALL_SNAP ? { query: { snap: process.env.TRUSTFALL_SNAP } } : undefined);
  if (process.env.TRUSTFALL_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  store.ensure();

  // Serve thumbnails and clips from the data folder only.
  protocol.handle('lab', (req) => {
    // lab://clips/<id>/thumb.jpg parses with "clips" as the host.
    const u = new URL(req.url);
    const rel = decodeURIComponent(`${u.host}${u.pathname}`).replace(/^\/+/, '');
    const file = path.resolve(store.DATA, rel);
    if (!file.startsWith(store.DATA + path.sep)) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Camera only (no microphone), and only for our own bundled page.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const types = (details && details.mediaTypes) || [];
    callback(permission === 'media' && types.length === 1 && types[0] === 'video' && url.startsWith('file://'));
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (worker) worker.kill();
  app.quit();
});

// ---------------------------------------------------------------- IPC

ipcMain.handle('lab:config', () => {
  const consent = store.readJson(CONSENT_FILE());
  let sdkVersion = null;
  try { sdkVersion = require('@smartspectra/node-sdk/package.json').version; } catch { /* ignore */ }
  return {
    mock: MOCK,
    hasKey: !!store.apiKey(),
    // The renderer-side SDK takes the key in its constructor and forwards it
    // to the main-process SDK over the preload bridge. It never leaves the machine
    // except to authenticate with Presage.
    apiKey: store.apiKey() || null,
    dataDir: store.DATA,
    sdkVersion,
    ffmpeg: media.hasFfmpeg(),
    consented: !!consent && consent.version === CONSENT_VERSION,
    platform: process.platform,
  };
});

ipcMain.handle('lab:consent', (_e, accepted) => {
  if (accepted) store.writeJson(CONSENT_FILE(), { version: CONSENT_VERSION, at: new Date().toISOString() });
  else fs.rmSync(CONSENT_FILE(), { force: true });
  return true;
});

ipcMain.handle('lab:list', () => ({ clips: store.listClips(), runs: store.listRuns() }));

// Recording arrives in one-second chunks so a long take never sits in one
// giant IPC message.
ipcMain.handle('lab:rec-begin', (_e, { mimeType }) => {
  store.ensure();
  const id = `rec-${Date.now()}`;
  const ext = /mp4/.test(mimeType) ? 'mp4' : 'webm';
  const file = path.join(store.dirs.tmp, `${id}.${ext}`);
  recordings.set(id, fs.openSync(file, 'w'));
  recordings.set(`${id}:file`, file);
  return id;
});

ipcMain.handle('lab:rec-chunk', (_e, id, chunk) => {
  const fd = recordings.get(id);
  if (fd == null) throw new Error('Unknown recording');
  fs.writeSync(fd, Buffer.from(chunk));
  return true;
});

ipcMain.handle('lab:rec-finish', async (_e, id, meta) => {
  const fd = recordings.get(id);
  const file = recordings.get(`${id}:file`);
  recordings.delete(id);
  recordings.delete(`${id}:file`);
  if (fd != null) fs.closeSync(fd);
  if (!meta) { fs.rmSync(file, { force: true }); return null; }
  try {
    const clip = await importClip(file, {
      name: meta.name, live: meta.live, reference: meta.reference, source: 'recording', maxSeconds: meta.seconds || 75,
      onProgress: (f) => send('lab:event', { type: 'import', progress: f }),
    });
    return clip;
  } finally {
    fs.rmSync(file, { force: true });
  }
});

ipcMain.handle('lab:set-reference', (_e, clipId, reference) => setReference(clipId, reference));

ipcMain.handle('lab:delete-clip', (_e, clipId) => {
  fs.rmSync(path.join(store.dirs.clips, clipId), { recursive: true, force: true });
  return true;
});

ipcMain.handle('lab:run', (_e, { clipId, suite }) => {
  if (worker) throw new Error('A crash test is already running');
  worker = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], { env: process.env, serviceName: 'trustfall-crash-test' });
  worker.on('message', (msg) => send('lab:event', msg));
  worker.on('exit', (code) => {
    if (code !== 0) send('lab:event', { type: 'run-error', message: `Crash-test process exited (${code})` });
    worker = null;
  });
  worker.postMessage({ cmd: 'run', clipId, suite });
  return true;
});

ipcMain.handle('lab:cancel', () => {
  if (worker) worker.postMessage({ cmd: 'cancel' });
  return true;
});

ipcMain.handle('lab:run-detail', (_e, runId) => loadRunDetail(runId));

ipcMain.handle('lab:report-md', (_e, runId) => {
  const s = store.readJson(path.join(store.dirs.runs, runId, 'summary.json'));
  const md = s ? reportMd(s) : '';
  clipboard.writeText(md);
  return md;
});

ipcMain.handle('lab:reveal', (_e, runId) => {
  const target = runId ? path.join(store.dirs.runs, runId, 'report.md') : store.DATA;
  if (fs.existsSync(target)) shell.showItemInFolder(target); else shell.openPath(store.DATA);
  return true;
});

ipcMain.handle('lab:delete-all', () => {
  if (worker) worker.kill();
  store.deleteAll();
  return true;
});

ipcMain.handle('lab:snap', async (_e, name) => {
  // Development helper: save a PNG of the app window (not the screen).
  const img = await win.webContents.capturePage();
  const out = path.join(store.ROOT, 'docs', 'screens', `${name}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  return out;
});
