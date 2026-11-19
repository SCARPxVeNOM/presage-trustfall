'use strict';

// Live wind tunnel: the camera feed is redrawn onto a canvas with the same
// kinds of damage as the crash test (less light, grain, blur, sway, distance,
// covering, flicker, freeze), and the canvas stream is what the SDK measures.
// Move a slider and watch whether confidence reacts.

const { $, fmt, toast } = require('./ui');
const { Live } = require('./live');
const { meterHtml } = require('./record');

const W = 1280; const H = 720;
// Two stable readings that each keep the ±3 bpm promise differ by at most 6.
const GAP = 6;
const CONTROLS = [
  { id: 'light', label: 'Light', min: 0, max: 4, step: 0.5, fmt: (v) => (v ? `−${v} stops` : 'normal') },
  { id: 'grain', label: 'Grain', min: 0, max: 4, step: 1, fmt: (v) => (v ? `level ${v}` : 'off') },
  { id: 'blur', label: 'Blur', min: 0, max: 14, step: 1, fmt: (v) => (v ? `${v}px` : 'sharp') },
  { id: 'sway', label: 'Sway', min: 0, max: 32, step: 2, fmt: (v) => (v ? `±${v}px` : 'still') },
  { id: 'distance', label: 'Distance', min: 1, max: 4, step: 0.5, fmt: (v) => (v > 1 ? `${v}× farther` : 'as is') },
  { id: 'flicker', label: 'Flicker', min: 0, max: 4, step: 1, fmt: (v) => (v ? `${v}% at 1.5 Hz` : 'off') },
];

function render(view, ctx) {
  const st = {
    on: false, live: null, cam: null, video: null, canvas: null, raf: null, frozen: false, cover: 'none',
    v: { light: 0, grain: 0, blur: 0, sway: 0, distance: 1, flicker: 0 },
    face: null, latest: null, breathing: null, hist: [], events: [], baseline: null, t0: 0, noise: [], lastCode: null, hint: '',
  };
  ctx.cleanup = () => stop(st);

  view.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Wind tunnel · live</div><h1>Push the picture. Watch the confidence.</h1>
      <p class="muted" style="margin-top:8px;max-width:72ch">The SDK measures the damaged picture on the left, not your raw camera. Wait for a stable reading, lock it as your baseline, then add one kind of damage at a time. If the reading drifts outside the band while confidence stays high, you found a blind spot.</p></div></div>
    <div class="tunnel">
      <div class="stack">
        <div class="stage"><canvas id="cv" width="${W}" height="${H}"></canvas>
          <div class="tag">${ctx.cfg.mock ? 'MOCK readings' : 'What the SDK sees'}</div>
          <div class="hud"><div class="say" id="say">Camera off</div></div></div>
        <div class="card"><div class="row small"><b style="font-weight:600">Last 60 seconds</b><span class="spacer"></span>
          <span class="legend"><span><i style="background:#111"></i>Pulse</span><span><i style="background:#2f80ed"></i>Confidence</span><span><i style="background:#e6e6e2;border-radius:3px"></i>Baseline ±6 bpm</span><span><i style="background:#f0532d"></i>Stable but off</span></span></div>
          <canvas id="hist" width="1600" height="300" style="width:100%;height:150px;margin-top:6px"></canvas></div>
      </div>
      <div class="stack">
        <div class="card"><div id="meter">${meterHtml(null)}</div>
          <div class="row" style="margin-top:14px"><span class="drift" id="drift">No baseline yet</span><span class="spacer"></span>
            <button class="btn" id="lock" disabled>Lock baseline</button></div></div>
        <div class="card">
          ${CONTROLS.map((c) => `<div class="ctrl"><label for="c-${c.id}">${c.label}</label><input type="range" id="c-${c.id}" min="${c.min}" max="${c.max}" step="${c.step}" value="${st.v[c.id]}"><output id="o-${c.id}">${c.fmt(st.v[c.id])}</output></div>`).join('')}
          <div class="ctrl"><label>Cover</label><select id="c-cover"><option value="none">Nothing</option><option value="forehead">Forehead</option><option value="mask">Lower face</option><option value="half">Half face</option></select><span></span></div>
          <div class="ctrl"><label>Freeze</label><label class="row small"><input type="checkbox" id="c-freeze"> Still photo</label><span></span></div>
          <div class="row" style="margin-top:12px"><button class="btn primary" id="start">Turn on camera</button><button class="btn" id="reset">Reset damage</button></div>
        </div>
      </div>
    </div></div>`;

  st.canvas = $('#cv', view);
  for (const c of CONTROLS) {
    $(`#c-${c.id}`, view).oninput = (e) => {
      st.v[c.id] = Number(e.target.value);
      $(`#o-${c.id}`, view).textContent = c.fmt(st.v[c.id]);
      mark(st, `${c.label} ${c.fmt(st.v[c.id])}`, c.id);
    };
  }
  $('#c-cover', view).onchange = (e) => { st.cover = e.target.value; mark(st, `Cover ${st.cover}`); };
  $('#c-freeze', view).onchange = (e) => { st.frozen = e.target.checked; mark(st, st.frozen ? 'Frozen' : 'Unfrozen'); };
  $('#reset', view).onclick = () => {
    st.v = { light: 0, grain: 0, blur: 0, sway: 0, distance: 1, flicker: 0 }; st.cover = 'none'; st.frozen = false;
    for (const c of CONTROLS) { $(`#c-${c.id}`, view).value = st.v[c.id]; $(`#o-${c.id}`, view).textContent = c.fmt(st.v[c.id]); }
    $('#c-cover', view).value = 'none'; $('#c-freeze', view).checked = false;
    mark(st, 'Reset');
  };
  $('#start', view).onclick = () => (st.on ? stop(st, view) : start(st, view, ctx));
  $('#lock', view).onclick = () => {
    if (st.latest?.stable) { st.baseline = st.latest.value; mark(st, `Baseline ${fmt(st.baseline)} bpm`); updateDrift(st, view); }
  };
  makeNoise(st);
}

