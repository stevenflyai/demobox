// Decision models demo: edit a scenario, run it on every configured provider, compare the answers row by row.

import { SCENARIOS } from './scenarios.js';
import { t, lang, setLang, applyStatic, LANGS } from './i18n.js';

const $ = (id) => document.getElementById(id);
const els = {
  providers: $('providers'),
  preset: $('preset'),
  state: $('state'),
  questions: $('questions'),
  addQuestion: $('addQuestion'),
  runBtn: $('runBtn'),
  repeat: $('repeat'),
  warm: $('warm'),
  warmStatus: $('warmStatus'),
  notice: $('notice'),
  results: $('results'),
  resultsEmpty: $('resultsEmpty'),
  protocol: $('protocol'),
  protocolSection: $('protocolSection'),
  questionTpl: $('questionTpl'),
  lang: $('lang'),
};

const DRAFT_KEY = 'decision-demo.draft';
const WARM_KEY = 'decision-demo.warm';
const WARM_EVERY_MS = 20_000;

let providers = [];       // from /api/config
let runs = {};            // providerId → { status, latencies: [], last: response | null }
let ranQuestions = [];    // the questions of the last run, so editing doesn't reshuffle the results
let running = false;
let warmTimer = null;
let tokenNoteOpen = false; // keeps the explanation expanded across re-renders

init();

async function init() {
  applyStatic();
  for (const [code, name] of Object.entries(LANGS)) els.lang.append(new Option(name, code));
  els.lang.value = lang;
  els.lang.addEventListener('change', () => switchLang(els.lang.value));
  for (const s of SCENARIOS) els.preset.append(new Option(scenarioTitle(s), s.id));
  const draft = loadDraft();
  if (draft) {
    els.preset.value = SCENARIOS.some((s) => s.id === draft.preset) ? draft.preset : SCENARIOS[0].id;
    loadScenario(draft);
  } else {
    loadScenario(SCENARIOS[0]);
  }

  els.preset.addEventListener('change', () => {
    loadScenario(SCENARIOS.find((s) => s.id === els.preset.value));
    saveDraft();
  });
  els.addQuestion.addEventListener('click', () => {
    addQuestion({ name: `q${els.questions.children.length + 1}`, type: 'yesno', instructions: '', options: [] }).querySelector('.q-instructions').focus();
    saveDraft();
  });
  els.state.addEventListener('input', saveDraft);
  els.questions.addEventListener('input', saveDraft);
  els.runBtn.addEventListener('click', run);
  els.results.addEventListener('toggle', (e) => {
    if (e.target.matches('.token-why')) tokenNoteOpen = e.target.open;
  }, true);

  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    providers = cfg.providers;
    if (cfg.hubUrl) document.getElementById('home').href = cfg.hubUrl;
  } catch {
    showNotice(t('notice.unreachable'));
    return;
  }
  renderProviders();
  els.runBtn.disabled = false;
  setupWarm();
  if (!providers.some((p) => p.ready)) {
    showNotice(t('notice.noProvider'), 'info');
  }
}

// ───────────────────────── language ─────────────────────────

function switchLang(next) {
  setLang(next);
  for (const o of els.preset.options) o.textContent = scenarioTitle(SCENARIOS.find((s) => s.id === o.value));
  for (const li of els.questions.children) li.querySelector('.q-type').dispatchEvent(new Event('change'));
  if (!running) els.runBtn.textContent = t('btn.run');
  renderProviders();
  render();
  scheduleWarm(true);
}

// Preset content stays as written (it is the model input); only the titles are translated.
function scenarioTitle(s) {
  return t(`scenario.${s.id}`, null, s.title);
}

// ───────────────────────── editor ─────────────────────────

function loadScenario(s) {
  els.state.value = s.state;
  els.questions.replaceChildren();
  for (const q of s.questions) addQuestion(q);
}

function addQuestion(q) {
  const li = els.questionTpl.content.firstElementChild.cloneNode(true);
  applyStatic(li);
  const type = li.querySelector('.q-type');
  li.querySelector('.q-name').value = q.name;
  type.value = q.type;
  li.querySelector('.q-instructions').value = q.instructions;
  const optionsBox = li.querySelector('.q-options');
  optionsBox.value = (q.options || []).map((o) => (o.description ? `${o.value}: ${o.description}` : o.value)).join('\n');
  optionsBox.rows = Math.max(3, (q.options || []).length + 1);
  const sync = () => {
    li.dataset.type = type.value;
    li.querySelector('.q-options-label').textContent =
      type.value === 'score' ? t('q.optionsScore') : t('q.optionsChoice');
  };
  type.addEventListener('change', sync);
  li.querySelector('.q-remove').addEventListener('click', () => { li.remove(); saveDraft(); });
  sync();
  els.questions.append(li);
  return li;
}

