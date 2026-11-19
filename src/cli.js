#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./core/store');
const { importClip, runCrashTest, reanalyze } = require('./core/crash');
const { VARIANTS, SUITES } = require('./core/suite');
const { MOCK } = require('./core/measure');

const HELP = `TrustFall: a crash-test lab for camera vital signs

Usage
  trustfall run <video|clipId> [--suite quick|full|smoke] [--min-kept 80] [--fail-on-fooled]
  trustfall import <video> [--name text] [--ref 72] [--ref-method oximeter|watch|manual]
  trustfall report <runId>       re-analyse a saved run and rewrite its exports
  trustfall list                 list clips and runs
  trustfall suites               list the variants in each suite
  trustfall delete-all --yes     remove every clip and result in ${store.DATA}

CI gates (exit code 1 when they fail)
  --min-kept N       stable pulse readings must be within tolerance at least N% of the time
  --fail-on-fooled   fail if any variant produced confident-but-off readings

The API key is read from SMARTSPECTRA_API_KEY (environment or .env).
Data is written to ${store.DATA} (override with TRUSTFALL_DATA).`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) out[key] = true; else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function bar(f, width = 20) {
  const n = Math.round(f * width);
  return `[${'#'.repeat(n)}${'.'.repeat(width - n)}]`;
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd || a.help || a.h) { console.log(HELP); return; }
  if (MOCK) console.log('!! TRUSTFALL_MOCK=1: using synthetic readings, not the SDK. Results are not measurements.\n');

  if (cmd === 'suites') {
    for (const [name, ids] of Object.entries(SUITES)) {
      console.log(`${name} (${ids.length} runs)`);
      for (const id of ids) {
        const v = VARIANTS.find((x) => x.id === id);
        console.log(`  ${id.padEnd(16)} ${v.label.padEnd(36)} ${v.what}`);
      }
      console.log('');
    }
    return;
  }

  if (cmd === 'list') {
    console.log('Clips');
    for (const c of store.listClips()) console.log(`  ${c.id}  ${c.info.duration.toFixed(1)}s  ${c.name}${c.reference ? `  ref ${c.reference.pulse} bpm` : ''}`);
    console.log('Runs');
    for (const r of store.listRuns()) console.log(`  ${r.runId}  ${r.suite.padEnd(6)} clip ${r.clipId}  pulse kept ${r.promise.pulse.pct ?? '–'}%${r.mock ? '  (MOCK)' : ''}`);
    return;
  }

  if (cmd === 'delete-all') {
    if (!a.yes) { console.log(`This removes ${store.DATA}. Re-run with --yes to confirm.`); process.exitCode = 1; return; }
    store.deleteAll();
    console.log(`Deleted everything in ${store.DATA}`);
    return;
  }

  if (cmd === 'import') {
    const src = a._[1];
    if (!src || !fs.existsSync(src)) throw new Error('Give a path to a video file.');
    const reference = a.ref ? { pulse: Number(a.ref), method: a['ref-method'] || 'manual' } : null;
    const clip = await importClip(path.resolve(src), { name: a.name || path.basename(src), reference, onProgress: (f) => process.stdout.isTTY && process.stdout.write(`\r  normalising ${bar(f)}`) });
    console.log(`\nImported ${clip.id} (${clip.info.duration.toFixed(1)} s, ${clip.info.width}x${clip.info.height} @ ${clip.info.fps.toFixed(0)} fps)`);
    return;
  }

  if (cmd === 'report') {
    const s = reanalyze(a._[1]);
    console.log(fs.readFileSync(path.join(store.dirs.runs, s.runId, 'report.md'), 'utf8'));
    return;
  }

  if (cmd === 'run') {
    const target = a._[1];
    if (!target) throw new Error('Give a video file or a clip id.');
    let clipId = target;
    if (fs.existsSync(target)) {
      const clip = await importClip(path.resolve(target), { name: path.basename(target), onProgress: (f) => process.stdout.isTTY && process.stdout.write(`\r  normalising ${bar(f)}`) });
      clipId = clip.id;
      console.log(`\nImported ${clipId}`);
    }
    const t0 = Date.now();
    const summaryOrder = SUITES[a.suite || 'quick'] || [];
    const tty = process.stdout.isTTY;
    let active = null;
    const summary = await runCrashTest({
      clipId,
      suiteName: a.suite || 'quick',
      onEvent: (e) => {
        if (e.type === 'run-start') { console.log(`Crash test ${e.runId}: ${e.variants.length} variants\n`); active = e.variants[0].id; }
        // Renders for the next variant run in the background; only show
        // progress for the variant being worked on.
        if (e.type === 'variant' && e.id === active && tty && (e.phase === 'render' || e.phase === 'measure')) {
          process.stdout.write(`\r  ${e.id.padEnd(16)} ${e.phase.padEnd(8)} ${bar(e.progress || 0)}`);
        }
        if (e.type === 'variant' && e.phase === 'done') {
          const p = e.result.pulse; const b = e.result.breathing;
          const line = `  ${e.id.padEnd(16)} pulse ${p.verdict.padEnd(8)} stable ${String(p.stablePct ?? '–').padStart(5)}%  err ${String(p.medAbsErr ?? '–').padStart(5)}  | breathing ${b.verdict.padEnd(8)}`;
          if (tty) process.stdout.write(`\r${line}\n`); else console.log(line);
          const order = summaryOrder.indexOf(e.id);
          active = summaryOrder[order + 1] || null;
        }
      },
    });
    const p = summary.promise.pulse;
    const b = summary.promise.breathing;
    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)} s. ${summary.verdict.headline}`);
    console.log(`Stable pulse readings within ${p.tolerance} bpm of the clean copy: ${p.kept}/${p.stable} (${p.pct ?? '–'}%), moved >${p.promise}: ${p.moved} (${p.movedPct ?? '–'}%)`);
    console.log(`Stable breathing readings within ${b.tolerance} br/min of the clean copy: ${b.kept}/${b.stable} (${b.pct ?? '–'}%), moved >${b.promise}: ${b.moved} (${b.movedPct ?? '–'}%)`);
    console.log(`Report: ${path.join(store.dirs.runs, summary.runId, 'report.md')}`);

    let fail = false;
    if (a['min-kept'] != null && (p.pct ?? 0) < Number(a['min-kept'])) { console.log(`FAIL: pulse kept ${p.pct}% < ${a['min-kept']}%`); fail = true; }
    if (a['fail-on-fooled'] && summary.verdict.blindSpots.length) { console.log(`FAIL: confident-but-off readings in ${summary.verdict.blindSpots.map((x) => x.id).join(', ')}`); fail = true; }
    if (fail) process.exitCode = 1;
    return;
  }

  console.log(HELP);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`);
  process.exitCode = 1;
});
