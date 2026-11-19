'use strict';

const { esc, $, $$, chip, fmt, toast, icon, VERDICT } = require('./ui');
const charts = require('./charts');

const GRADE = { ready: 'Ready', fragile: 'Fragile', 'not-ready': 'Not ready' };
const STABLE_CONF = { pulse: 40, breathing: 45 };
const UNIT = { pulse: 'bpm', breathing: 'br/min' };

function barLegend() {
  const it = (k, extra = '') => `<span><i class="bar" style="background:${charts.BAR[k]};${extra}"></i>${VERDICT[k].label}</span>`;
  return `${it('held')}${it('caught')}${it('fooled')}${it('refused', 'border:1px dashed #c9c9c4')}<span><i style="width:16px;height:0;border-radius:0;border-top:2px dashed #9b9ea4"></i>Tolerance</span>`;
}

// Variants where readings drifted while the SDK still marked them stable,
// worst first, plus how the rest split.
function blindSpotsHtml(s, metric) {
  const unit = UNIT[metric];
  const vs = s.variants.filter((v) => !v.baseline);
  const fooled = vs.filter((v) => v[metric].verdict === 'fooled')
    .sort((a, b) => (b.expect === 'none') - (a.expect === 'none') || (b[metric].worstFifth ?? 0) - (a[metric].worstFifth ?? 0));
  const n = (k) => vs.filter((v) => v[metric].verdict === k).length;
  const rows = fooled.slice(0, 5).map((v) => `<div class="blind"><span class="chip fooled"><i>${VERDICT.fooled.icon}</i>${v.expect === 'none' ? `${v[metric].nStable} stable` : `${v[metric].nWrong}/${v[metric].nStable} off`}</span><b title="${esc(v.what)}">${esc(v.label)}</b></div>`).join('');
  return `<div class="card-head">Blind spots<span class="spacer"></span><span class="pill">${metric}</span></div>
    <div class="metric md" style="margin-top:12px">${fooled.length}</div>
    <p class="metric-note">${fooled.length ? `condition${fooled.length === 1 ? '' : 's'} where readings drifted while the SDK still marked them stable` : 'No condition fooled the stable flag.'}</p>
    <div class="list" style="margin-top:10px">${rows}</div>${fooled.length > 5 ? `<p class="faint small" style="margin-top:6px">and ${fooled.length - 5} more</p>` : ''}
    <div class="grow"></div>
    <div class="split"><div><b>${n('held')}</b>${chip('held')}</div><div><b>${n('caught') + n('refused')}</b>${chip('caught')}</div></div>`;
}

// Per condition: of the readings marked stable, how many were within tolerance.
function conditionItems(s, metric) {
  const by = new Map();
  for (const v of s.variants) {
    if (v.baseline || v.expect === 'none') continue;
    const f = by.get(v.family) || { name: v.familyLabel || v.family, label: charts.SHORT[v.family] || v.family, right: 0, stable: 0 };
    f.right += v[metric].nRight || 0;
    f.stable += v[metric].nStable || 0;
    by.set(v.family, f);
  }
  return [...by.values()].map((f) => ({ ...f, value: f.stable ? (100 * f.right) / f.stable : null }));
}

