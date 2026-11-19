'use strict';

// The crash-test suite. Every variant is the SAME recorded clip with one
// controlled change, so the person's real pulse and breathing are known to be
// identical across variants. That gives each run an expected answer without a
// pulse oximeter:
//
//   expect 'same'  -> the readings should match the original clip
//   expect 'scale' -> playback speed changed, so the true rate scales by `factor`
//   expect 'none'  -> a frozen frame has no pulse or breathing at all
//
// Each variant also says which real-world situation it stands in for, so the
// report can turn results into setup advice.

const W = 1280;
const H = 720;
const FPS = 30;

// Fallback face box (pixels in a 1280x720 frame) used when the baseline run
// did not return landmarks. The recording flow only starts once the SDK says
// the face is centred, so this is a reasonable default.
const DEFAULT_FACE = { x: 490, y: 150, w: 300, h: 380 };

const FAMILIES = {
  control: { label: 'Controls', advice: null },
  speed: { label: 'Known shift', advice: null },
  light: { label: 'Dim room', unit: 'stops darker', advice: 'Add soft light in front of you, such as a lamp behind the screen or a window you face.' },
  grain: { label: 'Grainy camera', unit: 'noise', advice: 'Grain comes from a camera boosting a dark picture. More light fixes it better than any setting.' },
  focus: { label: 'Out of focus', unit: 'blur', advice: 'Wipe the lens and sit where the camera can focus on you.' },
  shake: { label: 'Shaky camera', unit: 'px sway', advice: 'Put the laptop or phone on a table or stand, not on your lap or in your hand.' },
  distance: { label: 'Sitting farther', unit: 'x farther', advice: 'Sit closer so your face fills more of the picture.' },
  compress: { label: 'Video-call compression', unit: 'CRF', advice: 'Measure from the camera directly, not through a video call or screen recording.' },
  fps: { label: 'Low frame rate', unit: 'fps', advice: 'Close heavy apps and add light; dark rooms make cameras drop frames.' },
  cover: { label: 'Face covered', unit: '', advice: 'Keep your forehead and cheeks uncovered: move hair, hands and masks away.' },
  flicker: { label: 'Flickering light', unit: '', advice: 'Avoid lighting your face with a TV, monitor or a dimmed LED that flickers.' },
  color: { label: 'Colour removed', unit: '', advice: null },
  negative: { label: 'No person', unit: '', advice: null },
};

function q(expr) {
  return `'${expr}'`;
}

function lightFilter(stops) {
  const f = Math.pow(2, -stops).toFixed(5);
  // Darken in linear light (approximate sRGB gamma 2.2), not in code values.
  const e = q(`255*pow(pow(val/255,2.2)*${f},1/2.2)`);
  return `lutrgb=r=${e}:g=${e}:b=${e}`;
}

function shakeFilter(a) {
  const x = q(`${a}+${a}*(0.6*sin(2*PI*0.31*t)+0.4*sin(2*PI*0.83*t+1.3))`);
  const y = q(`${a}+${a}*(0.6*sin(2*PI*0.23*t+0.7)+0.4*sin(2*PI*0.67*t))`);
  return `crop=w=iw-${2 * a}:h=ih-${2 * a}:x=${x}:y=${y},scale=${W}:${H}`;
}

function distanceFilter(d) {
  return `scale=trunc(iw/${d}/2)*2:trunc(ih/${d}/2)*2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x1e1e1e`;
}

function intensityFilter(amp, hz) {
  // Scale brightness and colour by the same factor k, like a lamp whose
  // output rises and falls. (eq with eval=frame is faster but quantises a 2%
  // swing unevenly, so this uses geq on the YUV planes.)
  const k = `(1+${amp}*sin(2*PI*${hz.toFixed(4)}*T))`;
  return `geq=lum=${q(`lum(X,Y)*${k}`)}:cb=${q(`128+(cb(X,Y)-128)*${k}`)}:cr=${q(`128+(cr(X,Y)-128)*${k}`)}`;
}

