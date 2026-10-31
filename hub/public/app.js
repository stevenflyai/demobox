// DemoBox hub: a sidebar of demos from /api/demos and the selected demo embedded on the right.
// Polls status, starts and stops demos, and keeps one frame per running demo so switching keeps its state.

import { t, lang, setLang, applyStatic, LANGS } from './i18n.js';

const $ = (id) => document.getElementById(id);
const els = { nav: $('demos'), bar: $('bar'), stage: $('stage'), empty: $('empty'), notice: $('notice'), lang: $('lang') };
const SELECTED = 'demobox.selected';
const pending = new Set(); // ids with a start/stop request in flight
const logOpen = new Set(); // ids whose Output panel is expanded
const frames = new Map();  // id → iframe, created when the demo first runs
const html = new WeakMap(); // last markup per element, so polling doesn't reset focus
let demos = [];
let selected = location.hash.slice(1) || saved();
let timer = null;

applyStatic();
for (const [code, name] of Object.entries(LANGS)) els.lang.append(new Option(name, code));
els.lang.value = lang;
els.lang.addEventListener('change', () => {
  setLang(els.lang.value);
  render();
  if (!els.notice.hidden && els.notice.dataset.key) showNotice(t(els.notice.dataset.key), els.notice.dataset.key);
});

document.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-select]');
  if (pick) return select(pick.dataset.select);
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  if (btn.dataset.action === 'reload') return reloadFrame(btn.dataset.id);
  act(btn.dataset.id, btn.dataset.action);
});
document.addEventListener('toggle', (e) => {
  if (!e.target.matches?.('details.log')) return;
  if (e.target.open) logOpen.add(e.target.dataset.id); else logOpen.delete(e.target.dataset.id);
}, true);
window.addEventListener('hashchange', () => select(location.hash.slice(1)));

refresh();

async function refresh() {
  clearTimeout(timer);
  try {
    const res = await fetch('/api/demos');
    ({ demos } = await res.json());
    els.notice.hidden = true;
  } catch {
    showNotice(t('notice.unreachable'), 'notice.unreachable');
  }
  if (!demos.some((d) => d.id === selected)) selected = demos[0]?.id;
  render();
  const busy = demos.some((d) => d.phase === 'installing' || (d.phase === 'starting' && !d.running)) || pending.size;
  timer = setTimeout(refresh, busy ? 1000 : 3000);
}

function select(id) {
  if (!id || !demos.some((d) => d.id === id)) return;
  selected = id;
  try { localStorage.setItem(SELECTED, id); } catch { /* storage unavailable */ }
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
  render();
}

function render() {
  const d = demos.find((x) => x.id === selected);
  setHtml(els.nav, demos.map(navItem).join(''));
  setHtml(els.bar, d ? bar(d) : '');
  syncFrames();
  const live = d && isLive(d);
  els.empty.hidden = !!live;
  if (!live) setHtml(els.empty, d ? emptyCard(d) : `<p class="muted">${t('empty.none')}</p>`);
}

// One iframe per running demo; hidden ones keep their state until the demo stops.
function syncFrames() {
  for (const d of demos) {
    let frame = frames.get(d.id);
    if (!isLive(d)) {
      frame?.remove();
      frames.delete(d.id);
      continue;
    }
    const src = `${d.url}/?lang=${lang}`;
    if (!frame) {
      frame = document.createElement('iframe');
      frame.className = 'frame';
      frame.allow = 'microphone; autoplay; clipboard-write';
      els.stage.append(frame);
      frames.set(d.id, frame);
    }
    if (frame.dataset.src !== src) frame.src = frame.dataset.src = src;
    frame.title = name(d);
    frame.hidden = d.id !== selected;
  }
}

// The demo is another origin, so reload by reassigning src rather than through contentWindow.
function reloadFrame(id) {
  const frame = frames.get(id);
  if (frame) frame.src = frame.dataset.src;
}

function navItem(d) {
  const st = status(d);
  const current = d.id === selected;
  return `
    <li>
      <button class="nav-item" data-select="${esc(d.id)}" data-state="${st.key}" ${current ? 'aria-current="page"' : ''}>
        <span class="dot" aria-hidden="true"></span>
        <span class="nav-text">
          <b>${esc(name(d))}</b>
          <small>${esc(tr(d).tagline || d.tagline)}</small>
        </span>
        <span class="sr-only">${esc(st.text)}</span>
      </button>
    </li>`;
}