async function render(view, ctx, params) {
  const runId = params.get('run');
  if (!runId) return renderList(view);
  view.innerHTML = '<div class="page"><p class="faint">Loading report…</p></div>';
  const d = await window.lab.runDetail(runId);
  if (!d) { view.innerHTML = '<div class="page"><div class="empty"><h2>Report not found</h2><a class="btn" href="#reports">All reports</a></div></div>'; return; }
  const s = d.summary;
  const pick = params.get('v');
  const st = { metric: 'pulse', selected: s.variants.some((v) => v.id === pick) ? pick : s.variants.find((v) => !v.baseline)?.id, table: false };
  const p = s.promise.pulse; const b = s.promise.breathing;

  view.innerHTML = `<div class="page">
    <div class="page-head"><div style="flex:1;min-width:320px">
      <div class="eyebrow">Crash-test report · ${new Date(s.createdAt).toLocaleString()}${s.mock ? ' · mock data' : ''}</div>
      <h1 style="max-width:24ch">${esc(s.verdict.headline)}</h1>
      <div class="row wrap" style="margin-top:14px"><span class="honest">Informal test · ${s.people} person · ${s.clips} clip · ${s.counts.variants} variants · ${s.counts.readings.toLocaleString()} readings (2 per second)</span>
        ${s.mock ? '<span class="pill mock">Synthetic readings, not the SDK. Do not cite.</span>' : `<span class="pill white">SmartSpectra ${esc(s.sdkVersion || '')}</span>`}</div></div>
      <button class="btn" id="md">${icon('copy')}Copy Markdown</button><button class="btn" id="files">${icon('folder')}Show files</button>
    </div>

    <div class="bento">
      <div class="card c6 r2 fill">
        <div class="card-head"><span class="grade ${s.verdict.grade}">${GRADE[s.verdict.grade]}</span><span>setup verdict for this room and camera</span></div>
        <div style="margin-top:8px">${s.verdict.fixes.length ? s.verdict.fixes.map((f, i) => `<div class="fix"><span class="n">${i + 1}</span><div><b>${esc(f.text)}</b><span>${esc(f.evidence)}</span></div></div>`).join('')
    : '<div class="fix"><span class="n">✓</span><div><b>No fixes needed for the conditions tested.</b><span>Readings held at every first-level change.</span></div></div>'}
        ${s.verdict.notes.map((n) => `<div class="fix"><span class="n warn">!</span><div><span>${esc(n)}</span></div></div>`).join('')}</div>
        <div class="grow"></div>
        <div class="split four">${['held', 'caught', 'fooled', 'refused'].map((k) => `<div><b>${s.variants.filter((v) => !v.baseline && v.pulse.verdict === k).length}</b>${chip(k)}</div>`).join('')}</div>
      </div>
      <div class="card lime c3"><div class="card-head">Pulse · stable-flag check</div>
        <div class="metric" style="margin-top:14px">${p.pct != null ? fmt(p.pct) : '–'}<small>%</small></div>
        <p class="metric-note">Presage documents that a <b>stable</b> pulse reading is within ±${p.promise} bpm, so two stable readings of the same moment can differ by at most ${p.tolerance}. <b class="num">${p.kept}</b> of <b class="num">${p.stable}</b> stable readings on damaged copies stayed within ${p.tolerance} bpm of the clean copy; <b class="num">${p.moved}</b> moved more than ${p.promise}.</p></div>
      <div class="card c3 r2 fill" id="blind"></div>
      <div class="card sky c3"><div class="card-head">Breathing · stable-flag check</div>
        <div class="metric" style="margin-top:14px">${b.pct != null ? fmt(b.pct) : '–'}<small>%</small></div>
        <p class="metric-note">of <b class="num">${b.stable}</b> stable breathing readings stayed within ${b.tolerance} br/min of the clean copy (two ±${b.promise} br/min readings).${p.phantom || b.phantom ? ` Still photo: <b class="num">${p.phantom}</b> stable pulse readings from a picture with no pulse.` : ''}</p></div>
    </div>

    <div class="bento">
      <div class="card c12">
        <div class="card-head"><span class="sq"></span>How far each condition moved the reading<span class="spacer"></span>
          <div class="seg" id="seg"><button data-m="pulse" class="on">Pulse</button><button data-m="breathing">Breathing</button></div></div>
        <p class="faint small">Median distance from the expected value, one bar per damaged copy. Click a bar to see its readings over time.</p>
        <div id="bars" style="margin-top:4px"></div>
        <div class="legend" style="margin-top:4px">${barLegend()}</div>
      </div>
    </div>

    <div class="bento">
      <div class="card c7"><div class="row wrap"><h3>Does confidence catch the fall?</h3><span class="spacer"></span>
        <span class="legend"><span><i style="background:${charts.COLOR.right}"></i>Right and stable</span><span><i style="background:${charts.COLOR['confident-wrong']}"></i>Stable but off</span><span><i style="background:${charts.COLOR.withheld}"></i>Withheld</span></span></div>
        <p class="faint small" style="margin:4px 0 8px">Every reading after warm-up, from every damaged copy. The shaded zone is where the SDK marked a reading stable but it missed the expected value.</p><div id="matrix"></div></div>
      <div class="card c5"><h3>Is higher confidence more often right?</h3><p class="faint small" style="margin:4px 0 8px">Share of readings within tolerance, by confidence band. Faded bars have fewer than 10 readings.</p>
        <div id="calib"></div><div class="legend" id="calib-legend" style="margin-top:6px"></div></div>
    </div>

    <div class="section-title"><h2>Headroom</h2><p>How much of each kind of damage your setup takes before pulse readings stop holding.</p></div>
    <div class="card" id="headroom"></div>

    <div class="section-title"><h2>Every variant</h2><p>Click one to see its readings over time.</p><span class="spacer"></span><button class="btn" id="tbl">Show as table</button></div>
    <div id="variants"></div>
    <div class="card" id="detail" style="margin-top:14px"></div>

    <div class="section-title"><h2>Controls</h2><p>Checks that the method itself behaves.</p></div>
    <div class="grid g3" id="controls"></div>
    <p class="faint small" style="margin-top:28px">Wellness and measurement wording only. This is one person, one clip and one camera: an informal test, not a validation study. It reports what was measured and makes no claim that the SDK is accurate or inaccurate.</p>
  </div>`;

  const pickVariant = (id) => { st.selected = id; drawVariants(); drawDetail(); $('#detail', view).scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };

  const drawCharts = () => {
    const m = st.metric;
    const pts = [];
    for (const ser of d.series) {
      const v = s.variants.find((x) => x.id === ser.id);
      if (!v || v.baseline || v.expect === 'none') continue;
      for (const r of ser[m]) if (r[4] != null) pts.push({ conf: r[2], err: r[1] - r[4], cls: r[5], label: v.label, t: r[0], value: r[1], expected: r[4] });
    }
    charts.variantBars($('#bars', view), s.variants, { metric: m, tol: s.tolerance[m], unit: UNIT[m], onPick: pickVariant });
    charts.trustMatrix($('#matrix', view), pts, { tol: s.tolerance[m], stableConf: STABLE_CONF[m], unit: UNIT[m] });
    charts.calibration($('#calib', view), s.calibration[m], { tol: s.tolerance[m], unit: UNIT[m], stableConf: STABLE_CONF[m] });
    $('#calib-legend', view).innerHTML = `<span><i class="bar" style="background:#111"></i>Marked stable (${STABLE_CONF[m]}+)</span><span><i class="bar" style="background:#d9d9d5"></i>Below the stable threshold</span>`;
    $('#blind', view).innerHTML = blindSpotsHtml(s, m);
  };

  const drawHeadroom = () => {
    const rows = s.headroom.map((h) => {
      const x = h.pulse;
      const levels = x.levels.map((l, i) => `${i ? '<span class="lvl-line"></span>' : ''}<div class="lvl" title="${esc(`${l.label}: ${VERDICT[l.verdict].label}`)}"><span class="dot ${l.verdict}">${VERDICT[l.verdict].icon}</span><small>${esc(l.label)}</small></div>`).join('');
      let text;
      if (!x.breakAt) text = `Held at every level tested, up to <b>${esc(x.lastHeld?.label.toLowerCase() || '')}</b>.`;
      else if (!x.lastHeld) text = `Stopped holding at the first level tested (<b>${esc(x.breakAt.label.toLowerCase())}</b>): ${esc(VERDICT[x.breakAt.verdict].label.toLowerCase())}.`;
      else text = `Held to <b>${esc(x.lastHeld.label.toLowerCase())}</b>; at ${esc(x.breakAt.label.toLowerCase())} the result was ${chip(x.breakAt.verdict)}`;
      return `<div class="headroom-row"><b>${esc(h.label)}</b><div class="levels">${levels}</div><div class="muted small">${text}</div></div>`;
    });
    $('#headroom', view).innerHTML = rows.join('') || '<p class="faint">Run the full suite to see headroom across several levels.</p>';
  };

  const drawVariants = () => {
    const el = $('#variants', view);
    if (st.table) {
      el.innerHTML = `<div class="card" style="overflow-x:auto"><table class="data"><thead><tr><th>Variant</th><th>Pulse</th><th class="num">Stable</th><th class="num">Median error</th><th class="num">Mean conf.</th><th>Breathing</th><th>Top SDK feedback</th></tr></thead><tbody>
        ${s.variants.map((v) => `<tr><td><b>${esc(v.label)}</b><div class="faint small">${esc(v.what)}</div></td><td>${chip(v.pulse.verdict)}</td><td class="num">${v.pulse.stablePct ?? '–'}%</td><td class="num">${v.pulse.medAbsErr ?? '–'}</td><td class="num">${v.pulse.meanConf ?? '–'}</td><td>${chip(v.breathing.verdict)}</td>
          <td class="small muted">${(v.validationTop || []).filter((c) => c.code !== 0).map((c) => `${esc(c.label)} ${c.share}%`).join(', ') || 'OK'}</td></tr>`).join('')}</tbody></table></div>`;
      return;
    }
    el.innerHTML = `<div class="tiles">${s.variants.map((v) => `<div class="tile clickable ${v.id === st.selected ? 'active' : ''}" data-id="${v.id}">
      <div class="thumb">${v.thumb ? `<img src="lab://runs/${s.runId}/${v.thumb}">` : ''}<span class="fam">${esc(v.familyLabel || '')}</span></div>
      <div class="body"><div class="label">${esc(v.label)}</div>
        <div class="status num">${v.expect === 'none' ? `${v.pulse.nStable} stable readings from a photo` : `pulse ${v.pulse.stablePct ?? '–'}% stable · ${v.pulse.medAbsErr != null ? `median ${v.pulse.medAbsErr} bpm off` : 'no reading'}`}</div>
        <div class="chips">${v.baseline ? '<span class="pill">reference</span>' : `${chip(v.pulse.verdict, 'Pulse')}${chip(v.breathing.verdict, 'Breath')}`}</div></div></div>`).join('')}</div>`;
    $$('[data-id]', el).forEach((t) => { t.onclick = () => pickVariant(t.dataset.id); });
  };

  const drawDetail = () => {
    const v = s.variants.find((x) => x.id === st.selected);
    const ser = d.series.find((x) => x.id === st.selected);
    if (!v || !ser) { $('#detail', view).innerHTML = ''; return; }
    const m = st.metric;
    const x = v[m];
    const fb = (v.validationTop || []).map((c) => `${esc(c.label)} <span class="num">${c.share}%</span>`).join(' · ') || 'none';
    const lure = x.lure ? `<p class="muted small" style="margin-top:6px">The flicker ran at <span class="num">${x.lure}</span> ${UNIT[m]}. ${x.lureShare != null ? `<b class="num">${x.lureShare}%</b> of stable readings sat closer to the flicker than to the real value.` : ''}</p>` : '';
    $('#detail', view).innerHTML = `<div class="row" style="align-items:flex-start"><div><div class="faint small">${esc(v.familyLabel)}</div><h2>${esc(v.label)}</h2><p class="muted" style="margin-top:4px">${esc(v.what)}</p>${lure}</div><span class="spacer"></span>${v.baseline ? '<span class="pill">reference clip</span>' : chip(x.verdict, m === 'pulse' ? 'Pulse' : 'Breath')}</div>
      <div class="stats">
        <div><b>${x.n}</b><span>Readings after warm-up</span></div>
        <div><b>${x.stablePct ?? '–'}%</b><span>Marked stable</span></div>
        <div><b>${x.medAbsErr ?? '–'} <small style="font-size:13px">${UNIT[m]}</small></b><span>Median distance from expected</span></div>
        <div><b>${x.nWrong} <small style="font-size:13px">of ${x.nStable}</small></b><span>Stable but off</span></div></div>
      <div id="tl"></div><p class="faint small" style="margin-top:8px">SDK feedback during this variant: ${fb}. Dashed line: expected ${UNIT[m]}; shaded band: ±${s.tolerance[m]}; hollow dots: not marked stable.</p>`;
    charts.timeline($('#tl', view), ser[m], { tol: s.tolerance[m], unit: UNIT[m], stableConf: STABLE_CONF[m], label: v.label });
  };

  const drawControls = () => {
    const cards = [];
    const r = s.repeatability;
    if (r) cards.push(['Same file twice', r.pulse.identical ? 'Identical readings' : `Differed by up to ${r.pulse.maxDiff} bpm`, r.pulse.identical ? 'Replays are deterministic, so differences between variants come from the damage, not chance.' : 'Replays vary a little on their own; this is the noise floor for every comparison.']);
    const mirror = s.variants.find((v) => v.id === 'mirror');
    if (mirror) cards.push(['Mirror image', `${mirror.pulse.medAbsErr ?? '–'} bpm median difference`, 'A face reads the same in a mirror, so this should stay close to zero.']);
    for (const sp of s.variants.filter((v) => v.expect === 'scale')) cards.push([sp.label, `expected ${sp.pulse.medianExpected ?? '–'}, read ${sp.pulse.medianValue ?? '–'} bpm`, `True rates scale by exactly ${sp.factor}×. ${chip(sp.pulse.verdict)}`]);
    if (s.live) cards.push(['Live vs replay', `${s.live.medianDiff} bpm median difference`, `Live camera readings during recording against the replayed file (n=${s.live.n}).`]);
    if (s.reference) cards.push(['Your reference', `${s.reference.pulse} bpm (${esc(s.reference.method)})`, `The clean clip read ${s.baseline?.pulse ?? '–'} bpm, ${s.reference.diff >= 0 ? '+' : ''}${s.reference.diff} bpm from it.`]);
    $('#controls', view).innerHTML = cards.map(([t, big, note]) => `<div class="card tight"><div class="faint small">${esc(t)}</div><div class="num" style="font-size:20px;letter-spacing:-0.02em;margin:6px 0">${esc(big)}</div><div class="muted small">${note}</div></div>`).join('');
  };

  $$('#seg button', view).forEach((bt) => { bt.onclick = () => { st.metric = bt.dataset.m; $$('#seg button', view).forEach((x) => x.classList.toggle('on', x === bt)); drawCharts(); drawDetail(); }; });
  $('#tbl', view).onclick = () => { st.table = !st.table; $('#tbl', view).textContent = st.table ? 'Show as tiles' : 'Show as table'; drawVariants(); };
  $('#md', view).onclick = async () => { await window.lab.reportMd(runId); toast('Markdown report copied to the clipboard'); };
  $('#files', view).onclick = () => window.lab.reveal(runId);

  drawCharts(); drawHeadroom(); drawVariants(); drawDetail(); drawControls();
  if (pick) $('#detail', view).scrollIntoView({ block: 'center' });
}

