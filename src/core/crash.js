'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const media = require('./media');
const { suite, DEFAULT_FACE, FAMILIES } = require('./suite');
const { measureFile, MOCK } = require('./measure');
const { analyze } = require('./analyze');
const { writeExports } = require('./export');

async function importClip(src, { name, live = null, reference = null, maxSeconds = 75, source = 'import', onProgress } = {}) {
  store.ensure();
  const id = `clip-${store.stamp()}`;
  const dir = path.join(store.dirs.clips, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'clip.mp4');
  const info = await media.normalize(src, file, { maxSeconds, onProgress, duration: maxSeconds });
  await media.thumbnail(file, path.join(dir, 'thumb.jpg'), Math.min(8, info.duration / 2));
  const clip = { id, name: name || id, createdAt: new Date().toISOString(), source, info, live, reference, mock: MOCK };
  store.writeJson(path.join(dir, 'clip.json'), clip);
  return clip;
}

function loadClip(clipId) {
  const dir = path.join(store.dirs.clips, clipId);
  const clip = store.readJson(path.join(dir, 'clip.json'));
  if (!clip) throw new Error(`Clip ${clipId} not found in ${store.dirs.clips}`);
  return { clip, file: path.join(dir, 'clip.mp4'), dir };
}

function setReference(clipId, reference) {
  const { clip, dir } = loadClip(clipId);
  clip.reference = reference;
  store.writeJson(path.join(dir, 'clip.json'), clip);
  return clip;
}

async function runCrashTest({ clipId, suiteName = 'quick', onEvent = () => {}, signal } = {}) {
  store.ensure();
  const apiKey = store.apiKey();
  if (!MOCK && !apiKey) throw Object.assign(new Error('No SmartSpectra API key. Copy .env.example to .env and add SMARTSPECTRA_API_KEY.'), { code: 'NO_KEY' });
  if (!media.hasFfmpeg()) throw new Error('ffmpeg was not found. Install it (macOS: brew install ffmpeg) or set FFMPEG_PATH.');

  const { clip, file } = loadClip(clipId);
  const variants = suite(suiteName);
  const runId = `run-${store.stamp()}`;
  const runDir = path.join(store.dirs.runs, runId);
  const thumbs = path.join(runDir, 'thumbs');
  fs.mkdirSync(thumbs, { recursive: true });

  const run = {
    runId, clipId, suite: suiteName, createdAt: new Date().toISOString(), mock: MOCK, sdkVersion: null,
    clipInfo: clip.info, ctx: { face: null, pulse: null, breathing: null }, variants: [],
  };
  onEvent({ type: 'run-start', runId, mock: MOCK, clipId, variants: variants.map(({ id, label, family, level, what, expect, factor }) => ({ id, label, family, familyLabel: FAMILIES[family]?.label, level, what, expect, factor })) });

  const ctx = { info: clip.info, face: DEFAULT_FACE, pulse: null, breathing: null };
  const rendered = new Map();

  const render = (v) => {
    if (v.reuse) {
      // Same file as the variant it reuses; give it its own thumbnail path.
      return rendered.get(v.reuse).then((r) => {
        const thumb = `thumbs/${v.id}.jpg`;
        try { fs.copyFileSync(path.join(runDir, r.thumb), path.join(runDir, thumb)); } catch { /* no thumbnail */ }
        return { ...r, thumb };
      });
    }
    if (!rendered.has(v.id)) {
      const out = path.join(store.dirs.tmp, `${runId}-${v.id}.mp4`);
      const p = media.renderVariant(v, file, out, ctx, {
        onProgress: (f) => onEvent({ type: 'variant', id: v.id, phase: 'render', progress: f }),
      }).then(async (info) => {
        const thumb = path.join(thumbs, `${v.id}.jpg`);
        await media.thumbnail(out, thumb, Math.min(8, info.duration / 2)).catch(() => null);
        return { file: out, info, thumb: `thumbs/${v.id}.jpg` };
      });
      rendered.set(v.id, p);
    }
    return rendered.get(v.id);
  };

  const cleanup = () => {
    for (const p of rendered.values()) p.then((r) => fs.rmSync(r.file, { force: true })).catch(() => {});
  };

  try {
    for (let i = 0; i < variants.length; i += 1) {
      if (signal?.aborted) throw Object.assign(new Error('Crash test cancelled'), { code: 'CANCELLED' });
      const v = variants[i];
      onEvent({ type: 'variant', id: v.id, phase: 'render', progress: 0 });
      const r = await render(v);
      // Prefetch the next render while the SDK works, except for variants
      // that need the baseline's face box or rates.
      if (!v.baseline && variants[i + 1]) render(variants[i + 1]).catch(() => {});

      onEvent({ type: 'variant', id: v.id, phase: 'measure', progress: 0 });
      let m;
      try {
        m = await measureFile(r.file, {
          apiKey, variant: v, landmarks: !!v.baseline, duration: r.info.duration, fps: r.info.fps || 30,
          onProgress: (f) => onEvent({ type: 'variant', id: v.id, phase: 'measure', progress: f }),
        });
      } catch (e) {
        m = { samples: { pulse: [], breathing: [], hrv: [] }, validation: [], errors: [{ code: e.code ?? -1, message: e.message }], frames: 0, mediaSeconds: null, wallMs: 0 };
        if (e.code === 2 || e.code === 4 || e.code === 'NO_KEY') {
          onEvent({ type: 'variant', id: v.id, phase: 'error', error: e.message });
          throw e;
        }
      }
      const fatal = (m.errors || []).find((e) => e.code === 2 || e.code === 4);
      if (fatal) {
        onEvent({ type: 'variant', id: v.id, phase: 'error', error: fatal.message });
        throw Object.assign(new Error(fatal.code === 4 ? `SmartSpectra credits are used up: ${fatal.message}` : `SmartSpectra rejected the API key: ${fatal.message}`), { code: fatal.code });
      }
      run.sdkVersion = run.sdkVersion || m.sdkVersion;
      run.variants.push({
        id: v.id, label: v.label, family: v.family, level: v.level, value: v.value, expect: v.expect, factor: v.factor,
        what: v.what, baseline: !!v.baseline, lure: v.lure ? v.lure(ctx) : null, lureBreathing: v.lureBreathing ? v.lureBreathing(ctx) : null,
        raw: m.samples, validation: m.validation, errors: m.errors, frames: m.frames, mediaSeconds: m.mediaSeconds ?? r.info.duration,
        wallMs: m.wallMs, thumb: r.thumb, renderedInfo: r.info,
      });

      if (v.baseline) {
        const { median, readings } = require('./analyze');
        ctx.face = m.face || DEFAULT_FACE;
        ctx.pulse = median(readings(m.samples.pulse).filter((s) => s.stable).map((s) => s.value));
        ctx.breathing = median(readings(m.samples.breathing).filter((s) => s.stable).map((s) => s.value));
        run.ctx = { face: ctx.face, faceFromLandmarks: !!m.face, pulse: ctx.pulse, breathing: ctx.breathing };
      }

      const partial = analyze({ run: { ...run, variants: run.variants.map(restoreFns) }, clip });
      const vs = partial.summary.variants.find((x) => x.id === v.id);
      onEvent({ type: 'variant', id: v.id, phase: 'done', result: vs });
      store.writeJson(path.join(runDir, 'run.json'), run);
    }
  } finally {
    cleanup();
  }

  const { summary, variants: full } = analyze({ run: { ...run, variants: run.variants.map(restoreFns) }, clip });
  store.writeJson(path.join(runDir, 'run.json'), run);
  writeExports(runDir, summary, full);
  onEvent({ type: 'run-done', runId, summary });
  return summary;
}

