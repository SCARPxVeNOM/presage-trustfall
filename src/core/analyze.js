'use strict';

// Turns raw readings from every variant into the crash-test report.
//
// The yardstick is the SDK's own published contract (Data Types reference):
//   pulse      stable=true  <=>  confidence >= 40  <=>  within +/-3 bpm
//   breathing  stable=true  <=>  confidence >= 45  <=>  within +/-1 br/min
// "Expected" comes from the original clip: identical for most variants,
// scaled by a known factor for the speed variants, and "no reading" for the
// frozen-frame controls. The original's reading is itself an SDK estimate
// that may be up to +/-3 bpm from the truth, so two stable readings of the
// same moment can honestly differ by up to 6 bpm. A reading only counts as
// off when the gap is bigger than that: then at least one of the two broke
// the SDK's promise. Each reading is classed as
//   right            stable and within that gap of the expected value
//   confident-wrong  stable but outside it (the SDK vouched for it)
//   withheld         not stable (the SDK did not vouch for it)
// Stable readings more than +/-3 bpm from the original are also counted as
// "moved": a consistency signal, not proof of an error.

const { FAMILIES } = require('./suite');

const METRICS = ['pulse', 'breathing'];
const TOL = { pulse: 3, breathing: 1 };
// Largest gap between two stable readings that both keep the promise.
const GAP = { pulse: 2 * TOL.pulse, breathing: 2 * TOL.breathing };
const RANGE = { pulse: [40, 110], breathing: [5, 40] };
const UNIT = { pulse: 'bpm', breathing: 'br/min' };

const VALIDATION = {
  0: 'OK', 1: 'No face found', 2: 'Multiple faces', 3: 'Face not centred', 4: 'Face size out of range',
  5: 'Too dark', 6: 'Too bright', 7: 'Chest not visible', 10: 'Camera tuning', 11: 'Frame rate too low',
  12: 'Excessive motion', 13: 'Face too close', 14: 'Face too far', 15: 'Face too high', 16: 'Face too low',
  17: 'Face not forward',
};

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (a, b) => (b ? (100 * a) / b : null);
const round = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// Readings after warm-up, resampled to at most one every half second so the
// counts mean "half-seconds of output" whatever rate the SDK emits at.
const SLOT = 0.5;
function readings(samples) {
  const out = [];
  let slot = -1;
  for (const s of samples || []) {
    if (!(s.confidence > 0 && Number.isFinite(s.value) && s.value > 0)) continue;
    const k = Math.floor(s.t / SLOT);
    if (k === slot) continue;
    slot = k;
    out.push(s);
  }
  return out;
}

// Reference curve from the original clip: stable readings if there are
// enough of them, otherwise every reading the SDK produced after warm-up.
function referenceCurve(samples) {
  const r = readings(samples);
  const stable = r.filter((s) => s.stable);
  const stableOnly = stable.length >= Math.max(5, r.length * 0.5);
  const curve = (stableOnly ? stable : r).map((s) => ({ t: s.t, value: s.value }));
  curve.stableOnly = stableOnly;
  return curve;
}

function interp(curve, t) {
  if (!curve.length) return null;
  if (t <= curve[0].t) return curve[0].value;
  if (t >= curve[curve.length - 1].t) return curve[curve.length - 1].value;
  let lo = 0; let hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = curve[lo]; const b = curve[hi];
  const f = (t - a.t) / (b.t - a.t || 1);
  return a.value + f * (b.value - a.value);
}

function expectedFor(variant, metric, curve, t) {
  if (variant.expect === 'none') return null;
  const k = variant.expect === 'scale' ? variant.factor : 1;
  const base = interp(curve, t * k);
  return base == null ? null : base * k;
}

function classify(variant, metric, samples, curve) {
  const out = [];
  for (const s of readings(samples)) {
    const expected = expectedFor(variant, metric, curve, s.t);
    const [lo, hi] = RANGE[metric];
    const outOfRange = expected != null && (expected < lo || expected > hi);
    let error = null; let within = false; let moved = false; let bound = null;
    if (variant.expect === 'none') { within = false; moved = true; }
    else if (expected != null) {
      // The original's own +/-tolerance scales with the speed factor.
      const k = variant.expect === 'scale' ? variant.factor : 1;
      error = s.value - expected;
      bound = TOL[metric] * (1 + k);
      within = Math.abs(error) <= bound;
      moved = Math.abs(error) > TOL[metric];
    }
    const cls = !s.stable ? 'withheld' : within ? 'right' : 'confident-wrong';
    out.push({ t: s.t, value: s.value, confidence: s.confidence, stable: s.stable, expected, error, bound, within, moved, cls, outOfRange });
  }
  return out;
}

