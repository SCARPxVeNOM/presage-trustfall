'use strict';

const { esc, $, fmt, toast } = require('./ui');
const { Live, VALIDATION_OK } = require('./live');

const TIPS = [
  { title: 'Light in front of you', text: 'Face a window or a lamp. Avoid a bright window behind you.',
    svg: '<svg viewBox="0 0 200 120"><rect width="200" height="120" fill="#f4f4f1"/><circle cx="40" cy="40" r="16" fill="#ffcf3d"/><g stroke="#ffcf3d" stroke-width="3" stroke-linecap="round"><path d="M40 12v-6M40 74v-6M12 40H6M74 40h-6M20 20l-4-4M64 64l-4-4M60 20l4-4"/></g><path d="M70 50 L120 62 M70 40 L122 50 M70 30 L120 40" stroke="#f0b400" stroke-opacity=".45" stroke-width="2"/><circle cx="145" cy="56" r="20" fill="#e8c9a8"/><path d="M118 120c4-28 16-38 27-38s23 10 27 38z" fill="#111"/></svg>' },
  { title: 'Camera on something solid', text: 'A table or stand, not your lap or your hand. Sit about an arm’s length away.',
    svg: '<svg viewBox="0 0 200 120"><rect width="200" height="120" fill="#f4f4f1"/><rect x="20" y="96" width="160" height="6" rx="3" fill="#c9c9c4"/><path d="M48 96 L58 58 H118 L128 96 Z" fill="#deded9"/><rect x="60" y="30" width="56" height="32" rx="4" fill="#111"/><circle cx="88" cy="35" r="2" fill="#d7f36b"/><circle cx="160" cy="58" r="14" fill="#e8c9a8"/><path d="M142 96c2-16 9-24 18-24s16 8 18 24z" fill="#111"/><path d="M118 70 H142" stroke="#111" stroke-dasharray="3 3" stroke-width="2"/></svg>' },
  { title: 'Still and quiet', text: 'Breathe normally. Don’t talk, chew or move your head for the minute.',
    svg: '<svg viewBox="0 0 200 120"><rect width="200" height="120" fill="#f4f4f1"/><circle cx="100" cy="52" r="22" fill="#e8c9a8"/><path d="M90 62 h20" stroke="#6b4a3a" stroke-width="3" stroke-linecap="round"/><circle cx="92" cy="48" r="2.5" fill="#3a2a22"/><circle cx="108" cy="48" r="2.5" fill="#3a2a22"/><path d="M68 120c4-26 16-36 32-36s28 10 32 36z" fill="#111"/><rect x="138" y="24" width="44" height="22" rx="11" fill="#d7f36b"/><text x="160" y="40" fill="#111" font-size="13" font-weight="600" text-anchor="middle" font-family="-apple-system, sans-serif">60 s</text><path d="M40 42 q-8 10 0 20 M30 36 q-12 16 0 32" stroke="#9b9ea4" stroke-width="2" fill="none"/></svg>' },
];

function ring(conf, stable) {
  const r = 58; const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(100, conf || 0)) / 100;
  const col = stable ? '#1f9d57' : conf > 0 ? '#2f80ed' : '#e3e3df';
  return `<svg viewBox="0 0 132 132"><circle cx="66" cy="66" r="${r}" fill="none" stroke="#efefec" stroke-width="10"/>
    <circle cx="66" cy="66" r="${r}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c * f} ${c}"/></svg>`;
}

function meterHtml(p) {
  const stable = p && p.stable;
  const conf = p ? p.confidence : 0;
  return `<div class="meter">
    <div class="ring">${ring(conf, stable)}<div class="val"><div><b>${fmt(conf)}</b><span>confidence</span></div></div></div>
    <div class="readout"><span class="faint small">PULSE</span><div class="big">${p && p.confidence > 0 ? fmt(p.value) : '––'}<small>bpm</small></div>
      <span class="state"><span class="dot" style="background:${stable ? 'var(--held)' : conf > 0 ? 'var(--flag)' : 'var(--none)'}"></span>${stable ? 'Stable reading' : conf > 0 ? 'Not stable yet' : 'Warming up (about 12 s)'}</span></div>
  </div>`;
}

