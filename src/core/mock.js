'use strict';

// Synthetic stand-in for the SDK, used only with TRUSTFALL_MOCK=1 to build and
// demo the interface without an API key. The numbers are invented. Runs made
// this way are stamped mock:true and the UI labels them "MOCK DATA".

const path = require('path');

function rng(seed) {
  let s = 0;
  for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROFILE = {
  // [severity per level 1..4, fools: does confidence stay high while wrong?]
  light: [[0.05, 0.25, 0.6, 0.95], false],
  grain: [[0.05, 0.15, 0.4, 0.7], false],
  focus: [[0.02, 0.08, 0.3, 0.65], false],
  shake: [[0.1, 0.35, 0.6, 0.85], true],
  distance: [[0.05, 0.2, 0.55, 0.9], false],
  compress: [[0.05, 0.2, 0.5, 0.9], true],
  fps: [[0.1, 0.3, 0.7, 1], false],
  cover: [[0.2, 0.45, 0.7], false],
  flicker: [[0.5, 0.4], true],
  color: [[0.6], false],
};

const CODES = {
  light: 5, distance: 14, shake: 12, fps: 11, cover: 17,
};

async function measureFile(file, opts = {}) {
  const variant = opts.variant || { id: path.basename(file, '.mp4'), family: 'control', level: 0, expect: 'same' };
  const rand = rng(variant.id === 'repeat' ? 'original' : variant.id);
  const D = (opts.duration || 60) / (variant.factor || 1);
  const k = variant.expect === 'scale' ? variant.factor : 1;
  const [sevs, fools] = PROFILE[variant.family] || [[0], false];
  const sev = variant.level ? (sevs[variant.level - 1] ?? sevs[sevs.length - 1]) : 0;
  const gauss = () => { let u = 0; for (let i = 0; i < 6; i += 1) u += rand(); return u - 3; };
  const truthP = (t) => k * (71 + 3 * Math.sin((2 * Math.PI * t * k) / 40));
  const truthB = (t) => k * (14 + Math.sin((2 * Math.PI * t * k) / 50));

  const steps = 30;
  for (let i = 1; i <= steps; i += 1) {
    await new Promise((r) => setTimeout(r, 60));
    if (opts.onProgress) opts.onProgress(i / steps);
  }

  if (variant.family === 'fps' && variant.level >= 4) {
    return result([], [], [{ t: 1.2, code: 11, hint: 'Use a camera mode that provides at least 25 frames per second.' }],
      [{ code: 14, message: 'SmartSpectra stopped because the frame rate stayed too low to measure reliably.', retryable: false }]);
  }

  const pulse = [];
  const breathing = [];
  let drift = 0;
  for (let t = 1; t <= D; t += 0.5) {
    drift = 0.9 * drift + gauss() * sev * 4;
    if (variant.expect === 'none') {
      const phantom = variant.id === 'still-noise' && t > 14 && rand() < 0.35;
      pulse.push({ t, value: 55 + rand() * 50, confidence: phantom ? 41 + rand() * 20 : rand() * 25, stable: false });
      pulse[pulse.length - 1].stable = pulse[pulse.length - 1].confidence >= 40;
      continue;
    }
    if (t >= 12) {
      const ramp = Math.min(1, (t - 12) / 8);
      let value = truthP(t) + gauss() * 0.8 + (fools ? drift * 2.2 : drift);
      if (variant.id === 'flicker-pulse' && t > 20) value = 0.55 * value + 0.45 * 93;
      const conf = Math.max(0, Math.min(99, ramp * (fools ? 82 - sev * 25 : 88 * (1 - sev)) + gauss() * 6));
      pulse.push({ t, value, confidence: conf, stable: conf >= 40 });
    } else {
      pulse.push({ t, value: 0, confidence: 0, stable: false });
    }
    if (t >= 30) {
      const ramp = Math.min(1, (t - 30) / 6);
      const value = truthB(t) + gauss() * 0.3 + drift * 0.3;
      const conf = Math.max(0, Math.min(99, ramp * 80 * (1 - sev * 0.9) + gauss() * 5));
      breathing.push({ t, value, confidence: conf, stable: conf >= 45 });
    }
  }
  const validation = [{ t: 0.1, code: 10, hint: 'Camera is adjusting.' }, { t: 1, code: 0, hint: 'OK' }];
  if (CODES[variant.family] && sev > 0.5) validation.push({ t: 3, code: CODES[variant.family], hint: hintFor(CODES[variant.family]) });
  return result(pulse, breathing, validation, []);

  function result(p, b, v, errors) {
    return {
      mock: true,
      samples: { pulse: p, breathing: b, hrv: [] },
      validation: v,
      errors,
      frames: Math.round(D * (variant.fps || 30)),
      mediaSeconds: D,
      wallMs: steps * 60,
      face: variant.baseline ? { x: 500, y: 160, w: 290, h: 370 } : null,
      sdkVersion: 'mock',
    };
  }
}

function hintFor(code) {
  return {
    5: 'Too dark. Add light or move to a brighter area.',
    11: 'Use a camera mode that provides at least 25 frames per second.',
    12: 'Hold still.',
    14: 'Move closer to the camera.',
    17: 'Face the camera.',
  }[code] || 'OK';
}

module.exports = { measureFile };