function mark(st, label, key = label) {
  if (!st.on) return;
  const t = (performance.now() - st.t0) / 1000;
  // Dragging a slider fires an input event per step; keep the drag as one
  // marker that shows where it ended up.
  const last = st.events[st.events.length - 1];
  if (last && last.key === key && t - last.at < 1.5) { last.label = label; last.at = t; return; }
  st.events.push({ t, at: t, key, label });
}

function makeNoise(st) {
  for (let k = 0; k < 6; k += 1) {
    const c = document.createElement('canvas'); c.width = 320; c.height = 180;
    const g = c.getContext('2d'); const img = g.createImageData(320, 180);
    for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
    st.noise.push(c);
  }
}

async function start(st, view, ctx) {
  try {
    st.cam = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: false });
  } catch (e) { toast(`Camera unavailable: ${e.message}`); return; }
  st.video = document.createElement('video');
  st.video.muted = true; st.video.playsInline = true; st.video.srcObject = st.cam;
  await st.video.play();
  st.src = document.createElement('canvas'); st.src.width = W; st.src.height = H;
  st.on = true; st.t0 = performance.now(); st.hist = []; st.events = []; st.baseline = null;
  $('#start', view).textContent = 'Turn off camera';
  const g = st.canvas.getContext('2d');
  const sg = st.src.getContext('2d');

  const draw = () => {
    if (!st.on) return;
    const t = (performance.now() - st.t0) / 1000;
    if (!st.frozen) {
      // Source frame, cover-fit into 1280x720, with any covering box drawn in
      // source space so it moves with the face, not the damaged frame.
      const vw = st.video.videoWidth || W; const vh = st.video.videoHeight || H;
      const s = Math.max(W / vw, H / vh);
      sg.drawImage(st.video, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
      if (st.cover !== 'none') {
        const f = st.face || { x: 490, y: 150, w: 300, h: 380 };
        const box = { mask: [f.x - 0.08 * f.w, f.y + 0.55 * f.h, 1.16 * f.w, 0.55 * f.h], forehead: [f.x - 0.05 * f.w, f.y - 0.08 * f.h, 1.1 * f.w, 0.4 * f.h], half: [f.x + 0.5 * f.w, f.y - 0.1 * f.h, 0.62 * f.w, 1.25 * f.h] }[st.cover];
        sg.fillStyle = '#3b4656'; sg.fillRect(...box);
      }
    }
    g.save();
    g.fillStyle = '#1e1e1e'; g.fillRect(0, 0, W, H);
    const bright = Math.pow(2, -st.v.light / 2.2);
    g.filter = `brightness(${bright.toFixed(3)})${st.v.blur ? ` blur(${st.v.blur}px)` : ''}`;
    const a = st.v.sway;
    const dx = a * (0.6 * Math.sin(2 * Math.PI * 0.31 * t) + 0.4 * Math.sin(2 * Math.PI * 0.83 * t + 1.3));
    const dy = a * (0.6 * Math.sin(2 * Math.PI * 0.23 * t + 0.7) + 0.4 * Math.sin(2 * Math.PI * 0.67 * t));
    const d = st.v.distance;
    const ww = W / d; const hh = H / d;
    g.drawImage(st.src, (W - ww) / 2 + dx, (H - hh) / 2 + dy, ww, hh);
    g.filter = 'none';
    if (st.v.flicker) {
      g.fillStyle = `rgba(0,0,0,${((st.v.flicker / 100) * (1 + Math.sin(2 * Math.PI * 1.5 * t))).toFixed(4)})`;
      g.fillRect(0, 0, W, H);
    }
    if (st.v.grain) {
      g.globalCompositeOperation = 'overlay';
      g.globalAlpha = 0.07 * st.v.grain;
      g.imageSmoothingEnabled = false;
      g.drawImage(st.noise[Math.floor(Math.random() * st.noise.length)], 0, 0, W, H);
    }
    g.restore();
    st.raf = requestAnimationFrame(draw);
  };
  draw();

  const stream = st.canvas.captureStream(30);
  st.live = new Live(ctx.cfg, { landmarks: true });
  st.live.mockSeverity = () => Math.min(1, st.v.light / 4 + st.v.grain / 8 + st.v.blur / 20 + st.v.sway / 40 + (st.v.distance - 1) / 4 + (st.frozen ? 1 : 0) + (st.cover !== 'none' ? 0.3 : 0));
  const say = (text, cls = '') => { const el = $('#say', view); if (el) { el.textContent = text; el.className = `say ${cls}`; } };
  st.live
    .on('validation', (code, hint) => { if (code !== st.lastCode) { st.lastCode = code; say(code === 0 ? 'SDK: picture OK' : `SDK: ${hint}`, code === 0 ? 'ok' : 'warn'); } })
    .on('face', (b) => { if (st.cover === 'none' && st.v.distance === 1 && st.v.sway === 0 && !st.frozen) st.face = b; })
    .on('reading', (r) => {
      if (r.pulse) st.latest = r.pulse;
      const m = $('#meter', view); if (m) m.innerHTML = meterHtml(st.latest);
      $('#lock', view).disabled = !st.latest?.stable;
      if (r.pulse && r.pulse.confidence > 0) st.hist.push({ t: (performance.now() - st.t0) / 1000, v: r.pulse.value, c: r.pulse.confidence, s: r.pulse.stable });
      updateDrift(st, view);
      drawHist(st, view);
    })
    .on('error', (e) => toast(`SDK error ${e.code}: ${e.message}`));
  say('Starting SDK…');
  try { await st.live.start(stream); } catch (e) { say(`Could not start: ${e.message}`, 'warn'); }
}

