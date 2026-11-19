'use strict';

const { esc, $, $$, confirmModal, toast, chip, fmt, icon, LOGO } = require('./ui');
const record = require('./record');
const tunnel = require('./tunnel');
const crashview = require('./crashview');
const report = require('./report');
const charts = require('./charts');

const ctx = { cfg: null, runState: null, cleanup: null, onEvent: null };
const view = () => $('#view');

function privacyHtml(cfg) {
  return `
  <ul>
    <li><span class="ico">${icon('record')}</span><div><b>What the camera is for.</b> The SmartSpectra SDK estimates pulse and breathing from small changes in your face and chest. TrustFall uses it to test how those readings hold up. The camera turns on only when you press a button that says so.</div></li>
    <li><span class="ico">${icon('folder')}</span><div><b>What is saved.</b> The clips you record (video of your face), any reference pulse you type in, and the readings from each crash test. Everything goes in one folder on this computer: <span class="path">${esc(cfg.dataDir)}</span></div></li>
    <li><span class="ico">${icon('chip')}</span><div><b>What leaves this computer.</b> Readings are computed on-device. The SDK contacts Presage only to check the API key and usage. TrustFall turns the SDK’s telemetry off (<code>enableTelemetry: false</code>), so no session summaries or readiness reports are sent. No video, no readings, no accounts, no analytics, no AI services.</div></li>
    <li><span class="ico">${icon('clock')}</span><div><b>How long it is kept.</b> Until you delete it. “Delete all data” removes the whole folder at once; you can also delete single clips.</div></li>
    <li><span class="ico">${icon('users')}</span><div><b>Other people.</b> Only record yourself, or someone who has agreed to it beforehand. Never film anyone without their knowledge.</div></li>
    <li><span class="ico">${icon('heart')}</span><div><b>Not medical.</b> Wellness and measurement only. TrustFall does not diagnose anything and its results are not for health decisions. It tests how readings behave; it does not judge whether the SDK is accurate.</div></li>
  </ul>`;
}

function consentGate(cfg) {
  view().innerHTML = `<div class="page consent"><div class="card">
    <div class="eyebrow">Before the camera turns on</div>
    <h1>Your face, your data, your call.</h1>
    <p class="muted" style="margin-top:8px">TrustFall records short clips of you to crash-test camera vital signs. Here is exactly what that involves.</p>
    ${privacyHtml(cfg)}
    <label class="check"><input type="checkbox" id="ok"><span>I understand what is recorded and stored, and I will only record myself or people who have agreed.</span></label>
    <div class="row"><span class="spacer"></span><button class="btn primary big" id="agree" disabled>I agree</button></div>
  </div></div>`;
  $('#ok').onchange = (e) => { $('#agree').disabled = !e.target.checked; };
  $('#agree').onclick = async () => { await window.lab.consent(true); cfg.consented = true; route(); };
}

function privacy(v) {
  v.innerHTML = `<div class="page consent"><div class="card">
    <div class="eyebrow">Consent and data</div><h1>What TrustFall keeps.</h1>
    ${privacyHtml(ctx.cfg)}
    <div class="row wrap" style="margin-top:12px"><button class="btn" id="reveal">${icon('folder')}Open data folder</button><span class="spacer"></span>
      <button class="btn" id="withdraw">Withdraw consent</button><button class="btn danger" id="del">Delete all data</button></div>
  </div></div>`;
  $('#reveal').onclick = () => window.lab.reveal(null);
  $('#withdraw').onclick = async () => { await window.lab.consent(false); ctx.cfg.consented = false; route(); };
  $('#del').onclick = async () => {
    if (!(await confirmModal({ title: 'Delete all data?', body: `This permanently removes every clip, crash-test result and report in <span class="path">${esc(ctx.cfg.dataDir)}</span>, and withdraws consent. It cannot be undone.`, ok: 'Delete everything', danger: true }))) return;
    await window.lab.deleteAll();
    ctx.runState = null;
    ctx.cfg.consented = false;
    toast('All data deleted');
    route();
  };
}

const OUTCOMES = [
  ['held', 'Readings stayed right and stable.'],
  ['caught', 'The SDK lowered its confidence. Honest.'],
  ['fooled', 'Readings drifted while still marked stable. The dangerous one.'],
  ['refused', 'The SDK produced nothing. Also honest.'],
];