function boxFilter(face, part) {
  const { x, y, w, h } = face;
  const r = Math.round;
  const boxes = {
    mask: [x - 0.08 * w, y + 0.55 * h, 1.16 * w, 0.55 * h],
    forehead: [x - 0.05 * w, y - 0.08 * h, 1.1 * w, 0.4 * h],
    half: [x + 0.5 * w, y - 0.1 * h, 0.62 * w, 1.25 * h],
  };
  const [bx, by, bw, bh] = boxes[part];
  return `drawbox=x=${r(bx)}:y=${r(by)}:w=${r(bw)}:h=${r(bh)}:color=0x3b4656@1:t=fill`;
}

// ctx: { face, pulse, breathing } from the baseline run (may be null on first pass)
const VARIANTS = [
  { id: 'original', family: 'control', level: 0, label: 'Original clip', expect: 'same', baseline: true,
    what: 'Your clip, unchanged. Every other variant is compared with this one.', filter: () => null },
  { id: 'repeat', family: 'control', level: 0, label: 'Same clip again', expect: 'same',
    what: 'The identical file measured a second time. Shows how repeatable a replay is.', filter: () => null, reuse: 'original' },
  { id: 'mirror', family: 'control', level: 0, label: 'Mirror image', expect: 'same',
    what: 'Flipped left to right. A face reads the same in a mirror.', filter: () => 'hflip' },

  { id: 'speed-up', family: 'speed', level: 1, label: 'Played 15% faster', expect: 'scale', factor: 1.15,
    what: 'Sped up, so the true pulse and breathing are exactly 15% higher.', filter: () => `setpts=PTS/1.15,fps=${FPS}` },
  { id: 'speed-down', family: 'speed', level: 1, label: 'Played 15% slower', expect: 'scale', factor: 0.85,
    what: 'Slowed down, so the true pulse and breathing are exactly 15% lower.', filter: () => `setpts=PTS/0.85,fps=${FPS}` },

  ...[1, 2, 3, 4].map((s) => ({ id: `light-${s}`, family: 'light', level: s, value: s, label: `${s} stop${s > 1 ? 's' : ''} darker`, expect: 'same',
    what: `${Math.pow(2, s)}x less light on the scene, with the camera not compensating.`, filter: () => lightFilter(s) })),

  ...[[1, 6], [2, 12], [3, 20], [4, 32]].map(([l, n]) => ({ id: `grain-${l}`, family: 'grain', level: l, value: n, label: `Sensor noise ${n}`, expect: 'same',
    what: 'Random speckle in every frame, like a webcam boosting a dark picture.', filter: () => `noise=alls=${n}:allf=t` })),

  ...[[1, 2], [2, 4], [3, 8], [4, 14]].map(([l, s]) => ({ id: `focus-${l}`, family: 'focus', level: l, value: s, label: `Blur ${s}px`, expect: 'same',
    what: 'Soft focus or a smudged lens.', filter: () => `gblur=sigma=${s}` })),

  ...[[1, 3], [2, 8], [3, 16], [4, 32]].map(([l, a]) => ({ id: `shake-${l}`, family: 'shake', level: l, value: a, label: `Sway ±${a}px`, expect: 'same',
    what: 'The whole picture drifts slowly, like a laptop on a lap or a hand-held phone.', filter: () => shakeFilter(a) })),

  ...[[1, 1.5], [2, 2], [3, 3], [4, 4]].map(([l, d]) => ({ id: `distance-${l}`, family: 'distance', level: l, value: d, label: `${d}x farther`, expect: 'same',
    what: `Face shrunk to 1/${d} of its size, as if you sat ${d} times farther away.`, filter: () => distanceFilter(d) })),

  ...[[1, 30], [2, 36], [3, 42], [4, 48]].map(([l, crf]) => ({ id: `compress-${l}`, family: 'compress', level: l, value: crf, label: `CRF ${crf}`, expect: 'same', crf,
    what: 'Re-encoded at a lower quality, like a video call or a shared screen recording.', filter: () => null })),

  ...[[1, 24], [2, 20], [3, 15], [4, 10]].map(([l, f]) => ({ id: `fps-${l}`, family: 'fps', level: l, value: f, label: `${f} fps`, expect: 'same', fps: f,
    what: `Frames dropped down to ${f} per second. The SDK asks for at least about 25.`, filter: () => `fps=${f}` })),

  { id: 'cover-forehead', family: 'cover', level: 1, label: 'Forehead covered', expect: 'same',
    what: 'A band over the forehead, like a hand, hat or fringe.', filter: (c) => boxFilter(c.face, 'forehead') },
  { id: 'cover-mask', family: 'cover', level: 2, label: 'Lower face covered', expect: 'same',
    what: 'Nose and mouth covered, like a face mask.', filter: (c) => boxFilter(c.face, 'mask') },
  { id: 'cover-half', family: 'cover', level: 3, label: 'Half face covered', expect: 'same',
    what: 'One side of the face hidden.', filter: (c) => boxFilter(c.face, 'half') },

  { id: 'flicker-pulse', family: 'flicker', level: 1, label: 'Light pulsing at a heart-like rate', expect: 'same',
    what: 'The whole scene brightens and dims by 2% at a steady heart-like rhythm, faster than your real pulse.',
    filter: (c) => intensityFilter(0.02, flickerHz(c)), lure: (c) => flickerHz(c) * 60 },
  { id: 'flicker-drift', family: 'flicker', level: 2, label: 'Exposure drifting at a breath-like rate', expect: 'same',
    what: 'Brightness swells by 8% at a breathing-like rhythm, like auto-exposure hunting.',
    filter: (c) => intensityFilter(0.08, driftHz(c)), lureBreathing: (c) => driftHz(c) * 60 },

  { id: 'grayscale', family: 'color', level: 1, label: 'Black and white', expect: 'same',
    what: 'All colour removed. Camera pulse readings rely on tiny colour changes in skin.', filter: () => 'hue=s=0' },

  { id: 'still', family: 'negative', level: 1, label: 'Still photo', expect: 'none', still: true,
    what: 'One frame frozen for the whole clip. A photo has no pulse and no breathing.', filter: () => null },
  { id: 'still-noise', family: 'negative', level: 2, label: 'Still photo + sensor noise', expect: 'none', still: true,
    what: 'A frozen frame with live camera noise on top, like a photo held up to a webcam.', filter: () => 'noise=alls=8:allf=t' },
];

// Lure frequencies are set away from the person's real rates so a reading
// that follows the flicker is easy to tell apart from a correct one.
function flickerHz(c) {
  const base = c && c.pulse ? c.pulse : 70;
  const bpm = base + 22 <= 110 ? base + 22 : base - 22;
  return bpm / 60;
}
function driftHz(c) {
  const base = c && c.breathing ? c.breathing : 14;
  return (base + 6) / 60;
}

const SUITES = {
  quick: ['original', 'repeat', 'mirror', 'speed-up', 'light-2', 'light-3', 'grain-3', 'focus-3', 'shake-2', 'distance-2',
    'compress-3', 'fps-3', 'cover-mask', 'flicker-pulse', 'grayscale', 'still', 'still-noise'],
  full: VARIANTS.map((v) => v.id),
  smoke: ['original', 'repeat', 'speed-up', 'still'],
};

function suite(name) {
  const ids = SUITES[name];
  if (!ids) throw new Error(`Unknown suite "${name}". Use one of: ${Object.keys(SUITES).join(', ')}`);
  return ids.map((id) => VARIANTS.find((v) => v.id === id));
}

module.exports = { VARIANTS, SUITES, FAMILIES, suite, DEFAULT_FACE, W, H, FPS };
