'use strict';

// ffmpeg helpers: normalise a recording, render one crash-test variant, and
// grab a thumbnail. Every variant is encoded with the same settings so the
// only difference between two files is the change under test.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { W, H, FPS } = require('./suite');

function findBinary(name) {
  const env = process.env[`${name.toUpperCase()}_PATH`];
  if (env) return env;
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return name;
}

const FFMPEG = findBinary('ffmpeg');
const FFPROBE = findBinary('ffprobe');

const ENCODE = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

function hasFfmpeg() {
  try { execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function probe(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=width,height,avg_frame_rate,nb_read_packets:format=duration', '-of', 'json', file]);
  const j = JSON.parse(out.toString());
  const s = j.streams[0];
  const [n, d] = String(s.avg_frame_rate).split('/').map(Number);
  return {
    width: s.width,
    height: s.height,
    fps: d ? n / d : n,
    frames: Number(s.nb_read_packets),
    duration: Number(j.format.duration),
  };
}

function run(args, { onProgress, duration } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats', ...args]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (m && onProgress && duration) {
        const us = Number(m[m.length - 1].split('=')[1]);
        onProgress(Math.min(1, us / 1e6 / duration));
      }
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.trim().slice(-400)}`))));
  });
}

// Recordings arrive as variable-frame-rate WebM from the browser. Re-encode
// to a constant 30 fps, 1280x720, near-lossless H.264 master.
async function normalize(input, output, opts = {}) {
  const vf = `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  const args = ['-i', input];
  if (opts.maxSeconds) args.push('-t', String(opts.maxSeconds));
  await run([...args, '-vf', vf, ...ENCODE, '-crf', '12', '-r', String(FPS), output], opts);
  return probe(output);
}

async function renderVariant(variant, source, output, ctx, opts = {}) {
  const info = ctx.info;
  const filter = variant.filter(ctx);
  const fps = variant.fps || FPS;
  const crf = String(variant.crf || 12);
  let args;
  if (variant.still) {
    const at = Math.min(5, info.duration / 3).toFixed(2);
    const chain = [`trim=end_frame=1`, `loop=loop=-1:size=1:start=0`, `setpts=N/${FPS}/TB`, filter].filter(Boolean).join(',');
    args = ['-ss', at, '-i', source, '-vf', chain, '-t', info.duration.toFixed(2)];
  } else {
    args = ['-i', source];
    if (filter) args.push('-vf', filter);
  }
  await run([...args, ...ENCODE, '-crf', crf, '-r', String(fps), output], { ...opts, duration: info.duration / (variant.factor || 1) });
  return probe(output);
}

async function thumbnail(file, output, at = 8) {
  await run(['-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', output]);
  return output;
}

module.exports = { FFMPEG, hasFfmpeg, probe, normalize, renderVariant, thumbnail };
