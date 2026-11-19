'use strict';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const VERDICT = {
  held: { label: 'Held', icon: '✓', help: 'Readings stayed stable and within tolerance.' },
  caught: { label: 'Flagged', icon: '!', help: 'The SDK lowered its confidence. Honest behaviour.' },
  fooled: { label: 'Confident but off', icon: '✕', help: 'Readings drifted while still marked stable.' },
  refused: { label: 'No reading', icon: '–', help: 'The SDK produced no readings. Honest behaviour.' },
};

function chip(verdict, prefix = '') {
  if (!verdict) return '<span class="chip pending">…</span>';
  const v = VERDICT[verdict];
  return `<span class="chip ${verdict}" title="${esc(v.help)}"><i>${v.icon}</i>${prefix ? `${esc(prefix)} · ` : ''}${esc(v.label)}</span>`;
}

const fmt = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : Number(x).toFixed(d));

// Line icons on a 24px grid, drawn in currentColor.
const ICON_PATHS = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  record: '<rect x="2.5" y="6" width="13" height="12" rx="3"/><path d="M15.5 10.5l5-3v9l-5-3z"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',
  bars: '<path d="M5 19v-8M12 19V5M19 19v-6M3 21h18"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z"/><path d="M8.8 12l2.2 2.2 4.2-4.4"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5v-3a4 4 0 0 1 8 0v3"/>',
  arrow: '<path d="M7 17L17 7M8 7h9v9"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .6 3.2 2.3 3.5 5.2"/>',
  heart: '<path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 3c0 5.6-7.5 10-7.5 10z"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

// Crash-test target: the mark painted on test dummies.
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="#d7f36b"/><path d="M16 3a13 13 0 0 1 13 13H16z" fill="#111"/><path d="M16 29A13 13 0 0 1 3 16h13z" fill="#111"/></svg>';

function tooltip(html, ev) {
  const t = $('#tooltip');
  if (!html) { t.hidden = true; return; }
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = ev.clientX + pad; let y = ev.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}

function modal(html, bind) {
  const m = $('#modal');
  m.innerHTML = `<div class="card">${html}</div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  m.onclick = (e) => { if (e.target === m) close(); };
  if (bind) bind(m, close);
  return close;
}

function confirmModal({ title, body, ok = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    modal(`<h2>${esc(title)}</h2><p class="muted" style="margin:10px 0 20px">${body}</p>
      <div class="row"><span class="spacer"></span><button class="btn" data-x>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div>`,
    (m, close) => {
      $('[data-x]', m).onclick = () => { close(); resolve(false); };
      $('[data-ok]', m).onclick = () => { close(); resolve(true); };
    });
  });
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'tooltip';
  el.style.cssText = 'left:50%;bottom:28px;top:auto;transform:translateX(-50%);';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

module.exports = { esc, $, $$, VERDICT, chip, fmt, icon, LOGO, tooltip, modal, confirmModal, toast };