function render(view, ctx) {
  const st = { step: 'intro', seconds: 60, name: '', live: null, recId: null, recorder: null, okSince: null, countdown: null, timer: null, latest: null, clip: null, recStartTs: null, markStart: false, issues: {} };
  ctx.cleanup = () => teardown(st);

  const draw = () => {
    const stepIdx = { intro: 0, position: 1, countdown: 1, recording: 2, reference: 3, saving: 3, saved: 4 }[st.step];
    const bar = `<div class="steps">${[0, 1, 2, 3, 4].map((i) => `<span class="${i <= stepIdx ? 'on' : ''}"></span>`).join('')}</div>`;
    if (st.step === 'intro') {
      view.innerHTML = `<div class="page">${bar}
        <div class="eyebrow">Step 1 · Record the crash-test dummy</div>
        <h1>One clean minute of you.</h1>
        <p class="muted" style="margin-top:10px;max-width:70ch">This clip becomes the reference for every crash test. The cleaner it is, the more the tests can tell you. Nothing is uploaded: the video stays in your data folder until you delete it.</p>
        <div class="tips">${TIPS.map((t) => `<div class="tip">${t.svg}<b>${t.title}</b><span>${t.text}</span></div>`).join('')}</div>
        <div class="toolbar">
          <label class="muted row" style="gap:8px">Length <select class="field" id="secs">${[45, 60, 75].map((s) => `<option value="${s}" ${s === st.seconds ? 'selected' : ''}>${s} seconds</option>`).join('')}</select></label>
          <input class="field" id="name" placeholder="Name this clip (optional), e.g. desk, daylight" style="min-width:320px;background:var(--soft);border-color:transparent" value="${esc(st.name)}">
          <span class="spacer"></span>
          <button class="btn primary big" id="go">Turn on camera</button>
        </div>
        ${!ctx.cfg.hasKey && !ctx.cfg.mock ? '<p class="notice err" style="margin-top:18px">No SmartSpectra API key found. Add it to <code>.env</code> and restart to record with live guidance.</p>' : ''}
      </div>`;
      $('#secs', view).onchange = (e) => { st.seconds = Number(e.target.value); };
      $('#name', view).oninput = (e) => { st.name = e.target.value; };
      $('#go', view).onclick = () => startCamera(st, draw, ctx);
      return;
    }
    if (['position', 'countdown', 'recording'].includes(st.step)) {
      const title = st.step === 'recording' ? 'Stay still and breathe normally' : 'Get into position';
      const sub = st.step === 'recording' ? 'Don’t talk or move your head. The recording stops by itself.' : 'Centre your face in the oval. Recording starts once the SDK says the picture is good for 3 seconds.';
      view.innerHTML = `<div class="page">${bar}
        <div class="eyebrow">Step ${st.step === 'recording' ? 3 : 2} · ${st.step === 'recording' ? 'Recording' : 'Position'}</div>
        <div class="row" style="align-items:flex-end;margin-bottom:16px"><div><h1>${title}</h1><p class="muted" style="margin-top:6px">${sub}</p></div><span class="spacer"></span>
          ${st.step === 'position' ? '<button class="btn" id="anyway">Record anyway</button>' : ''}<button class="btn ghost" id="stop">Cancel</button></div>
        <div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(280px,1fr)">
          <div class="stage"><video id="vid" autoplay playsinline muted></video><div class="guide"></div>
            ${st.step === 'recording' ? '<div class="rec" id="rec">REC 00:00</div>' : ''}
            ${st.step === 'countdown' ? `<div class="count" id="count">${st.countdown}</div>` : ''}
            ${ctx.cfg.mock ? '<div class="tag">MOCK readings</div>' : '<div class="tag">SmartSpectra live</div>'}
            <div class="hud"><div class="say" id="say">Starting camera…</div></div></div>
          <div class="card stack" id="side">
            <div id="meter">${meterHtml(st.latest)}</div>
            <div class="prog" style="margin-top:18px"><div id="recprog"></div></div>
            <p class="small faint" id="note">${st.step === 'recording' ? `Recording ${st.seconds} s at high quality. Readings shown here are live from the SDK.` : 'The ring fills as the SDK grows confident. Green means it marks the pulse reading as stable.'}</p>
          </div>
        </div></div>`;
      const vid = $('#vid', view);
      if (st.live?.stream) vid.srcObject = st.live.stream;
      $('#stop', view).onclick = () => { teardown(st); st.step = 'intro'; draw(); };
      if ($('#anyway', view)) $('#anyway', view).onclick = () => beginCountdown(st, draw, ctx);
      return;
    }
    if (st.step === 'reference') {
      const issues = Object.entries(st.issues).filter(([, s]) => s >= 3).map(([h, s]) => `${esc(h)} (${fmt(s)} s)`);
      view.innerHTML = `<div class="page">${bar}
        <div class="eyebrow">Step 4 · Optional reference</div>
        <h1>Did anything else measure your pulse?</h1>
        <p class="muted" style="margin-top:10px;max-width:70ch">If you wore a pulse oximeter or a smartwatch during the recording, enter the average pulse it showed. TrustFall only compares it with your clean clip. Skip this if you had nothing on: the crash test does not need it.</p>
        ${issues.length ? `<p class="notice" style="margin-top:16px">During recording the SDK reported: ${issues.join(', ')}. You can keep this clip, but a cleaner one makes a better reference.</p>` : ''}
        <div class="row wrap" style="margin-top:22px">
          <input class="field num" id="ref" type="number" min="30" max="200" placeholder="bpm" style="width:120px">
          <select class="field" id="method"><option value="oximeter">Pulse oximeter</option><option value="watch">Smartwatch</option><option value="manual">Counted by hand</option></select>
          <span class="spacer"></span>
          <button class="btn" id="discard">Discard clip</button>
          <button class="btn" id="skip">Skip</button>
          <button class="btn primary" id="save">Save clip</button>
        </div></div>`;
      $('#skip', view).onclick = () => save(st, draw, ctx, null);
      $('#discard', view).onclick = async () => { await window.lab.recFinish(st.recId, null); st.step = 'intro'; draw(); };
      $('#save', view).onclick = () => {
        const v = Number($('#ref', view).value);
        save(st, draw, ctx, v >= 30 && v <= 200 ? { pulse: v, method: $('#method', view).value } : null);
      };
      return;
    }
    if (st.step === 'saving') {
      view.innerHTML = `<div class="page">${bar}<div class="empty"><h2>Saving your clip…</h2><p>Converting to a constant 30 fps master file.</p>
        <div class="prog" style="max-width:360px;margin:20px auto"><div id="saveprog"></div></div></div></div>`;
      return;
    }
    if (st.step === 'saved') {
      const c = st.clip;
      view.innerHTML = `<div class="page">${bar}
        <div class="eyebrow">Saved</div><h1>Your crash-test dummy is ready.</h1>
        <div class="card row" style="margin-top:20px;gap:20px">
          <img src="lab://clips/${c.id}/thumb.jpg" style="width:280px;border-radius:16px;transform:scaleX(-1)">
          <div class="stack"><h3>${esc(c.name)}</h3><p class="muted num">${fmt(c.info.duration, 1)} s · ${c.info.width}×${c.info.height} · ${fmt(c.info.fps)} fps</p>
            ${c.reference ? `<p class="muted">Reference: <span class="num">${c.reference.pulse}</span> bpm (${esc(c.reference.method)})</p>` : ''}
            <div class="row"><a class="btn primary" href="#crash?clip=${c.id}">Crash-test this clip</a><button class="btn" id="again">Record another</button></div></div>
        </div></div>`;
      $('#again', view).onclick = () => { st.step = 'intro'; draw(); };
    }
  };

  ctx.onEvent = (e) => {
    if (e.type === 'import' && $('#saveprog', view)) $('#saveprog', view).style.width = `${Math.round(e.progress * 100)}%`;
  };
  draw();
}

