'use strict';

const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const watch = process.argv.includes('--watch');

const builds = [
  {
    entryPoints: [path.join(root, 'src/main/preload.js')],
    outfile: path.join(root, 'dist/preload.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    entryPoints: [path.join(root, 'src/renderer/app.js')],
    outfile: path.join(root, 'dist/renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    sourcemap: 'linked',
  },
];

(async () => {
  for (const b of builds) {
    const opts = { ...b, logLevel: 'warning' };
    if (watch) await (await esbuild.context(opts)).watch();
    else await esbuild.build(opts);
  }
  if (!watch) console.log('built dist/preload.js and dist/renderer.js');
})().catch((e) => { console.error(e); process.exit(1); });
