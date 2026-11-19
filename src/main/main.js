'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, execFileSync } = require('child_process');
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

// Demo capture (development only). TRUSTFALL_DEMO names a script that drives
// the UI. The window renders offscreen and its frames are encoded to the
// TRUSTFALL_DEMO_OUT mp4, with the script's timing marks in a .json beside
// it; then the app quits. Only the app's own pixels are captured.
const DEMO = process.env.TRUSTFALL_DEMO;
const DEMO_ZOOM = Number(process.env.TRUSTFALL_DEMO_ZOOM || 1.5);
// Chromium remembers zoom per page in the profile, so demo runs get a fresh
// throwaway profile and never change how the app opens normally.
if (DEMO) {
  const profile = path.join(require('os').tmpdir(), 'trustfall-demo-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  app.setPath('userData', profile);
}
// TRUSTFALL_DEMO_CAMERA plays a .y4m file as the camera, so a wind-tunnel
// take can be repeated without anyone sitting in front of the laptop.
if (DEMO && process.env.TRUSTFALL_DEMO_CAMERA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-video-capture', process.env.TRUSTFALL_DEMO_CAMERA);
}

let win = null;
let worker = null;
const recordings = new Map();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    // The demo renders offscreen with the page zoomed (1.5x by default, so
    // 2400x1500): the same layout as a 1600x1000 window, sharp enough for a
    // 1080p edit.
    width: DEMO ? Math.round(1600 * DEMO_ZOOM) : 1380,
    height: DEMO ? Math.round(1000 * DEMO_ZOOM) : 900,
    useContentSize: !!DEMO,
    show: !DEMO,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#ffffff',
    title: 'TrustFall',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'dist', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !DEMO,
      offscreen: !!DEMO,
      zoomFactor: DEMO ? DEMO_ZOOM : 1,
    },
  });
  bindSmartSpectraIpc(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), process.env.TRUSTFALL_SNAP ? { query: { snap: process.env.TRUSTFALL_SNAP } } : undefined);
  if (process.env.TRUSTFALL_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  if (DEMO) {
    win.webContents.setFrameRate(Number(process.env.TRUSTFALL_DEMO_FPS || 30));
    win.webContents.once('did-finish-load', () => runDemo().catch((e) => { console.error(e); app.exit(1); }));
  }
}

async function runDemo() {
  const out = process.env.TRUSTFALL_DEMO_OUT;
  const fps = Number(process.env.TRUSTFALL_DEMO_FPS || 30);
  let latest = null;
  win.webContents.on('paint', (_e, _dirty, img) => { latest = img; });
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 1500));
  const { width, height } = latest.getSize();
  const hw = !!process.env.TRUSTFALL_DEMO_HW;
  // Frames reach ffmpeg through a named pipe: its reads block until a frame
  // arrives, and Node writes from its thread pool, off the busy main thread.
  // (On a child's stdin ffmpeg treats a momentarily empty pipe as the end.)
  const fifo = out.replace(/\.mp4$/, '.fifo');
  fs.rmSync(fifo, { force: true });
  execFileSync('mkfifo', [fifo]);
  const ff = spawn(media.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    // In hardware mode the colour conversion and encoding both run on the
    // GPU, leaving the CPU to the SDK during long or live takes.
    ...(hw ? ['-init_hw_device', 'videotoolbox=vt', '-filter_hw_device', 'vt'] : []),
    // Each frame is stamped with the time it arrives and ffmpeg repeats
    // frames to fill gaps, so video time equals take time without repeats
    // crossing the pipe.
    '-use_wallclock_as_timestamps', '1', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-i', fifo,
    '-fps_mode', 'cfr', '-r', String(fps),
    ...(hw ? ['-vf', 'hwupload', '-c:v', 'h264_videotoolbox', '-b:v', '40M']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p']),
    out], { stdio: ['ignore', 'ignore', fs.openSync(out.replace(/\.mp4$/, '.ffmpeg.log'), 'w')] });
  const sink = fs.createWriteStream(fifo);
  let failed = null;
  sink.on('error', (e) => { failed = e.message; });
  const done = new Promise((r) => ff.on('close', r));
  const frameBytes = width * height * 4;
  let t0 = 0; let n = 0; let slot = -1;
  // At most one frame per 1/fps slot, and only while ffmpeg has taken the
  // previous one, so the queue never grows. `frames` below the take length
  // times fps means some slots were filled by repeats.
  const tick = () => {
    if (failed || sink.writableLength > frameBytes) return;
    const now = Date.now();
    if (!t0) t0 = now;
    const k = Math.floor(((now - t0) * fps) / 1000);
    if (k <= slot) return;
    slot = k;
    sink.write(latest.toBitmap());
    n += 1;
  };
  const timer = setInterval(tick, 1000 / fps / 3);
  const marks = await win.webContents.executeJavaScript(fs.readFileSync(DEMO, 'utf8'), true);
  await new Promise((r) => setTimeout(r, 600));
  clearInterval(timer);
  const slots = Math.floor(((Date.now() - t0) * fps) / 1000);
  sink.end();
  await done;
  fs.rmSync(fifo, { force: true });
  fs.writeFileSync(out.replace(/\.mp4$/, '.json'), JSON.stringify({ fps, frames: n, slots, failed, size: [width, height],
    marks: marks.map((m) => ({ ...m, s: +((m.t - t0) / 1000).toFixed(3) })) }, null, 1));
  app.quit();
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
    // A demo take can show the first-launch consent screen; nothing is written.
    consented: !!consent && consent.version === CONSENT_VERSION && !(DEMO && process.env.TRUSTFALL_DEMO_FIRST_RUN),
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
