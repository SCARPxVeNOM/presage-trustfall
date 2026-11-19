'use strict';

const { esc, $, chip, fmt, confirmModal, toast } = require('./ui');
const { SUITES, VARIANTS, FAMILIES } = require('../core/suite');

const SUITE_TEXT = {
  smoke: 'Four runs to check the setup works: original, repeat, a known speed change and a still photo.',
  quick: 'The headline conditions, one level each, plus the controls. Good for a first look.',
  full: 'Every condition at four severity levels, to find where each one breaks.',
};

function render(view, ctx, params) {
  const draw = async () => {
    const rs = ctx.runState;
    if (rs && !rs.dismissed) return drawRun(view, ctx);
    const { clips } = await window.lab.list();
    if (!clips.length) {
      view.innerHTML = `<div class="page"><div class="empty"><h2>Record a clip first</h2><p>The crash test replays one clean minute of you. Record it in the app, or import a video with the CLI (<code>npm run crash -- my-video.mp4</code>).</p><a class="btn primary" href="#record">Record a clip</a></div></div>`;
      return;
    }
    const sel = { clip: params.get('clip') || clips[0].id, suite: 'quick' };
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><div class="eyebrow">Step 2 · Crash test</div><h1>Replay your clip under controlled damage.</h1>
        <p class="muted" style="margin-top:8px;max-width:74ch">Each variant is the same clip with one change. Your real pulse did not change between them, so any difference in the readings comes from the picture. TrustFall checks whether the SDK’s confidence noticed.</p></div></div>
      <h3 style="margin-bottom:10px">1. Choose the clip</h3>
      <div class="tiles" id="clips">${clips.map((c) => `<div class="tile clickable ${c.id === sel.clip ? 'active' : ''}" data-clip="${c.id}">
        <div class="thumb"><img src="lab://clips/${c.id}/thumb.jpg"></div>
        <div class="body"><div class="label">${esc(c.name)}</div><div class="status num">${fmt(c.info.duration, 1)} s · ${new Date(c.createdAt).toLocaleString()}</div>
        ${c.reference ? `<div class="status">Reference ${c.reference.pulse} bpm</div>` : ''}${c.mock ? '<span class="pill mock">mock</span>' : ''}</div></div>`).join('')}</div>
      <h3 style="margin:26px 0 10px">2. Choose the suite</h3>
      <div class="grid g3" id="suites">${['smoke', 'quick', 'full'].map((s) => `<div class="suite ${s === sel.suite ? 'active' : ''}" data-suite="${s}">
        <div class="row"><h3 style="text-transform:capitalize">${s}</h3><span class="spacer"></span><span class="tag">${SUITES[s].length} SDK sessions · ~${Math.round(SUITES[s].length * 1.3)} min</span></div>
        <div class="n">${SUITES[s].length}<small style="font-size:15px;color:var(--ink-2);margin-left:6px;letter-spacing:0">runs</small></div>
        <p class="muted small">${SUITE_TEXT[s]}</p></div>`).join('')}</div>
      <div class="notice" style="margin-top:22px">Every run is a full SmartSpectra session on about a minute of video, played at real-time speed so the SDK sees every frame. A suite uses as many sessions as it has runs. Readings are computed on this computer; the SDK contacts Presage only to check your API key and usage.</div>
      <div class="row" style="margin-top:22px"><span class="spacer"></span>
        <button class="btn primary big" id="go" ${!ctx.cfg.hasKey && !ctx.cfg.mock ? 'disabled title="Add SMARTSPECTRA_API_KEY to .env"' : ''}>Start crash test</button></div>
    </div>`;
    view.querySelectorAll('[data-clip]').forEach((el) => { el.onclick = () => { sel.clip = el.dataset.clip; view.querySelectorAll('[data-clip]').forEach((x) => x.classList.toggle('active', x === el)); }; });
    view.querySelectorAll('[data-suite]').forEach((el) => { el.onclick = () => { sel.suite = el.dataset.suite; view.querySelectorAll('[data-suite]').forEach((x) => x.classList.toggle('active', x === el)); }; });
    $('#go', view).onclick = async () => {
      ctx.runState = {
        clipId: sel.clip, suite: sel.suite, startedAt: Date.now(), runId: null, done: false, error: null,
        variants: SUITES[sel.suite].map((id) => { const v = VARIANTS.find((x) => x.id === id); return { id, label: v.label, family: v.family, what: v.what, phase: 'queued', progress: 0, result: null }; }),
      };
      drawRun(view, ctx);
      try { await window.lab.run({ clipId: sel.clip, suite: sel.suite }); } catch (e) { ctx.runState.error = e.message; drawRun(view, ctx); }
    };
  };
  ctx.redrawCrash = draw;
  draw();
}

function eta(rs) {
  const done = rs.variants.filter((v) => v.phase === 'done' || v.phase === 'error').length;
  if (!done) return 'estimating…';
  const per = (Date.now() - rs.startedAt) / done;
  const left = Math.round((per * (rs.variants.length - done)) / 1000);
  return left < 60 ? `${left} s left` : `about ${Math.round(left / 60)} min left`;
}

function tileHtml(rs, v) {
  const file = v.result?.thumb || `thumbs/${v.id}.jpg`;
  const thumb = rs.runId && (v.phase === 'measure' || v.phase === 'done') ? `<img src="lab://runs/${rs.runId}/${file}">` : '';
  let status;
  if (v.phase === 'queued') status = '<div class="status">Queued</div>';
  else if (v.phase === 'render') status = `<div class="status">Damaging the clip… ${fmt(v.progress * 100)}%</div><div class="prog"><div style="width:${v.progress * 100}%"></div></div>`;
  else if (v.phase === 'measure') status = `<div class="status">SDK measuring… ${fmt(v.progress * 100)}%</div><div class="prog measure"><div style="width:${v.progress * 100}%"></div></div>`;
  else if (v.phase === 'error') status = `<div class="status" style="color:#ff9b98">${esc(v.error || 'Failed')}</div>`;
  else {
    const p = v.result.pulse; const b = v.result.breathing;
    status = `<div class="status num">pulse ${p.stablePct ?? '–'}% stable · ${p.medAbsErr != null ? `median ${p.medAbsErr} bpm off` : 'no reading'}</div>
      <div class="chips">${chip(p.verdict, 'Pulse')}${chip(b.verdict, 'Breath')}</div>`;
  }
  return `<div class="thumb">${thumb}<span class="fam">${esc(FAMILIES[v.family]?.label || v.family)}</span></div>
    <div class="body"><div class="label">${esc(v.label)}</div>${status}</div>`;
}

function drawRun(view, ctx) {
  const rs = ctx.runState;
  const done = rs.variants.filter((v) => v.phase === 'done').length;
  view.innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Crash test · ${esc(rs.suite)} suite${ctx.cfg.mock ? ' · MOCK' : ''}</div>
      <h1 id="run-title">${rs.done ? 'Crash test complete.' : rs.error ? 'Crash test stopped.' : 'Crash test running…'}</h1>
      <p class="muted num" id="run-sub" style="margin-top:6px">${done} of ${rs.variants.length} variants · ${rs.done ? 'done' : eta(rs)}</p></div>
      <span class="spacer"></span>
      ${rs.done ? `<a class="btn primary big" href="#reports?run=${rs.runId}">Open report</a><button class="btn" id="new">New test</button>`
    : rs.error ? '<button class="btn" id="new">Back</button>' : '<button class="btn danger" id="cancel">Cancel</button>'}
    </div>
    ${rs.error ? `<p class="notice err" style="margin-bottom:18px">${esc(rs.error)}</p>` : ''}
    <div class="tiles" id="tiles">${rs.variants.map((v) => `<div class="tile" data-v="${v.id}">${tileHtml(rs, v)}</div>`).join('')}</div>
  </div>`;
  if ($('#cancel', view)) $('#cancel', view).onclick = async () => { if (await confirmModal({ title: 'Cancel the crash test?', body: 'Results so far are kept in the data folder but no report is written.', ok: 'Cancel test', danger: true })) window.lab.cancel(); };
  if ($('#new', view)) $('#new', view).onclick = () => { ctx.runState.dismissed = true; ctx.redrawCrash(); };
}

// Apply a worker event to the run state and patch only the affected tile.
function onEvent(ctx, e, view) {
  const rs = ctx.runState;
  if (!rs) return;
  if (e.type === 'run-start') { rs.runId = e.runId; return; }
  if (e.type === 'variant') {
    const v = rs.variants.find((x) => x.id === e.id);
    if (!v) return;
    if (e.phase === 'render' && v.phase !== 'queued' && v.phase !== 'render') return;
    v.phase = e.phase; v.progress = e.progress || 0;
    if (e.result) v.result = e.result;
    if (e.error) v.error = e.error;
    const el = view && view.querySelector(`[data-v="${e.id}"]`);
    if (el) el.innerHTML = tileHtml(rs, v);
    const sub = view && $('#run-sub', view);
    if (sub) sub.textContent = `${rs.variants.filter((x) => x.phase === 'done').length} of ${rs.variants.length} variants · ${eta(rs)}`;
    return;
  }
  if (e.type === 'run-done') { rs.done = true; rs.summary = e.summary; if (view && $('#tiles', view)) drawRun(view, ctx); toast('Crash test complete'); }
  if (e.type === 'run-error') { rs.error = e.message; if (view && $('#tiles', view)) drawRun(view, ctx); }
}

module.exports = { render, onEvent };