function readQuestions() {
  return [...els.questions.children].map((li) => {
    const type = li.querySelector('.q-type').value;
    const options = type === 'yesno' ? [] : li.querySelector('.q-options').value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const i = line.search(/[:：]/);
        return i > 0 ? { value: line.slice(0, i).trim(), description: line.slice(i + 1).trim() } : { value: line, description: '' };
      });
    return {
      name: li.querySelector('.q-name').value.trim(),
      type,
      instructions: li.querySelector('.q-instructions').value.trim(),
      options,
    };
  });
}

// JSON objects are sent as structured state (systemone accepts objects; the Decisions API gets the JSON text).
function readState() {
  const text = els.state.value.trim();
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch { /* plain text that starts with a brace */ }
  }
  return text;
}

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ preset: els.preset.value, state: els.state.value, questions: readQuestions() }));
  } catch { /* storage unavailable */ }
}

// ───────────────────────── run ─────────────────────────

async function run() {
  if (running) return;
  hideNotice();
  const state = readState();
  const questions = readQuestions();
  if (!state || (typeof state === 'string' && !state.trim())) return showNotice(t('notice.noState'));
  if (!questions.length) return showNotice(t('notice.noQuestions'));

  running = true;
  els.runBtn.disabled = true;
  els.runBtn.textContent = t('btn.running');
  ranQuestions = questions;
  const repeat = Number(els.repeat.value) || 1;
  runs = Object.fromEntries(providers.map((p) => [p.id, { status: p.ready ? 'running' : 'off', latencies: [], last: null }]));
  render();

  await Promise.all(providers.filter((p) => p.ready).map(async (p) => {
    const r = runs[p.id];
    for (let i = 0; i < repeat; i++) {
      let data;
      try {
        const res = await fetch('/api/decide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: p.id, state, questions }),
        });
        data = await res.json();
      } catch (err) {
        data = { ok: false, error: t('notice.serverError', { msg: err.message }) };
      }
      r.last = data;
      if (data.latencyMs != null && data.ok) r.latencies.push(data.latencyMs);
      if (!data.ok) { r.status = 'error'; break; }
      r.status = i === repeat - 1 ? 'done' : 'running';
      render();
    }
    render();
  }));

  running = false;
  els.runBtn.disabled = false;
  els.runBtn.textContent = t('btn.run');

  // A validation error is the same for every provider, so show it once above the results.
  const errors = Object.values(runs).filter((r) => r.status === 'error' && r.last && !r.last.status && !r.last.latencyMs);
  if (errors.length && errors.length === providers.filter((p) => p.ready).length) showNotice(errors[0].last.error);
}

// ───────────────────────── warm connections ─────────────────────────

// Pings run only while the box is ticked and the page is visible, so an idle tab doesn't keep sockets open.
function setupWarm() {
  let on = true;
  try { on = localStorage.getItem(WARM_KEY) !== 'off'; } catch { /* storage unavailable */ }
  els.warm.checked = on;
  els.warm.addEventListener('change', () => {
    try { localStorage.setItem(WARM_KEY, els.warm.checked ? 'on' : 'off'); } catch { /* storage unavailable */ }
    scheduleWarm(true);
  });
  document.addEventListener('visibilitychange', () => scheduleWarm(true));
  scheduleWarm(true);
}

function scheduleWarm(now = false) {
  clearTimeout(warmTimer);
  if (!els.warm.checked) { els.warmStatus.textContent = ''; return; }
  if (document.hidden) return;
  warmTimer = setTimeout(warmUp, now ? 0 : WARM_EVERY_MS);
}

async function warmUp() {
  if (!running) {
    try {
      const { providers: pings } = await (await fetch('/api/warm', { method: 'POST' })).json();
      const ok = pings.filter((x) => x.ok && x.roundTripMs != null);
      els.warmStatus.textContent = ok.length
        ? t('warm.status', { list: ok.map((x) => `${providers.find((p) => p.id === x.id)?.label ?? x.id} ~${x.roundTripMs} ms`).join(' · ') })
        : '';
    } catch { /* server gone; the next run reports it */ }
  }
  scheduleWarm();
}