function bar(d) {
  const st = status(d);
  const live = isLive(d);
  const actions = [
    live ? `<button class="icon-btn" data-action="reload" data-id="${esc(d.id)}" title="${t('btn.reload')}" aria-label="${t('btn.reload')}">${ICON.reload}</button>` : '',
    live ? `<a class="icon-btn" href="${esc(`${d.url}/?lang=${lang}`)}" target="_blank" rel="noopener" title="${t('btn.newTab')}" aria-label="${t('btn.newTab')}">${ICON.external}</a>` : '',
    live ? control(d) : '', // a stopped demo's Start button is on its card
  ].join('');
  return `
    <div class="bar-title">
      <h2>${esc(name(d))}</h2>
      <span class="pill" data-state="${st.key}"><span class="dot" aria-hidden="true"></span>${esc(st.text)}</span>
    </div>
    <span class="bar-where"><code>${esc(d.dir)}/</code> · localhost:${d.port}</span>
    <div class="bar-actions">${actions}</div>
    ${live ? problems(d) : ''}`;
}

function emptyCard(d) {
  const st = status(d);
  const log = d.log?.length
    ? `<details class="log" data-id="${esc(d.id)}" ${logOpen.has(d.id) ? 'open' : ''}><summary>${t('log.title')}</summary><pre>${esc(d.log.join('\n'))}</pre></details>`
    : '';
  const hint = d.foreign ? t('empty.foreign', { port: d.port }) : st.key === 'busy' ? t('empty.starting') : t('empty.stopped');
  return `
    <div class="empty-card">
      <p class="eyebrow">${(tr(d).tags || d.tags || []).map(esc).join(' · ')}</p>
      <h2>${esc(name(d))}</h2>
      <p class="empty-tagline">${esc(tr(d).tagline || d.tagline)}</p>
      <p class="empty-desc">${esc(tr(d).description || d.description)}</p>
      <div class="empty-foot">
        ${control(d, true)}
        <span class="muted">${esc(hint)}</span>
      </div>
      ${log}
    </div>`;
}

function control(d, large = false) {
  const busy = pending.has(d.id) || d.phase === 'installing' || (d.phase === 'starting' && !d.running);
  const cls = large ? 'btn primary' : 'btn';
  if (d.managed) return `<button class="btn" data-action="stop" data-id="${esc(d.id)}" ${busy ? 'disabled' : ''}>${t('btn.stop')}</button>`;
  if (d.running) return '';
  return `<button class="${cls}" data-action="start" data-id="${esc(d.id)}" ${busy ? 'disabled' : ''}>${busy ? t('btn.starting') : t('btn.start')}</button>`;
}

function problems(d) {
  if (d.ready || !d.problems?.length) return '';
  return `
    <div class="problems">
      <ul>${d.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <p>${t('hint.env', { file: esc(`${d.dir}/.env`) })}</p>
    </div>`;
}

function status(d) {
  if (pending.has(d.id)) return { key: 'busy', text: t('status.working') };
  if (d.phase === 'installing') return { key: 'busy', text: t('status.installing') };
  if (d.foreign) return { key: 'error', text: t('status.foreign', { port: d.port }) };
  if (d.running) return d.ready ? { key: 'ready', text: t('status.running') } : { key: 'setup', text: t('status.setup') };
  if (d.phase === 'starting') return { key: 'busy', text: t('status.starting') };
  if (d.phase === 'exited' && d.exitCode) return { key: 'error', text: t('status.exited', { code: d.exitCode }) };
  return { key: 'stopped', text: t('status.stopped') };
}

async function act(id, action) {
  pending.add(id);
  refresh();
  try {
    const res = await fetch(`/api/demos/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok && data.error) showNotice(data.error);
  } catch (err) {
    showNotice(err.message);
  }
  pending.delete(id);
  setTimeout(refresh, 600);
}

const isLive = (d) => d.running && !d.foreign;
const tr = (d) => (lang !== 'en' && d.i18n?.[lang]) || {}; // optional translations from demos.json
const name = (d) => tr(d).name || d.name;

function setHtml(el, markup) {
  if (html.get(el) === markup) return;
  html.set(el, markup);
  el.innerHTML = markup;
}

function saved() {
  try { return localStorage.getItem(SELECTED) || ''; } catch { return ''; }
}

// key lets a translated notice be re-rendered when the language changes
function showNotice(text, key = '') {
  els.notice.textContent = text;
  els.notice.dataset.key = key;
  els.notice.hidden = false;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const ICON = {
  reload: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10a6 6 0 1 1-1.76-4.24M16 4v3.5h-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  external: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 4h5v5M16 4l-7 7M14 12v3.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5H8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