function tunnelCard(cls) {
  return `<div class="card ${cls} fill">
    <h2 style="font-size:28px;line-height:1.1;letter-spacing:-0.03em">Push the picture.<br>Watch the confidence.</h2>
    <p class="muted small" style="margin-top:12px">Your live camera is damaged before the SDK sees it. Slide in darkness, blur or sway and see whether confidence reacts.</p>
    <div class="grow"></div>
    <a class="bubble" href="#tunnel" style="margin-top:18px;text-decoration:none"><span class="pill">6 sliders</span><span class="small" style="flex:1">Open the tunnel</span><span class="icon-btn dark" style="width:38px;height:38px">${icon('arrow')}</span></a>
  </div>`;
}

function clipCard(clips, cls) {
  const c = clips[0];
  if (!c) {
    return `<div class="card lime ${cls} fill"><div class="card-head">Crash-test dummy</div>
      <div class="metric md" style="margin-top:14px">60<small>s</small></div><p class="metric-note">One clean minute of you is all the crash test needs.</p>
      <div class="grow"></div><div class="row" style="margin-top:16px"><a class="btn primary" href="#record">Record a clip</a></div></div>`;
  }
  return `<div class="card ${cls} fill"><div class="card-head">Crash-test dummy<span class="spacer"></span><span class="pill">${clips.length} clip${clips.length === 1 ? '' : 's'}</span></div>
    <img class="clip-hero" src="lab://clips/${c.id}/thumb.jpg">
    <b style="font-weight:550">${esc(c.name)}</b><div class="faint small">${fmt(c.info.duration)} s · ${new Date(c.createdAt).toLocaleDateString()}</div>
    <div class="grow"></div>
    <div class="row" style="margin-top:14px"><a class="btn primary" href="#crash?clip=${c.id}">Test again</a><span class="spacer"></span>
      <button class="icon-btn" data-del="${c.id}" title="Delete this clip" style="width:38px;height:38px">✕</button></div></div>`;
}

