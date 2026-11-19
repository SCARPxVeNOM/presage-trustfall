'use strict';

// Runs one video file through the SmartSpectra SDK and returns every pulse,
// breathing and HRV reading with its confidence and stable flag, plus the
// SDK's validation feedback. Readings arrive as cumulative protobuf buffers,
// so entries are de-duplicated by timestamp.
//
// TRUSTFALL_MOCK=1 swaps the SDK for a synthetic generator so the interface
// can be developed without an API key. Mock results are labelled as such
// everywhere they appear and must never be reported as measurements.

const MOCK = process.env.TRUSTFALL_MOCK === '1';

function num(v) {
  if (v == null) return NaN;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

function faceBoxFromLandmarks(points) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  if (!Number.isFinite(x0) || x1 - x0 < 20) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function medianBox(boxes) {
  if (!boxes.length) return null;
  const med = (k) => boxes.map((b) => b[k]).sort((a, b) => a - b)[Math.floor(boxes.length / 2)];
  return { x: Math.round(med('x')), y: Math.round(med('y')), w: Math.round(med('w')), h: Math.round(med('h')) };
}

async function measureFile(file, opts = {}) {
  if (MOCK) return require('./mock').measureFile(file, opts);

  const sdkPkg = require('@smartspectra/node-sdk');
  const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
  const { SmartSpectraSDK, ProcessingStatus, SmartSpectraLogLevel, breathingMetrics, cardioMetrics, MetricType } = sdkPkg;

  // The SDK drops frames and sends fewer readings when a file plays faster
  // than real time, so pace it at the clip's own frame rate by default.
  const { apiKey, landmarks = false, duration = 60, onProgress, stallMs = 90000, fps = 30 } = opts;
  const interframeDelayMs = opts.interframeDelayMs ?? Number(process.env.TRUSTFALL_FRAME_DELAY_MS ?? Math.round(1000 / fps));
  if (!apiKey) throw Object.assign(new Error('No SmartSpectra API key. Add SMARTSPECTRA_API_KEY to .env'), { code: 'NO_KEY' });

  const requestedMetrics = [...breathingMetrics, ...cardioMetrics];
  if (landmarks) requestedMetrics.push(MetricType.FACE_LANDMARKS);

  const sdk = new SmartSpectraSDK({
    apiKey,
    requestedMetrics,
    enableTelemetry: false,
    logLevel: SmartSpectraLogLevel.kError,
  });

  const pulse = new Map();
  const breathing = new Map();
  const hrv = new Map();
  const validation = [];
  const errors = [];
  const boxes = [];
  let frames = 0;
  let firstFrameTs = null;
  let lastFrameTs = null;
  let lastActivity = Date.now();
  let lastCode = null;

  sdk.on('metrics', (buf) => {
    lastActivity = Date.now();
    let m;
    try { m = decodeMetrics(buf); } catch { return; }
    for (const p of m.cardio?.pulseRate ?? []) {
      pulse.set(num(p.timestamp), { ts: num(p.timestamp), value: p.value, confidence: p.confidence, stable: !!p.stable });
    }
    for (const b of m.breathing?.rate ?? []) {
      breathing.set(num(b.timestamp), { ts: num(b.timestamp), value: b.value, confidence: b.confidence, stable: !!b.stable });
    }
    for (const h of m.cardio?.hrv ?? []) {
      hrv.set(num(h.timestamp), { ts: num(h.timestamp), value: h.rmssd, sdnn: h.sdnn, meanNn: h.meanNn, confidence: h.confidence, stable: !!h.stable });
    }
    if (landmarks && boxes.length < 400) {
      for (const l of m.face?.landmarks ?? []) {
        const b = faceBoxFromLandmarks(l.value ?? []);
        if (b) boxes.push(b);
      }
    }
  });

  sdk.on('validationStatus', (code, ts, hint) => {
    lastActivity = Date.now();
    if (code !== lastCode) validation.push({ ts: num(ts), code, hint });
    lastCode = code;
  });

  sdk.on('frameSentThrough', (sent, ts) => {
    lastActivity = Date.now();
    if (!sent) return;
    frames += 1;
    const t = num(ts);
    if (firstFrameTs == null) firstFrameTs = t;
    lastFrameTs = t;
    if (onProgress && frames % 15 === 0) onProgress(Math.min(1, (t - firstFrameTs) / 1e6 / duration));
  });

  sdk.on('error', (code, message, retryable) => {
    lastActivity = Date.now();
    errors.push({ code, message, retryable });
  });

  const started = Date.now();
  const settled = new Promise((resolve) => {
    let running = false;
    sdk.on('processingStatus', (status) => {
      lastActivity = Date.now();
      if (status === ProcessingStatus.kRunning) running = true;
      if (status === ProcessingStatus.kError || (running && status === ProcessingStatus.kIdle)) resolve(status);
    });
  });
  const stall = new Promise((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() - lastActivity > stallMs) { clearInterval(timer); resolve('stalled'); }
    }, 1000);
    settled.then(() => clearInterval(timer));
  });

  sdk.useFile(file, { interframeDelayMs });
  try {
    sdk.start();
  } catch (e) {
    await sdk.destroy().catch(() => {});
    throw e;
  }
  const outcome = await Promise.race([settled, stall]);
  if (outcome === 'stalled') {
    errors.push({ code: -1, message: `No progress for ${stallMs / 1000}s; stopped.`, retryable: true });
    await sdk.stopAsync().catch(() => {});
  }
  await sdk.destroy();

  // Express every timestamp as seconds into the clip. The SDK reports
  // microsecond timestamps; anchor them on the first frame it accepted.
  const all = [...pulse.values(), ...breathing.values(), ...hrv.values(), ...validation];
  const t0 = firstFrameTs ?? Math.min(...all.map((s) => s.ts));
  const rel = (arr) => [...arr].sort((a, b) => a.ts - b.ts).map((s) => ({ ...s, t: (s.ts - t0) / 1e6 }));

  return {
    mock: false,
    samples: { pulse: rel(pulse.values()), breathing: rel(breathing.values()), hrv: rel(hrv.values()) },
    validation: rel(validation),
    errors,
    frames,
    mediaSeconds: firstFrameTs != null ? (lastFrameTs - firstFrameTs) / 1e6 : null,
    wallMs: Date.now() - started,
    face: medianBox(boxes),
    sdkVersion: SmartSpectraSDK.version,
  };
}

module.exports = { measureFile, MOCK };
