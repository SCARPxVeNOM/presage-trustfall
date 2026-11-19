'use strict';

// Writes the three export files for a run: every reading as CSV, the full
// summary as JSON, and a short Markdown report a developer can paste into an
// issue or a README.

const fs = require('fs');
const path = require('path');

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function samplesCsv(summary, variants) {
  const head = ['run_id', 'variant', 'family', 'level', 'expectation', 'metric', 't_s', 'value', 'confidence', 'stable', 'expected', 'error', 'within_tolerance', 'outcome'];
  const rows = [head.join(',')];
  for (const v of variants) {
    for (const metric of ['pulse', 'breathing']) {
      for (const s of v.classified[metric]) {
        rows.push([summary.runId, v.id, v.family, v.level, v.expect === 'scale' ? `scale x${v.factor}` : v.expect, metric,
          s.t.toFixed(3), s.value.toFixed(2), s.confidence.toFixed(1), s.stable ? 1 : 0,
          s.expected == null ? '' : s.expected.toFixed(2), s.error == null ? '' : s.error.toFixed(2), s.within ? 1 : 0, s.cls].map(csvCell).join(','));
      }
    }
  }
  return rows.join('\n') + '\n';
}

const VERDICT_WORD = { held: 'held', caught: 'flagged', fooled: 'confident but off', refused: 'no reading' };

function reportMd(s) {
  const p = s.promise.pulse;
  const b = s.promise.breathing;
  const lines = [];
  lines.push(`# TrustFall crash-test report`);
  lines.push('');
  if (s.mock) lines.push('> **MOCK DATA.** This run used the synthetic stand-in, not the SmartSpectra SDK. Do not cite these numbers.', '');
  lines.push(`Informal test: ${s.people} person, ${s.clips} clip, ${s.counts.variants} variants, ${s.counts.readings} readings. Run \`${s.runId}\`, suite \`${s.suite}\`, SDK ${s.sdkVersion}.`);
  lines.push('');
  lines.push(`## Verdict: ${s.verdict.headline}`);
  lines.push('');
  for (const f of s.verdict.fixes) lines.push(`- **${f.text}** ${f.evidence}`);
  for (const n of s.verdict.notes) lines.push(`- ${n}`);
  lines.push('');
  lines.push('## The stable-flag check');
  lines.push('');
  lines.push(`SmartSpectra documents that a reading marked \`stable\` is within ±${p.promise} ${p.unit} for pulse and ±${b.promise} ${b.unit} for breathing. The expected value comes from the SDK's own reading of the clean copy, so two stable readings of the same moment can honestly differ by up to ${p.tolerance} ${p.unit} (${b.tolerance} ${b.unit}). A larger gap means at least one of the two missed the documented range.`);
  lines.push('');
  lines.push(`- Pulse: ${p.kept} of ${p.stable} stable readings were within ${p.tolerance} ${p.unit} of the clean copy${p.pct != null ? ` (${p.pct}%)` : ''}. ${p.moved} moved more than ${p.promise} ${p.unit}${p.movedPct != null ? ` (${p.movedPct}%)` : ''}.`);
  lines.push(`- Breathing: ${b.kept} of ${b.stable} stable readings were within ${b.tolerance} ${b.unit} of the clean copy${b.pct != null ? ` (${b.pct}%)` : ''}. ${b.moved} moved more than ${b.promise} ${b.unit}${b.movedPct != null ? ` (${b.movedPct}%)` : ''}.`);
  if (!p.referenceStable) lines.push('- The clean copy had too few stable pulse readings to serve as a stable reference, so treat these numbers as consistency only.');
  if (p.phantom || b.phantom) lines.push(`- Frozen-frame controls produced ${p.phantom} stable pulse and ${b.phantom} stable breathing readings, where none were expected.`);
  lines.push('');
  lines.push('## Variants');
  lines.push('');
  lines.push('| Variant | What changed | Pulse | Stable | Median error | Breathing | Top SDK feedback |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const v of s.variants) {
    const fb = (v.validationTop || []).filter((c) => c.code !== 0).map((c) => `${c.label} ${c.share}%`).join(', ') || 'OK';
    lines.push(`| ${v.label} | ${v.what} | ${VERDICT_WORD[v.pulse.verdict]} | ${v.pulse.stablePct ?? '–'}% | ${v.pulse.medAbsErr ?? '–'} bpm | ${VERDICT_WORD[v.breathing.verdict]} | ${fb} |`);
  }
  lines.push('');
  if (s.repeatability) {
    const r = s.repeatability.pulse;
    lines.push(`Repeatability: measuring the same file twice gave ${r.identical ? 'identical pulse readings' : `pulse readings differing by up to ${r.maxDiff} bpm`}.`);
  }
  if (s.reference) lines.push(`Reference: ${s.reference.method || 'manual'} reading ${s.reference.pulse} bpm; clean-clip median differed by ${s.reference.diff} bpm.`);
  lines.push('');
  lines.push('_Wellness and measurement wording only. This is not a validation study and makes no claim that the SDK is accurate or inaccurate. It reports what was measured on one clip._');
  return lines.join('\n') + '\n';
}

function writeExports(runDir, summary, variants) {
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(runDir, 'samples.csv'), samplesCsv(summary, variants));
  fs.writeFileSync(path.join(runDir, 'report.md'), reportMd(summary));
}

module.exports = { writeExports, reportMd, samplesCsv };