async function home(v) {
  const { clips, runs } = await window.lab.list();
  const r = runs[0];
  if (!r) {
    v.innerHTML = `<div class="page">
      <div class="bento">
        <div class="card hero-card c8 r2 fill">
          <div class="eyebrow">TrustFall · crash-test lab for camera vitals</div>
          <h1>Camera vitals come with a confidence score. Does it catch the fall?</h1>
          <p class="lede">Record one clean minute of yourself. TrustFall replays it through the SmartSpectra SDK with one controlled change at a time: darkness, shake, blur, video-call compression, flicker, a still photo. Your real pulse is the same in every copy, so when a reading moves, the picture moved it. Then it checks whether the SDK’s confidence noticed.</p>
          <div class="grow"></div>
          <div class="row wrap" style="margin-top:26px"><a class="btn primary big" href="#record">Record a clip</a><a class="btn big" href="#tunnel">Try the wind tunnel</a></div>
        </div>
        <div class="card c4 r2"><div class="card-head">Every variant ends in one of four outcomes</div>
          <div style="margin-top:8px">${OUTCOMES.map(([k, t]) => `<div class="outcome">${chip(k)}<span class="muted small">${t}</span></div>`).join('')}</div>
          <p class="faint small" style="margin-top:14px">Yardstick: Presage documents that a <code>stable</code> pulse reading is within ±3 bpm and a stable breathing reading within ±1 br/min. The clean copy is an SDK reading too, so TrustFall only calls a reading off when it is more than twice that from the clean copy.</p></div>
      </div>
      <div class="bento">
        <div class="card step-card c4"><div class="step-n">01</div><h3>Record the dummy</h3><p>A guided 60-second clip with live SDK feedback, so the reference is clean.</p><a class="btn" href="#record">Record</a></div>
        <div class="card step-card c4"><div class="step-n">02</div><h3>Crash test</h3><p>Up to 41 damaged replays, rendered with ffmpeg and measured by the SDK, all on this computer.</p><a class="btn" href="#crash">Crash test</a></div>
        <div class="card step-card c4"><div class="step-n">03</div><h3>Read the verdict</h3><p>Setup fixes first, then the stable-flag check, headroom per condition and every reading.</p><a class="btn" href="#reports">Reports</a></div>
      </div>
      <div class="bento">${clipCard(clips, 'c6')}${tunnelCard('c6')}</div>
    </div>`;
    bindClipDelete(v);
    return;
  }

  const p = r.promise.pulse; const b = r.promise.breathing;
  const st = { metric: 'pulse' };
  v.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Crash-test lab</div><h1>Overview</h1></div><span class="spacer"></span>
      <span class="pill white lg">${icon('calendar')}Latest run · ${new Date(r.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
      <span class="pill white lg">${esc(r.suite[0].toUpperCase() + r.suite.slice(1))} suite</span>
      <a class="btn primary big" href="#crash">New crash test</a></div>
    <div class="bento">
      <div class="card c6 r2 fill">
        <div class="card-head"><span class="sq"></span>Latest crash test<span class="spacer"></span>${r.mock ? '<span class="pill mock">mock data</span>' : ''}<span class="grade ${r.verdict.grade}">${report.GRADE[r.verdict.grade]}</span></div>
        <div class="minis"><div class="mini"><span>Variants</span><b>${r.counts.variants}</b></div><div class="mini"><span>Readings</span><b>${r.counts.readings.toLocaleString()}</b><span class="tag">2 per s</span></div></div>
        <p class="muted small">${esc(r.verdict.headline)} Each bar is how far off the worst fifth of stable readings were. Past the line counts as confident but off.</p>
        <div id="home-bars" class="grow" style="margin-top:6px"></div>
        <div class="legend" style="margin:4px 0 12px">${report.barLegend()}</div>
        <div class="row wrap"><div class="seg" id="home-seg"><button data-m="pulse" class="on">Pulse</button><button data-m="breathing">Breathing</button></div><span class="spacer"></span>
          <a class="btn" href="#reports?run=${r.runId}">Open report</a></div>
      </div>
      <div class="card lime c3"><div class="card-head">Pulse · stable-flag check</div>
        <div class="metric" style="margin-top:14px">${p.pct != null ? fmt(p.pct) : '–'}<small>%</small></div>
        <p class="metric-note">of <b class="num">${p.stable}</b> pulse readings marked stable were within ${p.tolerance} bpm of the clean copy, the most two ±${p.promise} bpm readings can differ.</p></div>
      <div class="card c3 r2 fill" id="home-blind">${report.blindSpotsHtml(r, 'pulse')}</div>
      <div class="card sky c3"><div class="card-head">Breathing · stable-flag check</div>
        <div class="metric" style="margin-top:14px">${b.pct != null ? fmt(b.pct) : '–'}<small>%</small></div>
        <p class="metric-note">of <b class="num">${b.stable}</b> breathing readings marked stable were within ${b.tolerance} br/min of the clean copy.</p></div>
    </div>
    <div class="bento">
      <div class="card c6"><div class="card-head">When the SDK said “stable”, was it right?<span class="spacer"></span><span class="tag" id="lolli-tag">pulse · ±${p.tolerance} bpm</span></div>
        <p class="faint small">Share of stable readings within tolerance, by condition.</p><div id="home-lolli" style="margin-top:4px"></div></div>
      ${clipCard(clips, 'c3')}
      ${tunnelCard('c3')}
    </div>
  </div>`;

  const draw = () => {
    const m = st.metric;
    const unit = m === 'pulse' ? 'bpm' : 'br/min';
    const tol = r.tolerance[m];
    charts.variantBars($('#home-bars', v), r.variants, { metric: m, tol, unit, onPick: (id) => { location.hash = `#reports?run=${r.runId}&v=${id}`; } });
    charts.lollipops($('#home-lolli', v), report.conditionItems(r, m), { unit, tol });
    $('#home-blind', v).innerHTML = report.blindSpotsHtml(r, m);
    $('#lolli-tag', v).textContent = `${m} · ±${tol} ${unit}`;
  };
  $$('#home-seg button', v).forEach((bt) => { bt.onclick = () => { st.metric = bt.dataset.m; $$('#home-seg button', v).forEach((x) => x.classList.toggle('on', x === bt)); draw(); }; });
  draw();
  bindClipDelete(v);
}

function bindClipDelete(v) {
  $$('[data-del]', v).forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmModal({ title: 'Delete this clip?', body: 'The video and its metadata are removed from the data folder. Reports made from it are kept.', ok: 'Delete clip', danger: true }))) return;
      await window.lab.deleteClip(b.dataset.del);
      home(v);
    };
  });
}

