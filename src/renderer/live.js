'use strict';

// Thin wrapper over the renderer-side SmartSpectra SDK for the two live
// screens. Collects every pulse/breathing reading (de-duplicated by
// timestamp, since each metrics buffer is cumulative) and emits the latest.
// In mock mode it opens the camera itself and invents readings, clearly
// labelled in the UI.

const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
const SDK = require('@smartspectra/node-sdk/renderer');

const num = (v) => (v && typeof v === 'object' && v.toNumber ? v.toNumber() : Number(v));

function bbox(points) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return Number.isFinite(x0) && x1 - x0 > 20 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

class Live {
  constructor(cfg, { landmarks = false } = {}) {
    this.cfg = cfg;
    this.landmarks = landmarks;
    this.handlers = {};
    this.pulse = new Map();
    this.breathing = new Map();
    this.lastTs = { pulse: -Infinity, breathing: -Infinity };
    this.mock = cfg.mock;
    this.sdk = null;
    this.timer = null;
    this.stream = null;
    this.mockSeverity = () => 0;
  }

  on(ev, cb) { this.handlers[ev] = cb; return this; }
  emit(ev, ...a) { if (this.handlers[ev]) this.handlers[ev](...a); }

  async start(stream = null) {
    if (this.mock) return this.startMock(stream);
    const { SmartSpectraSDK, breathingMetrics, cardioMetrics, MetricType } = SDK;
    const requestedMetrics = [...breathingMetrics, ...cardioMetrics];
    if (this.landmarks) requestedMetrics.push(MetricType.FACE_LANDMARKS);
    this.sdk = new SmartSpectraSDK({ apiKey: this.cfg.apiKey, requestedMetrics, enableTelemetry: false });
    this.sdk.on('streamAvailable', (s) => { this.stream = s; this.emit('stream', s); });
    this.sdk.on('validationStatus', (code, ts, hint) => this.emit('validation', code, hint, num(ts)));
    this.sdk.on('processingStatus', (s) => this.emit('status', s));
    this.sdk.on('error', (code, message, retryable) => this.emit('error', { code, message, retryable }));
    this.sdk.on('frameSentThrough', (sent, ts) => { if (sent) this.emit('frame', num(ts)); });
    this.sdk.on('metrics', (buf) => this.ingest(buf));
    if (stream) { this.stream = stream; this.sdk.useMediaStream(stream); }
    await this.sdk.start();
  }

  ingest(buf) {
    let m;
    try { m = decodeMetrics(buf); } catch { return; }
    const latest = {};
    for (const [key, arr] of [['pulse', m.cardio?.pulseRate], ['breathing', m.breathing?.rate]]) {
      if (!arr?.length) continue;
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        const e = arr[i]; const ts = num(e.timestamp);
        if (ts <= this.lastTs[key]) break;
        this[key].set(ts, { ts, value: e.value, confidence: e.confidence, stable: !!e.stable });
      }
      const last = arr[arr.length - 1];
      this.lastTs[key] = Math.max(this.lastTs[key], num(last.timestamp));
      latest[key] = { value: last.value, confidence: last.confidence, stable: !!last.stable, ts: num(last.timestamp) };
    }
    if (this.landmarks) {
      const l = m.face?.landmarks?.at(-1);
      if (l?.value?.length) { const b = bbox(l.value); if (b) this.emit('face', b); }
    }
    if (latest.pulse || latest.breathing) this.emit('reading', latest);
  }

  // Readings since a given SDK timestamp, as seconds from it.
  since(ts0) {
    const pick = (map) => [...map.values()].filter((s) => s.ts >= ts0).sort((a, b) => a.ts - b.ts).map((s) => ({ ...s, t: (s.ts - ts0) / 1e6 }));
    return { pulse: pick(this.pulse), breathing: pick(this.breathing) };
  }

  async startMock(stream) {
    this.stream = stream || await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: false });
    if (!stream) this.emit('stream', this.stream);
    const t0 = performance.now();
    let drift = 0;
    this.timer = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      const ts = Math.round(performance.now() * 1000);
      this.emit('frame', ts);
      const sev = this.mockSeverity();
      drift = 0.85 * drift + (Math.random() - 0.5) * sev * 6;
      const pc = t < 12 ? 0 : Math.max(0, Math.min(99, Math.min(1, (t - 12) / 8) * 86 * (1 - sev * 0.8) + (Math.random() - 0.5) * 8));
      const bc = t < 30 ? 0 : Math.max(0, Math.min(99, Math.min(1, (t - 30) / 6) * 80 * (1 - sev) + (Math.random() - 0.5) * 6));
      const p = { ts, value: 72 + 2 * Math.sin(t / 7) + drift, confidence: pc, stable: pc >= 40 };
      const b = { ts, value: 14 + Math.sin(t / 11), confidence: bc, stable: bc >= 45 };
      this.pulse.set(ts, p);
      if (t >= 30) this.breathing.set(ts, b);
      this.emit('reading', { pulse: p, breathing: t >= 30 ? b : undefined });
      this.emit('validation', t < 1.5 ? 10 : sev > 0.6 ? 5 : 0, t < 1.5 ? 'Camera is adjusting.' : sev > 0.6 ? 'Too dark. Add light.' : 'OK', ts);
    }, 500);
    this.emit('status', 3);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.sdk) {
      try { await this.sdk.stop(); } catch { /* ignore */ }
      try { this.sdk.destroy(); } catch { /* ignore */ }
      this.sdk = null;
    }
    if (this.stream && this.mock) this.stream.getTracks().forEach((t) => t.stop());
  }
}

const VALIDATION_OK = 0;
const VALIDATION_TUNING = 10;

module.exports = { Live, VALIDATION_OK, VALIDATION_TUNING };