// ───────────────────────── render ─────────────────────────

function renderProviders() {
  els.providers.replaceChildren(...providers.map((p) => {
    const li = document.createElement('li');
    li.className = `provider p-${p.id}`;
    li.dataset.ready = p.ready;
    li.innerHTML = `
      <span class="swatch" aria-hidden="true"></span>
      <span class="provider-text">
        <b>${esc(p.label)}</b>
        <small>${p.ready ? esc(`${p.model} · ${p.host}`) : t('provider.notConfigured')}</small>
      </span>`;
    if (!p.ready) li.title = t('provider.setHint', { vars: p.problems.join(', ').replace(/ is empty/g, '') });
    return li;
  }));
}

function render() {
  const has = Object.keys(runs).length > 0;
  els.resultsEmpty.hidden = has;
  els.results.hidden = !has;
  els.protocolSection.hidden = !has;
  if (!has) return;

  els.results.style.setProperty('--cols', providers.length);
  const head = `<div class="cell corner">${t('corner.question')}</div>` + providers.map(headerCell).join('') + priceRow();
  const rows = ranQuestions.map((q, qi) => {
    const verdict = agreement(q, qi);
    return `
      <div class="cell q-cell">
        <span class="q-title">${esc(q.name)}</span>
        <span class="q-kind">${t(`kind.${q.type}`)}</span>
        <p class="q-text">${esc(q.instructions)}</p>
        ${verdict ? `<span class="verdict" data-agree="${verdict.agree}">${verdict.text}</span>` : ''}
      </div>` + providers.map((p) => answerCell(p, q, qi)).join('');
  }).join('');
  els.results.innerHTML = head + rows + tokenNote();
  renderProtocol();
}

function headerCell(p) {
  const r = runs[p.id];
  let meta = '';
  if (r.status === 'off') meta = `<span class="muted">${t('head.notConfigured')}</span>`;
  else if (r.latencies.length) {
    const lat = r.latencies.length > 1
      ? `${median(r.latencies)} ms <small>${t('head.median', { n: r.latencies.length, min: Math.min(...r.latencies), max: Math.max(...r.latencies) })}</small>`
      : `${r.latencies[0]} ms`;
    const u = r.last?.usage;
    meta = `<span class="latency">${lat}</span>${timingBar(r.last?.timing)}${u?.input != null ? `<span class="muted">${t('head.tokens', { in: u.input, out: u.output ?? 0 })}</span>` : ''}`;
  } else if (r.status === 'running') meta = `<span class="muted">${t('head.waiting')}</span>`;
  else if (r.status === 'error') meta = `<span class="err">${r.last?.status ? `HTTP ${r.last.status}` : t('head.failed')}</span>`;

  return `
    <div class="cell p-head p-${p.id}" data-status="${r.status}">
      <span class="p-name"><span class="swatch" aria-hidden="true"></span>${esc(p.label)}</span>
      <span class="muted p-model">${esc(r.last?.model || p.model)}</span>
      ${meta}
    </div>`;
}

// List price per provider, and what this run's token counts would cost at a million runs.
function priceRow() {
  const costs = Object.fromEntries(providers.map((p) => [p.id, runCost(p)]));
  const known = Object.values(costs).filter((c) => c != null);
  const lowest = known.length > 1 ? Math.min(...known) : null;
  return `<div class="cell corner price-corner">${t('price.title')}<small>${t('price.unit')}</small></div>` + providers.map((p) => {
    if (!p.price) return `<div class="cell price-cell p-${p.id}"><span class="muted">${t('price.notSet', { prefix: esc(p.envPrefix) })}</span></div>`;
    const rate = (v) => (v ? usd(v) : t('price.free'));
    const cost = costs[p.id];
    return `
      <div class="cell price-cell p-${p.id}">
        <span class="price">${t('price.rates', { input: rate(p.price.input), output: rate(p.price.output) })}</span>
        ${cost != null ? `<span class="muted">${t('price.perRuns', { cost: usd(cost) })}${cost === lowest ? ` <span class="lowest">${t('price.lowest')}</span>` : ''}</span>` : ''}
      </div>`;
  }).join('');
}

