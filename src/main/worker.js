'use strict';

// Utility process that runs one crash test and streams events back to the
// main process. Progress events are throttled to ~10 per second per variant.

const { runCrashTest } = require('../core/crash');

let controller = null;
const lastSent = new Map();

function post(e) {
  if (e.type === 'variant' && (e.phase === 'render' || e.phase === 'measure')) {
    const key = `${e.id}:${e.phase}`;
    const now = Date.now();
    if (now - (lastSent.get(key) || 0) < 100 && e.progress < 1) return;
    lastSent.set(key, now);
  }
  process.parentPort.postMessage(e);
}

process.parentPort.on('message', async ({ data }) => {
  if (data.cmd === 'cancel') { if (controller) controller.abort(); return; }
  if (data.cmd !== 'run') return;
  controller = new AbortController();
  try {
    await runCrashTest({ clipId: data.clipId, suiteName: data.suite, onEvent: post, signal: controller.signal });
  } catch (e) {
    process.parentPort.postMessage({ type: 'run-error', message: e.message, code: e.code ?? null });
  }
  process.exit(0);
});