async function startCamera(st, draw, ctx) {
  st.step = 'position';
  st.live = new Live(ctx.cfg);
  st.okSince = null;
  draw();
  const say = (text, cls = '') => { const el = $('#say'); if (el) { el.textContent = text; el.className = `say ${cls}`; } };
  st.live
    .on('stream', (s) => { const v = $('#vid'); if (v) v.srcObject = s; })
    .on('validation', (code, hint) => {
      st.lastCode = code;
      if (st.step === 'recording' && code !== VALIDATION_OK && code !== 10) st.issues[hint] = (st.issues[hint] || 0) + 0.5;
      if (code === VALIDATION_OK) {
        say(st.step === 'recording' ? 'Good. Keep still.' : 'Looks good. Hold still…', 'ok');
        if (st.step === 'position') {
          st.okSince = st.okSince || Date.now();
          if (Date.now() - st.okSince > 3000) beginCountdown(st, draw, ctx);
        }
      } else {
        st.okSince = null;
        say(hint || 'Adjusting…', 'warn');
      }
    })
    .on('frame', (ts) => { if (st.markStart) { st.recStartTs = ts; st.markStart = false; } })
    .on('reading', (r) => {
      if (r.pulse) st.latest = r.pulse;
      const m = $('#meter');
      if (m) m.innerHTML = meterHtml(st.latest);
    })
    .on('error', (e) => { say(`SDK error ${e.code}: ${e.message}`, 'warn'); toast(e.message); });
  try {
    await st.live.start();
  } catch (e) {
    say(`Could not start: ${e.message}`, 'warn');
  }
}