async function renderList(view) {
  const { runs } = await window.lab.list();
  if (!runs.length) {
    view.innerHTML = '<div class="page"><div class="empty"><h2>No reports yet</h2><p>Run a crash test to get your first report.</p><a class="btn primary big" href="#crash">Crash test</a></div></div>';
    return;
  }
  view.innerHTML = `<div class="page"><div class="page-head"><div><div class="eyebrow">Step 3 · Reports</div><h1>Crash-test reports</h1></div><span class="spacer"></span><a class="btn primary big" href="#crash">New crash test</a></div>
    <div class="card"><div class="list">${runs.map((r) => `<a class="list-item" href="#reports?run=${r.runId}" style="text-decoration:none">
      <span class="grade ${r.verdict.grade}" style="min-width:110px;justify-content:center">${GRADE[r.verdict.grade]}</span>
      <div style="flex:1;min-width:0"><b style="font-weight:550">${esc(r.verdict.headline)}</b><div class="faint small num">${new Date(r.createdAt).toLocaleString()} · ${esc(r.suite)} suite · ${r.counts.variants} variants</div></div>
      ${r.mock ? '<span class="pill mock">mock</span>' : ''}<span class="metric md" style="font-size:30px">${r.promise.pulse.pct != null ? `${fmt(r.promise.pulse.pct)}<small style="font-size:14px">% kept</small>` : '–'}</span></a>`).join('')}</div></div></div>`;
}

module.exports = { render, GRADE, barLegend, blindSpotsHtml, conditionItems };