function summarise(variant, metric, cls, raw, ctx) {
  const scored = cls.filter((s) => !s.outOfRange);
  const n = scored.length;
  const stable = scored.filter((s) => s.stable);
  const wrong = stable.filter((s) => s.cls === 'confident-wrong');
  const moved = stable.filter((s) => s.moved);
  const errs = scored.filter((s) => s.error != null).map((s) => Math.abs(s.error));
  const errsStable = stable.filter((s) => s.error != null).map((s) => Math.abs(s.error));
  const lure = metric === 'pulse' ? variant.lure?.(ctx) : variant.lureBreathing?.(ctx);
  let lureShare = null;
  if (lure && stable.length) {
    const lured = stable.filter((s) => Math.abs(s.value - lure) < Math.abs(s.value - s.expected));
    lureShare = pct(lured.length, stable.length);
  }

  // How far off the worst fifth of stable readings were, on the GAP scale
  // (speed copies are rescaled by their own bound). This crosses GAP exactly
  // when the variant counts as fooled below, so a bar chart of it agrees with
  // the verdicts.
  const norm = stable.filter((s) => s.bound).map((s) => (Math.abs(s.error) * GAP[metric]) / s.bound).sort((a, b) => a - b);
  const worstFifth = norm.length ? norm[Math.max(0, norm.length - 1 - Math.max(Math.floor(0.2 * norm.length), 5))] : null;

  let verdict;
  const wrongFrac = stable.length ? wrong.length / stable.length : 0;
  if (n === 0) verdict = 'refused';
  // "Fooled" needs at least 3 seconds (6 half-second slots) of vouched-for
  // readings that are off, so a single blip does not count.
  else if (variant.expect === 'none') verdict = stable.length >= 6 ? 'fooled' : 'caught';
  else if (wrong.length >= 6 && wrongFrac > 0.2) verdict = 'fooled';
  else if (stable.length / n >= 0.5) verdict = 'held';
  else verdict = 'caught';

  return {
    n,
    raw: (raw || []).length,
    nStable: stable.length,
    nRight: stable.length - wrong.length,
    nWrong: wrong.length,
    stablePct: round(pct(stable.length, n)),
    wrongPct: round(pct(wrong.length, stable.length)),
    nMoved: moved.length,
    movedPct: round(pct(moved.length, stable.length)),
    medianValue: round(median(scored.map((s) => s.value))),
    medianExpected: round(median(scored.filter((s) => s.expected != null).map((s) => s.expected))),
    medAbsErr: round(median(errs)),
    worstFifth: round(worstFifth),
    medAbsErrStable: round(median(errsStable)),
    meanConf: round(mean(scored.map((s) => s.confidence))),
    lure: round(lure),
    lureShare: round(lureShare),
    outOfRange: cls.length - n,
    verdict,
  };
}

function validationShares(events, seconds) {
  if (!events?.length) return [];
  const end = seconds || events[events.length - 1].t + 1;
  const acc = {};
  events.forEach((e, i) => {
    const until = i + 1 < events.length ? events[i + 1].t : end;
    const dur = Math.max(0, until - Math.max(0, e.t));
    if (!acc[e.code]) acc[e.code] = { code: e.code, label: VALIDATION[e.code] || `Code ${e.code}`, hint: e.hint, seconds: 0 };
    acc[e.code].seconds += dur;
  });
  const total = Object.values(acc).reduce((a, b) => a + b.seconds, 0) || 1;
  return Object.values(acc)
    .map((v) => ({ ...v, share: round((100 * v.seconds) / total), seconds: round(v.seconds) }))
    .sort((a, b) => b.share - a.share);
}

function calibration(variants, metric) {
  const bins = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 101]];
  return bins.map(([lo, hi]) => {
    let n = 0; let within = 0;
    for (const v of variants) {
      if (v.baseline || v.expect === 'none') continue;
      for (const s of v.classified[metric]) {
        if (s.outOfRange || s.expected == null) continue;
        if (s.confidence >= lo && s.confidence < hi) { n += 1; if (s.within) within += 1; }
      }
    }
    return { lo, hi: Math.min(hi, 100), n, within, pct: round(pct(within, n)) };
  });
}