function updateDrift(st, view) {
  const el = $('#drift', view);
  if (!el) return;
  if (st.baseline == null || !st.latest || !(st.latest.confidence > 0)) { el.textContent = st.baseline == null ? 'No baseline yet' : `Baseline ${fmt(st.baseline)} bpm`; return; }
  const dlt = st.latest.value - st.baseline;
  // The locked baseline is itself an SDK estimate (±3 bpm), so only a gap
  // above 6 bpm shows that one of the two stable readings missed.
  const off = Math.abs(dlt) > GAP;
  el.innerHTML = `Δ <b class="num" style="color:${off ? (st.latest.stable ? '#b0321a' : '#1c56a8') : '#14673a'}">${dlt >= 0 ? '+' : ''}${fmt(dlt, 1)}</b> bpm from baseline ${off && st.latest.stable ? '· <b style="color:#b0321a">stable but off</b>' : off ? '· flagged (not stable)' : `· within ±${GAP}`}`;
}

function drawHist(st, view) {
  const c = $('#hist', view); if (!c) return;
  const g = c.getContext('2d');
  const w = c.width; const h = c.height; const m = { l: 60, r: 20, t: 16, b: 34 };
  g.clearRect(0, 0, w, h);
  const now = (performance.now() - st.t0) / 1000;
  const t0 = Math.max(0, now - 60);
  const pts = st.hist.filter((p) => p.t >= t0);
  const x = (t) => m.l + ((t - t0) / 60) * (w - m.l - m.r);
  const vals = pts.map((p) => p.v).concat(st.baseline != null ? [st.baseline - GAP - 1, st.baseline + GAP + 1] : []);
  const lo = Math.min(50, ...vals) - 2; const hi = Math.max(100, ...vals) + 2;
  const y = (v) => h - m.b - ((v - lo) / (hi - lo)) * (h - m.t - m.b);
  const yc = (v) => h - m.b - (v / 100) * (h - m.t - m.b);
  g.font = '22px -apple-system, system-ui'; g.fillStyle = '#9b9ea4';
  g.strokeStyle = '#efefec'; g.lineWidth = 2;
  for (const v of [60, 80, 100]) { if (v < lo || v > hi) continue; g.beginPath(); g.moveTo(m.l, y(v)); g.lineTo(w - m.r, y(v)); g.stroke(); g.fillText(String(v), 8, y(v) + 7); }
  if (st.baseline != null) { g.fillStyle = 'rgba(17,17,17,0.06)'; g.fillRect(m.l, y(st.baseline + GAP), w - m.l - m.r, y(st.baseline - GAP) - y(st.baseline + GAP)); }
  g.lineWidth = 3; g.strokeStyle = '#2f80ed'; g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(p.t), yc(p.c)) : g.moveTo(x(p.t), yc(p.c)))); g.stroke();
  g.strokeStyle = '#111'; g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.v)) : g.moveTo(x(p.t), y(p.v)))); g.stroke();
  for (const p of pts) if (st.baseline != null && p.s && Math.abs(p.v - st.baseline) > GAP) { g.fillStyle = '#f0532d'; g.beginPath(); g.arc(x(p.t), y(p.v), 6, 0, 7); g.fill(); }
  g.fillStyle = '#111'; g.strokeStyle = 'rgba(17,17,17,0.3)'; g.lineWidth = 2; g.setLineDash([6, 6]);
  let free = -Infinity;
  for (const e of st.events.filter((ev) => ev.t >= t0)) {
    g.beginPath(); g.moveTo(x(e.t), m.t); g.lineTo(x(e.t), h - m.b); g.stroke();
    // A label that would run into the previous one is left off; its line stays.
    const lx = x(e.t) + 6;
    if (lx >= free) { g.fillText(e.label, lx, h - 8); free = lx + g.measureText(e.label).width + 14; }
  }
  g.setLineDash([]);
}

function stop(st, view) {
  st.on = false;
  cancelAnimationFrame(st.raf);
  if (st.live) st.live.stop();
  st.live = null;
  if (st.cam) st.cam.getTracks().forEach((t) => t.stop());
  st.cam = null;
  if (view) { const b = $('#start', view); if (b) b.textContent = 'Turn on camera'; const s = $('#say', view); if (s) s.textContent = 'Camera off'; }
}

module.exports = { render };