// Shown once two providers have reported usage: the live counts, plus what we measured about why they differ.
function tokenNote() {
  const counted = providers
    .map((p) => ({ p, u: runs[p.id]?.last?.ok ? runs[p.id].last.usage : null }))
    .filter((x) => x.u?.input != null);
  if (counted.length < 2) return '';
  const list = counted.map((x) => `${esc(x.p.label)} <b>${x.u.input}</b>`).join(' · ');
  return `
    <div class="cell token-note">
      <p>${t('tokens.compare', { list })}</p>
      <details class="token-why" ${tokenNoteOpen ? 'open' : ''}>
        <summary>${t('tokens.why')}</summary>
        <ul>
          <li>${t('tokens.fixed')}</li>
          <li>${t('tokens.language')}</li>
          <li>${t('tokens.short')}</li>
          <li>${t('tokens.gpt')}</li>
        </ul>
        <p class="muted">${t('tokens.source')}</p>
      </details>
    </div>`;
}

// Price per run × 1M runs = tokens × price per 1M tokens.
function runCost(p) {
  const u = runs[p.id]?.last?.ok ? runs[p.id].last.usage : null;
  if (!p.price || u?.input == null) return null;
  return u.input * p.price.input + (u.output ?? 0) * p.price.output;
}

function usd(v) {
  if (v >= 100) return `$${v.toFixed(0)}`;
  // Below $1 keep two significant digits but never fewer than two decimals: $0.10, $0.042.
  return `$${v.toFixed(v >= 1 ? 2 : Math.max(2, 1 - Math.floor(Math.log10(v))))}`;
}

// Bars share one scale across providers, so their lengths compare directly.
function timingBar(tm) {
  if (!tm) return '';
  const scale = Math.max(...Object.values(runs).map((r) => r.last?.timing?.totalMs || 0), 1);
  const pct = (ms) => `${((ms / scale) * 100).toFixed(1)}%`;
  const text = tm.reused
    ? t('timing.warm', { ms: tm.responseMs })
    : t('timing.cold', { connect: tm.connectMs, response: tm.responseMs });
  const rtt = tm.roundTripMs != null ? `<span class="muted">${t('timing.rtt', { ms: tm.roundTripMs })}</span>` : '';
  return `
    <span class="tbar" role="img" aria-label="${esc(text)}">
      ${tm.connectMs ? `<span class="seg connect" style="width:${pct(tm.connectMs)}"></span>` : ''}
      <span class="seg response" style="width:${pct(tm.responseMs)}"></span>
    </span>
    <span class="muted">${esc(text)}</span>${rtt}`;
}

function answerCell(p, q, qi) {
  const r = runs[p.id];
  const tag = `<span class="cell-tag p-${p.id}"><span class="swatch" aria-hidden="true"></span>${esc(p.label)}</span>`;
  const wrap = (body, cls = '') => `<div class="cell a-cell p-${p.id} ${cls}">${tag}${body}</div>`;

  if (r.status === 'off') return wrap(`<span class="muted">${t('cell.off', { prefix: esc(p.envPrefix) })}</span>`, 'off');
  if (r.status === 'error') return wrap(qi === 0 ? `<p class="err">${esc(r.last?.error || t('cell.failed'))}</p>` : '', 'off');
  const a = r.last?.ok ? r.last.answers?.[qi] : null;
  if (!a) return wrap(`<span class="skeleton" aria-label="${t('cell.waiting')}"></span>`);

  if (a.kind === 'refusal') return wrap(`<span class="muted">${t('cell.refused')}</span>`);
  if (a.kind === 'missing') return wrap(`<span class="muted">${t('cell.missing')}</span>`);

  if (a.kind === 'yesno') {
    const pr = a.probability;
    if (pr == null) return wrap(`<span class="muted">${t('cell.noProbability')}</span>`);
    return wrap(`
      <div class="big"><b>${pr >= 0.5 ? t('cell.yes') : t('cell.no')}</b><span>${t('cell.pctYes', { p: pct(pr) })}</span></div>
      <div class="bar" role="img" aria-label="${t('cell.pctYesAria', { p: pct(pr) })}"><i style="width:${pr * 100}%"></i></div>`);
  }

  const bars = (a.dist || []).map((d, i) => {
    const picked = a.kind === 'choice' ? d.label === a.choice : a.score != null && Math.round(a.score) === i;
    return `
      <li class="${picked ? 'picked' : ''}">
        <span class="d-label">${esc(d.label)}</span>
        <span class="d-bar"><i style="width:${(d.p ?? 0) * 100}%"></i></span>
        <span class="d-val">${d.p == null ? '–' : pct(d.p)}</span>
      </li>`;
  }).join('');
  const conf = a.confidence != null ? t('cell.confidence', { p: pct(a.confidence) }) : '';

  if (a.kind === 'choice') {
    return wrap(`<div class="big"><b>${esc(a.choice ?? '—')}</b><span>${conf}</span></div><ol class="dist">${bars}</ol>`);
  }
  const max = q.options.length - 1;
  const nearest = a.score != null ? q.options[Math.min(max, Math.max(0, Math.round(a.score)))]?.value : null;
  const sub = [nearest && esc(nearest), conf].filter(Boolean).join(' · ');
  return wrap(`
    <div class="big"><b>${a.score != null ? a.score.toFixed(2) : '—'}<small> / ${max}</small></b><span>${sub}</span></div>
    <ol class="dist">${bars}</ol>`);
}