function promise(variants, metric, curve) {
  let stable = 0; let kept = 0; let phantom = 0; let moved = 0;
  const byFamily = {};
  for (const v of variants) {
    if (v.baseline) continue;
    for (const s of v.classified[metric]) {
      if (!s.stable || s.outOfRange) continue;
      if (v.expect === 'none') { phantom += 1; continue; }
      stable += 1;
      if (s.within) kept += 1;
      if (s.moved) moved += 1;
      byFamily[v.family] = byFamily[v.family] || { stable: 0, kept: 0 };
      byFamily[v.family].stable += 1;
      if (s.within) byFamily[v.family].kept += 1;
    }
  }
  return {
    tolerance: GAP[metric],
    promise: TOL[metric],
    unit: UNIT[metric],
    stable,
    kept,
    pct: round(pct(kept, stable)),
    moved,
    movedPct: round(pct(moved, stable)),
    // The gap argument needs a reference built from stable readings.
    referenceStable: !!curve?.stableOnly,
    phantom,
    byFamily: Object.entries(byFamily).map(([family, f]) => ({ family, label: FAMILIES[family]?.label, ...f, pct: round(pct(f.kept, f.stable)) })),
  };
}

function headroom(variants) {
  const out = [];
  for (const [family, meta] of Object.entries(FAMILIES)) {
    const levels = variants.filter((v) => v.family === family && v.level > 0).sort((a, b) => a.level - b.level);
    if (levels.length < 1 || ['control', 'speed', 'negative', 'color', 'flicker', 'cover'].includes(family)) continue;
    const per = {};
    for (const metric of METRICS) {
      let lastHeld = null; let breakAt = null;
      for (const v of levels) {
        if (v[metric].verdict === 'held') { if (!breakAt) lastHeld = v; } else if (!breakAt) breakAt = v;
      }
      per[metric] = {
        lastHeld: lastHeld ? { id: lastHeld.id, label: lastHeld.label, level: lastHeld.level } : null,
        breakAt: breakAt ? { id: breakAt.id, label: breakAt.label, level: breakAt.level, verdict: breakAt[metric].verdict } : null,
        levels: levels.map((v) => ({ id: v.id, label: v.label, level: v.level, value: v.value, verdict: v[metric].verdict, stablePct: v[metric].stablePct, medAbsErr: v[metric].medAbsErr })),
      };
    }
    out.push({ family, label: meta.label, unit: meta.unit, tested: levels.length, ...per });
  }
  return out;
}

function repeatability(variants) {
  const a = variants.find((v) => v.id === 'original');
  const b = variants.find((v) => v.id === 'repeat');
  if (!a || !b) return null;
  const res = {};
  for (const metric of METRICS) {
    const A = a.raw[metric] || []; const B = b.raw[metric] || [];
    let maxDiff = 0; let matched = 0;
    for (const s of B) {
      const m = A.find((x) => Math.abs(x.t - s.t) < 0.02);
      if (!m) continue;
      matched += 1;
      maxDiff = Math.max(maxDiff, Math.abs(m.value - s.value));
    }
    res[metric] = { matched, of: B.length, countA: A.length, maxDiff: round(maxDiff, 3), identical: matched === B.length && A.length === B.length && maxDiff < 1e-6 };
  }
  return res;
}

function liveVsReplay(clip, original) {
  const live = clip?.live?.pulse;
  if (!live?.length || !original) return null;
  const replay = referenceCurve(original.raw.pulse);
  const diffs = readings(live).filter((s) => s.stable).map((s) => Math.abs(s.value - interp(replay, s.t))).filter(Number.isFinite);
  if (!diffs.length) return null;
  return { n: diffs.length, medianDiff: round(median(diffs)), maxDiff: round(Math.max(...diffs)) };
}

