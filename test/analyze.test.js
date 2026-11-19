'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { analyze, readings } = require('../src/core/analyze');

// 60 s of synthetic readings at 30 per second after a 12 s warm-up.
function series(fn, { conf = 80, from = 12, to = 60, rate = 30 } = {}) {
  const out = [];
  for (let t = 0; t <= to; t += 1 / rate) {
    out.push(t < from ? { t, value: 0, confidence: 0, stable: false } : { t, value: fn(t), confidence: typeof conf === 'function' ? conf(t) : conf, stable: (typeof conf === 'function' ? conf(t) : conf) >= 40 });
  }
  return out;
}
const truth = (t) => 70 + 3 * Math.sin(t / 8);

function variant(id, raw, extra = {}) {
  return { id, label: id, family: extra.family || 'light', level: extra.level ?? 1, expect: 'same', raw: { pulse: raw, breathing: [] }, validation: [], errors: [], mediaSeconds: 60, ...extra };
}

function run(variants) {
  return analyze({ run: { runId: 'r', clipId: 'c', createdAt: 'now', suite: 'test', variants: [variant('original', series(truth), { baseline: true, family: 'control', level: 0 }), ...variants] }, clip: null });
}

test('readings are resampled to two per second whatever the SDK rate', () => {
  const r = readings(series(truth, { rate: 30 }));
  assert.ok(Math.abs(r.length - 97) <= 2, `got ${r.length}`);
});

test('an unchanged copy holds and keeps the stable promise', () => {
  const { summary } = run([variant('copy', series(truth))]);
  const v = summary.variants.find((x) => x.id === 'copy');
  assert.equal(v.pulse.verdict, 'held');
  assert.equal(summary.promise.pulse.pct, 100);
});

test('a drifted but confident copy is "fooled"', () => {
  const { summary } = run([variant('drift', series((t) => truth(t) + 8))]);
  const v = summary.variants.find((x) => x.id === 'drift');
  assert.equal(v.pulse.verdict, 'fooled');
  assert.equal(summary.promise.pulse.pct, 0);
  assert.equal(summary.verdict.blindSpots.length, 1);
});

test('a 4 bpm drift is within two readings\' tolerance: held, but counted as moved', () => {
  const { summary } = run([variant('nudge', series((t) => truth(t) + 4))]);
  const v = summary.variants.find((x) => x.id === 'nudge');
  assert.equal(v.pulse.verdict, 'held');
  assert.equal(summary.promise.pulse.pct, 100);
  assert.equal(summary.promise.pulse.movedPct, 100);
  assert.equal(summary.promise.pulse.tolerance, 6);
  assert.ok(summary.promise.pulse.referenceStable);
});

test('a drifted copy with low confidence is "caught", not fooled', () => {
  const { summary } = run([variant('flagged', series((t) => truth(t) + 8, { conf: 20 }))]);
  assert.equal(summary.variants.find((x) => x.id === 'flagged').pulse.verdict, 'caught');
});

test('speed change: the expected value scales by the factor', () => {
  const k = 1.15;
  const right = variant('fast', series((t) => k * truth(t * k), { to: 60 / k }), { expect: 'scale', factor: k, family: 'speed' });
  const wrong = variant('fast-unscaled', series((t) => truth(t * k), { to: 60 / k }), { expect: 'scale', factor: k, family: 'speed' });
  const { summary } = run([right, wrong]);
  assert.equal(summary.variants.find((x) => x.id === 'fast').pulse.verdict, 'held');
  assert.equal(summary.variants.find((x) => x.id === 'fast-unscaled').pulse.verdict, 'fooled');
});

test('still photo: any sustained stable reading is a phantom', () => {
  const phantom = variant('still', series(() => 75), { expect: 'none', family: 'negative' });
  const quiet = variant('still-quiet', series(() => 75, { conf: 10 }), { expect: 'none', family: 'negative' });
  const { summary } = run([phantom, quiet]);
  assert.equal(summary.variants.find((x) => x.id === 'still').pulse.verdict, 'fooled');
  assert.equal(summary.variants.find((x) => x.id === 'still-quiet').pulse.verdict, 'caught');
  assert.ok(summary.promise.pulse.phantom > 0);
});

test('no readings at all is "refused"', () => {
  const { summary } = run([variant('nothing', [])]);
  assert.equal(summary.variants.find((x) => x.id === 'nothing').pulse.verdict, 'refused');
});

test('headroom finds the first level that stops holding', () => {
  const lv = (level, off, conf) => variant(`light-${level}`, series((t) => truth(t) + off, { conf }), { level, label: `${level} stops darker` });
  const { summary } = run([lv(1, 0, 80), lv(2, 0, 80), lv(3, 9, 80), lv(4, 9, 10)]);
  const h = summary.headroom.find((x) => x.family === 'light');
  assert.equal(h.pulse.lastHeld.level, 2);
  assert.equal(h.pulse.breakAt.level, 3);
  assert.equal(h.pulse.breakAt.verdict, 'fooled');
});

test('the worst-fifth bar crosses the gap exactly when a copy is fooled', () => {
  // 30% of stable readings 10 bpm off, the rest on target.
  const { summary } = run([variant('part', series((t) => truth(t) + ((t * 2) % 10 < 3 ? 10 : 0)))]);
  const v = summary.variants.find((x) => x.id === 'part');
  assert.equal(v.pulse.verdict, 'fooled');
  assert.ok(v.pulse.worstFifth > 6, `worstFifth ${v.pulse.worstFifth}`);
  const ok = run([variant('few', series((t) => truth(t) + ((t * 2) % 10 < 1 ? 10 : 0)))]).summary.variants.find((x) => x.id === 'few');
  assert.equal(ok.pulse.verdict, 'held');
  assert.ok(ok.pulse.worstFifth <= 6, `worstFifth ${ok.pulse.worstFifth}`);
});
