'use strict';

// Everything TrustFall writes lives under one folder, so "delete all data"
// is a single rm -rf and the consent screen can show the exact path.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const DATA = path.resolve(process.env.TRUSTFALL_DATA || path.join(ROOT, 'data'));

const dirs = {
  root: DATA,
  clips: path.join(DATA, 'clips'),
  runs: path.join(DATA, 'runs'),
  tmp: path.join(DATA, 'tmp'),
};

function ensure() {
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function listClips() {
  ensure();
  return fs.readdirSync(dirs.clips)
    .map((id) => readJson(path.join(dirs.clips, id, 'clip.json')))
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function listRuns() {
  ensure();
  return fs.readdirSync(dirs.runs)
    .map((id) => readJson(path.join(dirs.runs, id, 'summary.json')))
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function deleteAll() {
  fs.rmSync(DATA, { recursive: true, force: true });
  ensure();
}

function apiKey() {
  return (process.env.SMARTSPECTRA_API_KEY || '').trim();
}

module.exports = { ROOT, DATA, dirs, ensure, stamp, readJson, writeJson, listClips, listRuns, deleteAll, apiKey };