function verdict(summary, variants) {
  const original = variants.find((v) => v.baseline);
  const fixes = [];
  const notes = [];
  const blindSpots = variants
    .filter((v) => !v.baseline && METRICS.some((m) => v[m].verdict === 'fooled'))
    .map((v) => ({ id: v.id, label: v.label, family: v.family, metrics: METRICS.filter((m) => v[m].verdict === 'fooled'),
      wrongPct: v.pulse.verdict === 'fooled' ? v.pulse.wrongPct : v.breathing.wrongPct }));

  const pStable = original?.pulse.stablePct ?? 0;
  const issues = (original?.validationTop || []).filter((c) => c.code !== 0 && c.code !== 10 && c.share >= 10);
  if (pStable < 60) {
    for (const c of issues) fixes.push({ family: null, text: c.hint || c.label, evidence: `The SDK reported "${c.label}" for ${c.share}% of your clean clip.` });
    if (!issues.length) fixes.push({ family: null, text: 'Sit still, face the camera, and make sure your face is evenly lit.', evidence: `Only ${pStable}% of pulse readings on your clean clip were marked stable.` });
  }

  let fragile = 0;
  for (const h of summary.headroom) {
    const p = h.pulse;
    const advice = FAMILIES[h.family]?.advice;
    if (!advice || !p.breakAt) continue;
    if (p.breakAt.level <= 2) {
      fragile += ['light', 'shake', 'distance'].includes(h.family) ? 1 : 0;
      const held = p.lastHeld ? `held at ${p.lastHeld.label.toLowerCase()} but ` : '';
      const how = p.breakAt.verdict === 'fooled' ? 'drifted while still marked stable' : p.breakAt.verdict === 'refused' ? 'stopped altogether' : 'lost their stable rating';
      fixes.push({ family: h.family, text: advice, evidence: `Pulse readings ${held}${how} at ${p.breakAt.label.toLowerCase()}.` });
    }
  }

  let grade; let headline;
  if (pStable < 60) {
    grade = 'not-ready';
    headline = 'Your clean clip did not give steady readings, so fix the basics first.';
  } else if (fragile > 0) {
    grade = 'fragile';
    headline = 'Your setup works, but it has little room for error.';
  } else {
    grade = 'ready';
    headline = 'Your setup works, with room to spare.';
  }
  if (blindSpots.length) {
    const onlyBreathing = blindSpots.filter((b) => !b.metrics.includes('pulse')).length;
    notes.push(`In ${blindSpots.length} condition${blindSpots.length > 1 ? 's' : ''} the readings drifted more than two readings' tolerance while the SDK still marked them stable${onlyBreathing ? ` (${onlyBreathing} of them for breathing only)` : ''}. Its confidence score cannot warn you there, so avoid those conditions yourself.`);
  }
  return { grade, headline, fixes: fixes.slice(0, 4), blindSpots, notes };
}

function analyze({ run, clip }) {
  const original = run.variants.find((v) => v.baseline) || run.variants.find((v) => v.id === 'original');
  const curves = {};
  for (const metric of METRICS) curves[metric] = original ? referenceCurve(original.raw[metric]) : [];
  const ctx = run.ctx || {};

  const variants = run.variants.map((v) => {
    const out = { ...v, classified: {} };
    for (const metric of METRICS) {
      out.classified[metric] = classify(v, metric, v.raw[metric], curves[metric]);
      out[metric] = summarise(v, metric, out.classified[metric], v.raw[metric], ctx);
    }
    out.validationTop = validationShares(v.validation, v.mediaSeconds);
    return out;
  });

  const totalSamples = variants.reduce((a, v) => a + v.pulse.n + v.breathing.n, 0);
  const summary = {
    runId: run.runId,
    clipId: run.clipId,
    createdAt: run.createdAt,
    suite: run.suite,
    mock: !!run.mock,
    sdkVersion: run.sdkVersion,
    people: 1,
    clips: 1,
    counts: { variants: variants.length, readings: totalSamples },
    tolerance: GAP,
    promiseTol: TOL,
    baseline: original ? {
      pulse: round(median(readings(original.raw.pulse).filter((s) => s.stable).map((s) => s.value))),
      breathing: round(median(readings(original.raw.breathing).filter((s) => s.stable).map((s) => s.value))),
      pulseStablePct: original.raw?.pulse?.length ? round(pct(readings(original.raw.pulse).filter((s) => s.stable).length, readings(original.raw.pulse).length)) : null,
    } : null,
    promise: Object.fromEntries(METRICS.map((m) => [m, promise(variants, m, curves[m])])),
    calibration: Object.fromEntries(METRICS.map((m) => [m, calibration(variants, m)])),
    headroom: null,
    repeatability: repeatability(variants),
    live: liveVsReplay(clip, original),
    reference: clip?.reference?.pulse ? {
      ...clip.reference,
      diff: original ? round(median(readings(original.raw.pulse).filter((s) => s.stable).map((s) => s.value)) - clip.reference.pulse) : null,
    } : null,
    variants: variants.map((v) => ({
      id: v.id, label: v.label, family: v.family, familyLabel: FAMILIES[v.family]?.label, level: v.level, value: v.value,
      expect: v.expect, factor: v.factor, what: v.what, baseline: !!v.baseline,
      pulse: v.pulse, breathing: v.breathing, validationTop: v.validationTop.slice(0, 3),
      errors: v.errors, wallMs: v.wallMs, mediaSeconds: v.mediaSeconds, frames: v.frames, thumb: v.thumb,
    })),
  };
  summary.headroom = headroom(variants);
  summary.verdict = verdict(summary, variants);
  return { summary, variants };
}

module.exports = { analyze, TOL, GAP, UNIT, VALIDATION, METRICS, readings, median };