async function route() {
  if (ctx.cleanup) { try { ctx.cleanup(); } catch { /* ignore */ } ctx.cleanup = null; }
  ctx.onEvent = null;
  tooltipOff();
  const v = view();
  if (!ctx.cfg.consented) { $$('.rail a').forEach((a) => a.classList.remove('active')); consentGate(ctx.cfg); return; }
  const [name, query] = (location.hash.slice(1) || 'home').split('?');
  const params = new URLSearchParams(query || '');
  $$('.rail a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name || (name === 'home' && a.dataset.nav === 'home')));
  v.scrollTop = 0;
  if (name === 'record') return record.render(v, ctx);
  if (name === 'tunnel') return tunnel.render(v, ctx);
  if (name === 'crash') return crashview.render(v, ctx, params);
  if (name === 'reports') return report.render(v, ctx, params);
  if (name === 'privacy') return privacy(v);
  return home(v);
}

function tooltipOff() { const t = $('#tooltip'); if (t) t.hidden = true; }

function shell(cfg) {
  const today = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const sdk = cfg.mock ? '<span class="dot mock"></span>Mock readings'
    : cfg.hasKey ? `<span class="dot"></span>SmartSpectra ${esc(cfg.sdkVersion || '')}` : '<span class="dot warn"></span>No API key';
  $('#top').innerHTML = `<a class="brand" href="#home"><span class="logo">${LOGO}</span><span><span class="brand-name">TrustFall</span><span class="brand-sub">Crash-test lab</span></span></a>
    <span class="pill" title="SmartSpectra SDK">${sdk}</span>
    <span class="pill wide-only" title="enableTelemetry: false">${icon('shield')}Telemetry off</span>
    <span class="spacer"></span>
    <span class="pill wide-only" title="${esc(cfg.dataDir)}">${icon('lock')}Data stays on this computer</span>
    <span class="pill">${icon('calendar')}${esc(today)}</span>
    <a class="icon-btn dark" href="#record" title="Record a clip">${icon('record')}</a>`;
  const nav = [['home', 'grid', 'Lab'], ['record', 'record', 'Record'], ['crash', 'target', 'Crash test'], ['reports', 'bars', 'Reports'], ['tunnel', 'wind', 'Tunnel']];
  $('#rail').innerHTML = nav.map(([k, i, l]) => `<a href="#${k}" data-nav="${k}"><span class="ic">${icon(i)}</span>${l}${k === 'tunnel' ? '<span class="live" title="Live camera"></span>' : ''}</a>`).join('')
    + `<a class="foot" href="#privacy" data-nav="privacy"><span class="ic">${icon('shield')}</span>Privacy</a>`;
}

function banner(cfg) {
  const b = $('#banner');
  if (cfg.mock) { b.innerHTML = 'Mock mode · synthetic readings, not the SmartSpectra SDK · do not cite'; b.hidden = false; document.body.classList.add('has-banner'); }
  else if (!cfg.hasKey) { b.className = 'banner key'; b.innerHTML = 'No SmartSpectra API key. Copy <code>.env.example</code> to <code>.env</code>, add your key, and restart.'; b.hidden = false; document.body.classList.add('has-banner'); }
  if (!cfg.ffmpeg) toast('ffmpeg not found: crash tests need it (brew install ffmpeg)');
}

async function snapTour() {
  // Development only (TRUSTFALL_SNAP=1): visit each screen that does not use
  // the camera and save a PNG of the app window to docs/screens.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shots = [['home', '#home'], ['record', '#record'], ['crash', '#crash'], ['reports', '#reports'], ['tunnel', '#tunnel'], ['privacy', '#privacy']];
  const { runs } = await window.lab.list();
  if (runs[0]) shots.push(['report', `#reports?run=${runs[0].runId}`]);
  const until = async (sel) => { for (let i = 0; i < 40 && !view().querySelector(sel); i += 1) await wait(250); };
  for (const [name, hash] of shots) {
    location.hash = hash;
    await wait(600);
    await until(name === 'report' ? '#bars svg' : '.page');
    await wait(600);
    await window.lab.snap(name);
    if (name === 'home') { view().scrollTop = 900; await wait(400); await window.lab.snap('home-2'); }
    if (name === 'report') {
      for (const [i, y] of [[2, 900], [3, 1800], [4, 2700], [5, 3600]]) { view().scrollTop = y; await wait(500); await window.lab.snap(`report-${i}`); }
    }
  }
  if (new URLSearchParams(location.search).get('snap') === 'run') {
    // Drive a smoke-suite crash test through the worker process.
    location.hash = '#crash';
    await wait(1200);
    $('[data-suite="smoke"]').click();
    $('#go').click();
    for (let i = 0; i < 240 && !(ctx.runState?.done || ctx.runState?.error); i += 1) {
      await wait(500);
      if (i === 8) await window.lab.snap('crash-running');
    }
    await window.lab.snap('crash-done');
  }
  window.close();
}

(async () => {
  ctx.cfg = await window.lab.config();
  shell(ctx.cfg);
  banner(ctx.cfg);
  window.lab.onEvent((e) => {
    crashview.onEvent(ctx, e, location.hash.startsWith('#crash') ? view() : null);
    if (ctx.onEvent) ctx.onEvent(e);
  });
  window.addEventListener('hashchange', route);
  // The CSP blocks inline handlers, so hide missing thumbnails here instead.
  document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);
  await route();
  if (new URLSearchParams(location.search).get('snap')) { ctx.cfg.consented = true; snapTour(); }
})();