// Lure functions are not serialised into run.json; restore them from the
// stored numbers so analysis works the same on a reloaded run.
function restoreFns(v) {
  return { ...v, lure: v.lure != null ? () => v.lure : undefined, lureBreathing: v.lureBreathing != null ? () => v.lureBreathing : undefined };
}

function reanalyze(runId) {
  const runDir = path.join(store.dirs.runs, runId);
  const run = store.readJson(path.join(runDir, 'run.json'));
  if (!run) throw new Error(`Run ${runId} not found`);
  let clip = null;
  try { clip = loadClip(run.clipId).clip; } catch { /* clip may have been deleted */ }
  const { summary, variants } = analyze({ run: { ...run, variants: run.variants.map(restoreFns) }, clip });
  writeExports(runDir, summary, variants);
  return summary;
}

function loadRunDetail(runId) {
  const runDir = path.join(store.dirs.runs, runId);
  const run = store.readJson(path.join(runDir, 'run.json'));
  if (!run) return null;
  let clip = null;
  try { clip = loadClip(run.clipId).clip; } catch { /* ignore */ }
  const { summary, variants } = analyze({ run: { ...run, variants: run.variants.map(restoreFns) }, clip });
  // Thin the per-reading series for charts: at most one point every 0.5 s.
  const thin = (arr) => {
    const out = []; let last = -Infinity;
    for (const s of arr) if (s.t - last >= 0.5) { out.push(s); last = s.t; }
    return out;
  };
  return {
    summary,
    dir: runDir,
    series: variants.map((v) => ({
      id: v.id,
      pulse: thin(v.classified.pulse).map((s) => [round2(s.t), round2(s.value), round2(s.confidence), s.stable ? 1 : 0, s.expected == null ? null : round2(s.expected), s.cls]),
      breathing: thin(v.classified.breathing).map((s) => [round2(s.t), round2(s.value), round2(s.confidence), s.stable ? 1 : 0, s.expected == null ? null : round2(s.expected), s.cls]),
    })),
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

module.exports = { importClip, loadClip, setReference, runCrashTest, reanalyze, loadRunDetail };