// Do the providers that answered land on the same decision?
function agreement(q, qi) {
  const answers = providers
    .map((p) => (runs[p.id]?.last?.ok ? runs[p.id].last.answers?.[qi] : null))
    .filter((a) => a && a.kind === (q.type === 'yesno' ? 'yesno' : q.type));
  if (answers.length < 2 || providers.some((p) => runs[p.id]?.status === 'running')) return null;

  if (q.type === 'yesno') {
    const sides = new Set(answers.filter((a) => a.probability != null).map((a) => a.probability >= 0.5));
    const spread = spreadOf(answers.map((a) => a.probability));
    return { agree: sides.size === 1, text: sides.size === 1 ? t('verdict.agreeSpread', { spread: pct(spread) }) : t('verdict.disagree') };
  }
  if (q.type === 'choice') {
    const picks = new Set(answers.map((a) => a.choice));
    return { agree: picks.size === 1, text: picks.size === 1 ? t('verdict.agree') : t('verdict.disagree') };
  }
  const spread = spreadOf(answers.map((a) => a.score));
  return { agree: spread < 0.5, text: t(spread < 0.5 ? 'verdict.agreeSpread' : 'verdict.apart', { spread: spread.toFixed(2) }) };
}

function renderProtocol() {
  const open = new Set([...els.protocol.querySelectorAll('details[open]')].map((x) => x.dataset.id));
  const items = providers.filter((p) => runs[p.id]?.last).map((p) => {
    const d = runs[p.id].last;
    const status = d.status ? `HTTP ${d.status}` : d.ok ? '' : t('wire.noResponse');
    return `
      <details class="wire p-${p.id}" data-id="${p.id}" ${open.has(p.id) ? 'open' : ''}>
        <summary>
          <span class="p-name"><span class="swatch" aria-hidden="true"></span>${esc(p.label)}</span>
          <code>POST ${esc(d.endpoint || '')}</code>
          <span class="muted">${[status, d.latencyMs != null ? `${d.latencyMs} ms` : '', d.timing ? (d.timing.reused ? t('wire.warm') : t('wire.connect', { ms: d.timing.connectMs })) : ''].filter(Boolean).join(' · ')}</span>
        </summary>
        <div class="wire-body">
          <div><h3>${t('wire.request')}</h3><pre>${esc(JSON.stringify(d.request ?? null, null, 2))}</pre></div>
          <div><h3>${t('wire.response')}</h3><pre>${esc(typeof d.response === 'string' ? d.response : JSON.stringify(d.response ?? d.error ?? null, null, 2))}</pre></div>
        </div>
      </details>`;
  });
  els.protocol.innerHTML = items.join('') || `<p class="empty">${t('protocol.empty')}</p>`;
}

// ───────────────────────── helpers ─────────────────────────

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function spreadOf(xs) {
  const v = xs.filter((x) => x != null);
  return v.length ? Math.max(...v) - Math.min(...v) : 0;
}

function pct(p) {
  return `${Math.round(p * 100)}%`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function showNotice(text, kind = 'error') {
  els.notice.textContent = text;
  els.notice.classList.toggle('info', kind === 'info');
  els.notice.hidden = false;
}

function hideNotice() {
  els.notice.hidden = true;
}
