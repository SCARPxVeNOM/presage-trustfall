'use strict';

// Small hand-rolled SVG charts. One y-axis per chart, recessive grid, thin
// marks, threshold lines dashed, and a hover tooltip on every plot.

const { esc, tooltip, fmt, VERDICT } = require('./ui');

const COLOR = { right: '#1f9d57', 'confident-wrong': '#f0532d', withheld: '#b4b8bd', line: '#5d6066', conf: '#2f80ed' };
// Outcome colours. Bars that held recede; anything else stands out and
// carries its outcome icon, so colour is never the only cue.
const STATUS = { held: '#1f9d57', caught: '#2f80ed', fooled: '#f0532d', refused: '#8d939b' };
const BAR = { held: '#cfe6d6', caught: '#2f80ed', fooled: '#f0532d', refused: '#ecece8' };
const SHORT = { control: 'Control', speed: 'Speed', light: 'Dim', grain: 'Grain', focus: 'Blur', shake: 'Shake', distance: 'Distance', compress: 'Compress', fps: 'FPS', cover: 'Covered', flicker: 'Flicker', color: 'Grey', negative: 'Photo' };
const NS = 'http://www.w3.org/2000/svg';

function svg(el, w, h) {
  el.innerHTML = '';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${h}`);
  s.setAttribute('class', 'chart');
  s.setAttribute('role', 'img');
  el.appendChild(s);
  return s;
}

// When neighbouring x labels collide, drop every other one onto a second row
// and grow the viewBox to make room.
function stagger(s, labels, w, h) {
  const len = labels.map((n) => (n.getComputedTextLength ? n.getComputedTextLength() : n.textContent.length * 6.5));
  const xs = labels.map((n) => Number(n.getAttribute('x')));
  const clash = xs.some((x, i) => i > 0 && xs[i - 1] + len[i - 1] / 2 + 6 > x - len[i] / 2);
  if (!clash) return;
  labels.forEach((n, i) => { if (i % 2) n.setAttribute('y', Number(n.getAttribute('y')) + 13); });
  s.setAttribute('viewBox', `0 0 ${w} ${h + 13}`);
}

function add(parent, tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  parent.appendChild(n);
  return n;
}

function scale(d0, d1, r0, r1) {
  const f = (x) => r0 + ((x - d0) / (d1 - d0 || 1)) * (r1 - r0);
  f.inv = (y) => d0 + ((y - r0) / (r1 - r0 || 1)) * (d1 - d0);
  return f;
}

function ticks(lo, hi, n = 5) {
  const span = hi - lo;
  const step = [1, 2, 2.5, 5, 10].map((m) => m * 10 ** Math.floor(Math.log10(span / n))).find((s) => span / s <= n) || span / n;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function axes(s, x, y, { xt, yt, w, h, m, xLabel, yLabel, yFmt = (v) => v, xFmt = (v) => v }) {
  const g = add(s, 'g', { class: 'grid' });
  for (const v of yt) add(g, 'line', { x1: m.l, x2: w - m.r, y1: y(v), y2: y(v) });
  const a = add(s, 'g', { class: 'axis' });
  add(a, 'line', { x1: m.l, x2: w - m.r, y1: h - m.b, y2: h - m.b });
  for (const v of xt) add(s, 'text', { x: x(v), y: h - m.b + 16, 'text-anchor': 'middle' }, xFmt(v));
  for (const v of yt) add(s, 'text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, yFmt(v));
  if (xLabel) add(s, 'text', { x: (m.l + w - m.r) / 2, y: h - 4, 'text-anchor': 'middle' }, xLabel);
  if (yLabel) add(s, 'text', { x: 12, y: (m.t + h - m.b) / 2, transform: `rotate(-90 12 ${(m.t + h - m.b) / 2})`, 'text-anchor': 'middle' }, yLabel);
}

// Bar with a rounded top and a square foot on the baseline.
function barPath(cx, bw, top, base, r) {
  const rr = Math.max(0, Math.min(r, bw / 2, base - top));
  return `M${cx - bw / 2},${base} V${top + rr} Q${cx - bw / 2},${top} ${cx - bw / 2 + rr},${top} H${cx + bw / 2 - rr} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + rr} V${base} Z`;
}

// Nearest-point hover over a whole plot area.
function hover(s, pts, html, { r = 14 } = {}) {
  const ring = add(s, 'circle', { r: 7, fill: 'none', stroke: '#111', 'stroke-width': 2, visibility: 'hidden' });
  s.addEventListener('mousemove', (ev) => {
    const box = s.getBoundingClientRect();
    const vb = s.viewBox.baseVal;
    const mx = ((ev.clientX - box.left) / box.width) * vb.width;
    const my = ((ev.clientY - box.top) / box.height) * vb.height;
    let best = null; let bd = r * r;
    for (const p of pts) {
      const d = (p.px - mx) ** 2 + (p.py - my) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) { ring.setAttribute('visibility', 'hidden'); tooltip(null); return; }
    ring.setAttribute('cx', best.px); ring.setAttribute('cy', best.py); ring.setAttribute('visibility', 'visible');
    tooltip(html(best), ev);
  });
  s.addEventListener('mouseleave', () => { ring.setAttribute('visibility', 'hidden'); tooltip(null); });
}

// Column hover for bar-like charts: the whole column is the hit target.
function hoverColumns(s, cols, slot, html, onPick) {
  const vb = () => s.viewBox.baseVal;
  const pick = (ev) => {
    const box = s.getBoundingClientRect();
    const mx = ((ev.clientX - box.left) / box.width) * vb().width;
    return cols.find((c) => Math.abs(c.px - mx) <= slot / 2) || null;
  };
  s.addEventListener('mousemove', (ev) => {
    const c = pick(ev);
    for (const x of cols) x.hl.setAttribute('visibility', x === c ? 'visible' : 'hidden');
    s.style.cursor = c && onPick ? 'pointer' : 'default';
    tooltip(c ? html(c) : null, ev);
  });
  s.addEventListener('mouseleave', () => { for (const x of cols) x.hl.setAttribute('visibility', 'hidden'); tooltip(null); });
  if (onPick) s.addEventListener('click', (ev) => { const c = pick(ev); if (c) { tooltip(null); onPick(c); } });
}

const CLS_LABEL = { right: 'Right and stable', 'confident-wrong': 'Stable but off', withheld: 'Not stable (withheld)' };

// One bar per damaged variant: how far its readings sat from the expected
// value, grouped by condition, with the tolerance as a dashed line.
function variantBars(el, variants, { metric, tol, unit, onPick }) {
  const vs = variants.filter((v) => !v.baseline && v.expect !== 'none');
  if (!vs.length) { el.innerHTML = '<p class="faint small">No damaged variants in this run.</p>'; return; }
  const w = Math.max(360, el.clientWidth || 760);
  const h = Math.max(250, Math.min(440, el.clientHeight || 270));
  const m = { l: 34, r: 6, t: 46, b: 30 };
  const s = svg(el, w, h);
  const errs = vs.map((v) => v[metric].worstFifth).filter((e) => e != null);
  const yMax = Math.min(tol * 8, Math.max(tol * 2.5, ...errs) * 1.1);
  const y = scale(0, yMax, h - m.b, m.t);
  const base = h - m.b;
  const groups = [];
  for (const v of vs) {
    const g = groups[groups.length - 1];
    if (g && g.family === v.family) g.items.push(v); else groups.push({ family: v.family, items: [v] });
  }
  const gap = 0.8;
  const slot = (w - m.l - m.r) / (vs.length + gap * (groups.length - 1));
  const bw = Math.max(5, Math.min(22, slot * 0.62));
  const ir = Math.max(5, Math.min(8, slot * 0.42));

  const grid = add(s, 'g', { class: 'grid' });
  for (const t of ticks(0, yMax, 4)) {
    add(grid, 'line', { x1: m.l, x2: w - m.r, y1: y(t), y2: y(t) });
    add(s, 'text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, fmt(t, t % 1 ? 1 : 0));
  }
  add(s, 'text', { x: 0, y: m.t - 30 }, `${unit} off, worst fifth of stable readings`);

  const worst = vs.filter((v) => v[metric].verdict === 'fooled' && v[metric].worstFifth != null).sort((a, b) => b[metric].worstFifth - a[metric].worstFifth)[0];
  const cols = [];
  const labels = [];
  let i = 0;
  groups.forEach((g, gi) => {
    g.items.forEach((v, k) => {
      const cx = m.l + slot * (i + k + gap * gi + 0.5);
      const hl = add(s, 'rect', { x: cx - slot / 2 + 1, y: m.t - 24, width: slot - 2, height: base - m.t + 24, rx: Math.min(10, slot / 2), fill: '#f2f2ef', visibility: 'hidden' });
      cols.push({ px: cx, v, hl });
    });
    labels.push(add(s, 'text', { x: m.l + slot * (i + gap * gi + g.items.length / 2), y: base + 19, 'text-anchor': 'middle' }, SHORT[g.family] || g.family));
    i += g.items.length;
  });
  stagger(s, labels, w, h);
  add(s, 'line', { class: 'thresh', x1: m.l, x2: w - m.r, y1: y(tol), y2: y(tol) });
  add(s, 'text', { x: m.l + 4, y: y(tol) - 6, class: 'ink' }, `±${tol} ${unit}`);

  for (const c of cols) {
    const x = c.v[metric];
    const e = x.worstFifth;
    const vd = x.verdict || 'refused';
    const top = e == null ? base - 8 : Math.min(base - 3, y(Math.min(e, yMax)));
    add(s, 'path', { d: barPath(c.px, bw, top, base, 7), fill: BAR[vd], ...(e == null ? { stroke: '#c9c9c4', 'stroke-dasharray': '3 2' } : {}) });
    if (vd !== 'held') {
      const iy = top - ir - 5;
      add(s, 'circle', { cx: c.px, cy: iy, r: ir, fill: STATUS[vd], stroke: '#fff', 'stroke-width': 1.5 });
      add(s, 'text', { x: c.px, y: iy + ir * 0.42, 'text-anchor': 'middle', class: 'glyph', style: `font-size:${(ir * 1.25).toFixed(1)}px` }, VERDICT[vd].icon);
      if (c.v === worst) add(s, 'text', { x: c.px, y: iy - ir - 6, 'text-anchor': 'middle', class: 'callout' }, `${fmt(e, 1)} ${unit} off`);
    }
  }
  hoverColumns(s, cols, slot, (c) => {
    const x = c.v[metric];
    return `<b>${esc(c.v.label)}</b>${esc(VERDICT[x.verdict || 'refused'].label)}<br>Worst fifth of stable readings <span class="num">${fmt(x.worstFifth, 1)}</span> ${unit} off · median <span class="num">${fmt(x.medAbsErr, 1)}</span><br><span class="num">${x.stablePct ?? '–'}%</span> marked stable · <span class="num">${x.nWrong ?? 0}</span> of <span class="num">${x.nStable ?? 0}</span> stable readings off${onPick ? '<br><i>Click for readings over time</i>' : ''}`;
  }, onPick ? (c) => onPick(c.v.id) : null);
}

// Per condition: when the SDK said "stable", how often was it right? One dot
// per condition on a full-height track.
function lollipops(el, items, { unit, tol }) {
  const w = Math.max(320, el.clientWidth || 420); const h = 240; const m = { l: 40, r: 8, t: 40, b: 30 };
  const s = svg(el, w, h);
  const y = scale(0, 100, h - m.b, m.t);
  const slot = (w - m.l - m.r) / items.length;
  for (const t of [0, 50, 100]) add(s, 'text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, `${t}%`);
  const low = items.filter((it) => it.value != null).sort((a, b) => a.value - b.value)[0];
  const pts = [];
  const labels = [];
  items.forEach((it, i) => {
    const cx = m.l + slot * (i + 0.5);
    add(s, 'line', { x1: cx, x2: cx, y1: y(0), y2: y(100), stroke: '#ededea', 'stroke-width': 2, 'stroke-linecap': 'round' });
    labels.push(add(s, 'text', { x: cx, y: h - 10, 'text-anchor': 'middle' }, it.label));
    if (it.value == null) { add(s, 'text', { x: cx, y: y(50) + 4, 'text-anchor': 'middle' }, '–'); return; }
    add(s, 'line', { x1: cx, x2: cx, y1: y(0), y2: y(it.value), stroke: '#cfcfca', 'stroke-width': 2, 'stroke-linecap': 'round' });
    add(s, 'circle', { cx, cy: y(it.value), r: 7, fill: '#d7f36b', stroke: '#111', 'stroke-width': 1.5 });
    pts.push({ px: cx, py: y(it.value), it });
  });
  stagger(s, labels, w, h);
  if (low && low.value < 100) {
    const p = pts.find((x) => x.it === low);
    const label = `${fmt(low.value)}% right`;
    const bw = label.length * 6.4 + 16;
    const bx = Math.max(2, Math.min(w - bw - 2, p.px - bw / 2));
    const by = 4;
    add(s, 'rect', { x: bx, y: by, width: bw, height: 20, rx: 10, fill: '#d7f36b' });
    add(s, 'text', { x: bx + bw / 2, y: by + 14, 'text-anchor': 'middle', class: 'ink' }, label);
  }
  hover(s, pts, (p) => `<b>${esc(p.it.name)}</b><span class="num">${p.it.right}</span> of <span class="num">${p.it.stable}</span> stable readings within ±${tol} ${unit}`, { r: 30 });
}

// Every reading: SDK confidence (x) against how far it was from the expected
// value (y). The top-right zone is where the SDK vouched for a wrong number.
function trustMatrix(el, points, { tol, stableConf, unit }) {
  const w = 620; const h = 360; const m = { l: 50, r: 18, t: 18, b: 42 };
  const yMax = tol * 6;
  const s = svg(el, w, h);
  const x = scale(0, 100, m.l, w - m.r);
  const y = scale(0, yMax, h - m.b, m.t);
  add(s, 'rect', { class: 'zone-off', x: x(stableConf), y: y(yMax), width: x(100) - x(stableConf), height: y(tol) - y(yMax), rx: 10 });
  axes(s, x, y, { xt: [0, 20, 40, 60, 80, 100], yt: ticks(0, yMax, 6), w, h, m, xLabel: 'SDK confidence', yLabel: `Distance from expected (${unit})` });
  add(s, 'line', { class: 'thresh', x1: x(stableConf), x2: x(stableConf), y1: m.t, y2: h - m.b });
  add(s, 'line', { class: 'thresh', x1: m.l, x2: w - m.r, y1: y(tol), y2: y(tol) });

  const pts = [];
  const g = add(s, 'g');
  // Draw withheld first so the coloured points sit on top.
  const order = { withheld: 0, right: 1, 'confident-wrong': 2 };
  for (const p of [...points].sort((a, b) => order[a.cls] - order[b.cls])) {
    const e = Math.min(Math.abs(p.err), yMax);
    const px = x(p.conf); const py = y(e);
    const capped = Math.abs(p.err) > yMax;
    if (capped) add(g, 'path', { d: `M${px - 4},${py + 4} L${px},${py - 3} L${px + 4},${py + 4} Z`, fill: COLOR[p.cls], stroke: '#fff', 'stroke-width': 1 });
    else add(g, 'circle', { cx: px, cy: py, r: 3.4, fill: COLOR[p.cls], 'fill-opacity': p.cls === 'withheld' ? 0.6 : 0.9, stroke: '#fff', 'stroke-width': 1 });
    pts.push({ ...p, px, py });
  }
  // Labels go on top of the points, with a halo so they stay readable.
  add(s, 'text', { class: 'halo', x: x(stableConf) + 6, y: m.t + 36 }, `stable at ${stableConf}+`);
  add(s, 'text', { class: 'halo', x: w - m.r - 10, y: y(tol) - 6, 'text-anchor': 'end' }, `±${tol} ${unit}`);
  add(s, 'text', { class: 'zone-label halo', x: w - m.r - 10, y: m.t + 18, 'text-anchor': 'end', style: 'fill:#b0321a' }, 'Stable but off');
  add(s, 'text', { class: 'zone-label halo', x: w - m.r - 10, y: h - m.b - 8, 'text-anchor': 'end', style: 'fill:#14673a' }, 'Right and stable');
  add(s, 'text', { class: 'zone-label halo', x: m.l + 8, y: m.t + 18, style: 'fill:#7b7f86' }, 'Withheld');
  hover(s, pts, (p) => `<b>${esc(p.label)}</b>${esc(CLS_LABEL[p.cls])}<br>At ${fmt(p.t, 1)} s: read <span class="num">${fmt(p.value, 1)}</span>, expected <span class="num">${fmt(p.expected, 1)}</span> ${unit}<br>Confidence <span class="num">${fmt(p.conf, 0)}</span>`);
}

// Share of readings within tolerance, by confidence band. Bands the SDK
// marks stable are dark; bands below the threshold are grey.
function calibration(el, bins, { tol, unit, stableConf }) {
  const w = 460; const h = 300; const m = { l: 46, r: 12, t: 30, b: 42 };
  const s = svg(el, w, h);
  const band = (w - m.l - m.r) / bins.length;
  const y = scale(0, 100, h - m.b, m.t);
  const x = (i) => m.l + band * i + band / 2;
  axes(s, (v) => v, y, { xt: [], yt: [0, 25, 50, 75, 100], w, h, m, yFmt: (v) => `${v}%`, xLabel: 'SDK confidence band' });
  const pts = [];
  bins.forEach((b, i) => {
    const cx = x(i);
    add(s, 'text', { x: cx, y: h - m.b + 16, 'text-anchor': 'middle' }, `${b.lo}–${b.hi}`);
    if (b.lo === stableConf) add(s, 'line', { class: 'thresh', x1: m.l + band * i, x2: m.l + band * i, y1: m.t - 10, y2: h - m.b });
    if (!b.n) { add(s, 'text', { x: cx, y: h - m.b - 8, 'text-anchor': 'middle' }, 'none'); return; }
    const bw = Math.min(44, band - 18);
    const top = y(b.pct);
    add(s, 'path', { d: barPath(cx, bw, top, h - m.b, 12), fill: b.lo >= stableConf ? '#111' : '#d9d9d5', 'fill-opacity': b.n < 10 ? 0.4 : 1 });
    add(s, 'text', { x: cx, y: top - 7, 'text-anchor': 'middle', class: 'ink' }, `${fmt(b.pct)}%`);
    pts.push({ px: cx, py: top, b });
  });
  add(s, 'text', { x: m.l, y: 12 }, `Share within ±${tol} ${unit}`);
  hover(s, pts, (p) => `<b>Confidence ${p.b.lo}–${p.b.hi}</b><span class="num">${p.b.within}</span> of <span class="num">${p.b.n}</span> readings within ±${tol} ${unit}${p.b.n < 10 ? '<br><i>Few readings: treat with care</i>' : ''}`, { r: 40 });
}

// One variant over time: readings against the expected band, and confidence
// on its own chart underneath (never a second y-axis).
function timeline(el, rows, { tol, unit, stableConf, label }) {
  const w = Math.max(480, el.clientWidth || 860); const h1 = 230; const h2 = 120; const m = { l: 50, r: 16, t: 14, b: 30 };
  el.innerHTML = '<div data-a></div><div data-b></div>';
  const T = Math.max(10, ...rows.map((r) => r[0]));
  const vals = rows.flatMap((r) => [r[1], r[4]]).filter((v) => v != null && v > 0);
  if (!vals.length) { el.innerHTML = '<p class="faint small">No readings after warm-up.</p>'; return; }
  const lo = Math.floor(Math.min(...vals) - tol * 1.5); const hi = Math.ceil(Math.max(...vals) + tol * 1.5);
  const sa = svg(el.querySelector('[data-a]'), w, h1);
  const x = scale(0, T, m.l, w - m.r);
  const y = scale(lo, hi, h1 - m.b, m.t);
  axes(sa, x, y, { xt: ticks(0, T, 8), yt: ticks(lo, hi, 5), w, h: h1, m, yLabel: unit, xFmt: (v) => `${v}s` });
  const exp = rows.filter((r) => r[4] != null);
  if (exp.length) {
    const up = exp.map((r) => `${x(r[0])},${y(r[4] + tol)}`).join(' ');
    const dn = [...exp].reverse().map((r) => `${x(r[0])},${y(r[4] - tol)}`).join(' ');
    add(sa, 'polygon', { points: `${up} ${dn}`, fill: 'rgba(17,17,17,0.05)' });
    add(sa, 'polyline', { points: exp.map((r) => `${x(r[0])},${y(r[4])}`).join(' '), fill: 'none', stroke: COLOR.line, 'stroke-width': 1.5, 'stroke-dasharray': '5 4' });
  }
  const pts = [];
  for (const r of rows) {
    const px = x(r[0]); const py = y(r[1]);
    add(sa, 'circle', { cx: px, cy: py, r: 3.2, fill: r[5] === 'withheld' ? '#fff' : COLOR[r[5]], stroke: r[5] === 'withheld' ? '#9b9ea4' : '#fff', 'stroke-width': r[5] === 'withheld' ? 1.3 : 1 });
    pts.push({ px, py, r });
  }
  hover(sa, pts, (p) => `<b>${esc(label)} · ${fmt(p.r[0], 1)} s</b>Read <span class="num">${fmt(p.r[1], 1)}</span> ${unit}${p.r[4] != null ? `, expected <span class="num">${fmt(p.r[4], 1)}</span>` : ''}<br>Confidence <span class="num">${fmt(p.r[2])}</span> · ${esc(CLS_LABEL[p.r[5]])}`);

  const sb = svg(el.querySelector('[data-b]'), w, h2);
  const y2 = scale(0, 100, h2 - m.b, m.t);
  axes(sb, x, y2, { xt: ticks(0, T, 8), yt: [0, 50, 100], w, h: h2, m, yLabel: 'conf.', xFmt: (v) => `${v}s` });
  add(sb, 'line', { class: 'thresh', x1: m.l, x2: w - m.r, y1: y2(stableConf), y2: y2(stableConf) });
  add(sb, 'polyline', { points: rows.map((r) => `${x(r[0])},${y2(r[2])}`).join(' '), fill: 'none', stroke: COLOR.conf, 'stroke-width': 2, 'stroke-linejoin': 'round' });
  hover(sb, rows.map((r) => ({ px: x(r[0]), py: y2(r[2]), r })), (p) => `<b>${fmt(p.r[0], 1)} s</b>Confidence <span class="num">${fmt(p.r[2])}</span>${p.r[3] ? ' · stable' : ''}`);
}

module.exports = { trustMatrix, calibration, timeline, variantBars, lollipops, COLOR, STATUS, BAR, SHORT };