function beginCountdown(st, draw, ctx) {
  if (st.step !== 'position') return;
  st.step = 'countdown';
  st.countdown = 3;
  draw();
  st.timer = setInterval(() => {
    st.countdown -= 1;
    if (st.countdown <= 0) { clearInterval(st.timer); startRecording(st, draw, ctx); return; }
    const el = $('#count'); if (el) el.textContent = st.countdown;
  }, 1000);
}

async function startRecording(st, draw, ctx) {
  st.step = 'recording';
  st.issues = {};
  draw();
  const types = ['video/mp4;codecs=avc1.640028', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mimeType = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  st.recId = await window.lab.recBegin({ mimeType });
  const rec = new MediaRecorder(st.live.stream, { mimeType, videoBitsPerSecond: 12_000_000 });
  st.recorder = rec;
  let pending = Promise.resolve();
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    pending = pending.then(async () => window.lab.recChunk(st.recId, await e.data.arrayBuffer()));
  };
  rec.onstop = async () => {
    await pending;
    st.liveSamples = st.recStartTs != null ? st.live.since(st.recStartTs) : null;
    await st.live.stop();
    st.step = 'reference';
    draw();
  };
  st.markStart = true;
  rec.start(1000);
  const t0 = Date.now();
  st.timer = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    const el = $('#rec'); if (el) el.textContent = `REC ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')} / ${String(Math.floor(st.seconds / 60)).padStart(2, '0')}:${String(st.seconds % 60).padStart(2, '0')}`;
    const p = $('#recprog'); if (p) p.style.width = `${Math.min(100, (100 * s) / st.seconds)}%`;
    if (s >= st.seconds + 0.4) { clearInterval(st.timer); if (rec.state !== 'inactive') rec.stop(); }
  }, 200);
}

async function save(st, draw, ctx, reference) {
  st.step = 'saving';
  draw();
  try {
    st.clip = await window.lab.recFinish(st.recId, { name: st.name || undefined, live: st.liveSamples, reference, seconds: st.seconds });
    st.step = 'saved';
  } catch (e) {
    toast(`Could not save: ${e.message}`);
    st.step = 'intro';
  }
  draw();
}

function teardown(st) {
  clearInterval(st.timer);
  if (st.recorder && st.recorder.state !== 'inactive') { st.recorder.onstop = null; st.recorder.stop(); if (st.recId) window.lab.recFinish(st.recId, null); }
  if (st.live) st.live.stop();
  st.live = null;
}

module.exports = { render, meterHtml, ring };
