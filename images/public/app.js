// Image models demo: send one prompt to every selected model in parallel, then compare the images side by side
// with their time, checklist score (ticked by hand or by the judge), quality rating, and cost.

import { SCENARIOS } from './scenarios.js';
import { t, lang, setLang, applyStatic, LANGS } from './i18n.js';

const $ = (id) => document.getElementById(id);
const els = {
  providers: $('providers'),
  lang: $('lang'),
  preset: $('preset'),
  prompt: $('prompt'),
  checks: $('checks'),
  aspect: $('aspect'),
  size: $('size'),
  quality: $('quality'),
  grounding: $('grounding'),
  sizeNote: $('sizeNote'),
  modelPicks: $('modelPicks'),
  runBtn: $('runBtn'),
  repeat: $('repeat'),
  notice: $('notice'),
  judgeTools: $('judgeTools'),
  autoJudge: $('autoJudge'),
  judgeBtn: $('judgeBtn'),
  score: $('score'),
  gallery: $('gallery'),
  resultsEmpty: $('resultsEmpty'),
  protocol: $('protocol'),
  protocolSection: $('protocolSection'),
  lightbox: $('lightbox'),
  lbImg: $('lbImg'),
  lbCaption: $('lbCaption'),
  lbPrev: $('lbPrev'),
  lbNext: $('lbNext'),
  lbClose: $('lbClose'),
};

const DRAFT_KEY = 'images-demo.draft';
const ASPECTS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'];
const FALLBACK_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
const MAX_CHECKS = 20;
const JUDGE_CONCURRENCY = 4;

let providers = [];   // from /api/config
let judge = null;     // { ready, model, host, problems }
let sizes = null;     // { standard: { '1:1': [w, h], … }, large: … }
let qualities = FALLBACK_QUALITIES; // GPT-Image quality levels, from /api/config
let picks = null;     // Set of provider ids to run; null until the draft or config sets it
let runs = {};        // providerId → { status: off|skipped|running|done|error, images: [], selected, error, wire, since }
let ran = null;       // settings of the last run, so editing the form doesn't change the results
let running = false;
let ticker = null;
let lbIndex = 0;
const lastHtml = new WeakMap(); // last markup per element, so unchanged parts (and their images) aren't rebuilt

init();

async function init() {
  applyStatic();
  for (const [code, name] of Object.entries(LANGS)) els.lang.append(new Option(name, code));
  els.lang.value = lang;
  els.lang.addEventListener('change', () => switchLang(els.lang.value));
  for (const s of SCENARIOS) els.preset.append(new Option(scenarioTitle(s), s.id));
  fillSelects();

  const draft = loadDraft();
  if (draft) {
    els.preset.value = SCENARIOS.some((s) => s.id === draft.preset) ? draft.preset : SCENARIOS[0].id;
    els.prompt.value = draft.prompt ?? '';
    els.checks.value = draft.checks ?? '';
    if (ASPECTS.includes(draft.aspect)) els.aspect.value = draft.aspect;
    if (draft.size) els.size.value = draft.size;
    if (draft.quality) els.quality.value = draft.quality;
    els.grounding.checked = draft.grounding === true;
    els.autoJudge.checked = draft.autoJudge !== false;
    if (['1', '2', '3'].includes(String(draft.repeat))) els.repeat.value = String(draft.repeat);
    if (Array.isArray(draft.picks)) picks = new Set(draft.picks);
  } else {
    loadScenario(SCENARIOS[0]);
    els.quality.value = 'high';
    els.autoJudge.checked = true;
  }

  els.preset.addEventListener('change', () => {
    loadScenario(SCENARIOS.find((s) => s.id === els.preset.value));
    saveDraft();
  });
  for (const el of [els.prompt, els.checks]) el.addEventListener('input', saveDraft);
  for (const el of [els.aspect, els.size, els.quality, els.grounding, els.repeat, els.autoJudge]) {
    el.addEventListener('change', () => { updateSizeNote(); saveDraft(); });
  }
  els.modelPicks.addEventListener('change', (e) => {
    if (!e.target.matches('input[data-pick]')) return;
    if (e.target.checked) picks.add(e.target.dataset.pick); else picks.delete(e.target.dataset.pick);
    saveDraft();
  });
  els.runBtn.addEventListener('click', run);
  els.judgeBtn.addEventListener('click', judgeAll);
  els.gallery.addEventListener('click', onGalleryClick);
  setupLightbox();

  try {
    const cfg = await (await fetch('/api/config')).json();
    providers = cfg.providers;
    judge = cfg.judge;
    sizes = cfg.sizes;
    if (Array.isArray(cfg.qualities)) { qualities = cfg.qualities; fillSelects(); }
    if (cfg.hubUrl) $('home').href = cfg.hubUrl;
  } catch {
    showNotice(t('notice.unreachable'));
    return;
  }
  if (!picks) picks = new Set(providers.filter((p) => p.ready).map((p) => p.id));
  renderProviders();
  renderPicks();
  updateSizeNote();
  updateJudgeTools();
  els.runBtn.disabled = false;
  if (!providers.some((p) => p.ready)) showNotice(t('notice.noProvider'), 'info');
}

// ───────────────────────── language ─────────────────────────

function switchLang(next) {
  setLang(next);
  for (const o of els.preset.options) o.textContent = scenarioTitle(SCENARIOS.find((s) => s.id === o.value));
  fillSelects();
  if (!running) els.runBtn.textContent = t('btn.run');
  renderProviders();
  renderPicks();
  updateSizeNote();
  render();
}

// Preset content stays as written (it is the model input); only the titles are translated.
function scenarioTitle(s) {
  return t(`scenario.${s.id}`, null, s.title);
}

function fillSelects() {
  const aspect = els.aspect.value || '1:1';
  els.aspect.replaceChildren(...ASPECTS.map((a) => new Option(t(`aspect.${a}`, null, a), a)));
  els.aspect.value = aspect;
  const quality = els.quality.value || 'high';
  els.quality.replaceChildren(...qualities.map((q) => new Option(t(`quality.${q}`, null, q), q)));
  els.quality.value = qualities.includes(quality) ? quality : qualities[0];
}

// ───────────────────────── editor ─────────────────────────

function loadScenario(s) {
  els.prompt.value = s.prompt;
  els.checks.value = s.checks.join('\n');
  els.aspect.value = s.aspect;
  updateSizeNote();
}

function readChecks() {
  return els.checks.value.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, MAX_CHECKS);
}

function updateSizeNote() {
  const dims = sizes?.[els.size.value]?.[els.aspect.value];
  els.sizeNote.textContent = dims ? t('size.note', { w: dims[0], h: dims[1], mp: ((dims[0] * dims[1]) / 1e6).toFixed(1) }) : '';
}

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      preset: els.preset.value,
      prompt: els.prompt.value,
      checks: els.checks.value,
      aspect: els.aspect.value,
      size: els.size.value,
      quality: els.quality.value,
      grounding: els.grounding.checked,
      autoJudge: els.autoJudge.checked,
      repeat: els.repeat.value,
      picks: picks ? [...picks] : undefined,
    }));
  } catch { /* storage unavailable */ }
}

// ───────────────────────── run ─────────────────────────

async function run() {
  if (running) return;
  hideNotice();
  const prompt = els.prompt.value.trim();
  if (!prompt) return showNotice(t('notice.noPrompt'));
  const chosen = providers.filter((p) => p.ready && picks.has(p.id));
  if (!chosen.length) return showNotice(t('notice.noModels'));

  ran = {
    prompt,
    checks: readChecks(),
    aspect: els.aspect.value,
    size: els.size.value,
    quality: els.quality.value,
    webGrounding: els.grounding.checked,
  };
  const repeat = Number(els.repeat.value) || 1;
  runs = Object.fromEntries(providers.map((p) => [p.id, {
    status: !p.ready ? 'off' : chosen.includes(p) ? 'running' : 'skipped',
    images: [], selected: 0, error: null, wire: null, since: null,
  }]));

  running = true;
  els.runBtn.disabled = true;
  els.runBtn.textContent = t('btn.running');
  ticker = setInterval(tick, 100);
  render();

  await Promise.all(chosen.map(async (p) => {
    const r = runs[p.id];
    for (let i = 0; i < repeat; i++) {
      r.since = performance.now();
      render();
      let data;
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: p.id, prompt: ran.prompt, aspect: ran.aspect, size: ran.size, quality: ran.quality, webGrounding: ran.webGrounding }),
        });
        data = await res.json();
      } catch (err) {
        data = { ok: false, error: t('notice.serverError', { msg: err.message }) };
      }
      r.wire = data;
      if (!data.ok) { r.status = 'error'; r.error = data.error; break; }
      const img = {
        ...data.image,
        model: data.model,
        latencyMs: data.latencyMs,
        timing: data.timing,
        usage: data.usage,
        cost: data.cost,
        revisedPrompt: data.revisedPrompt,
        checks: ran.checks.map(() => ({ state: null, by: '', reason: '', judge: null })),
        judge: null,
        stars: 0,
      };
      r.images.push(img);
      r.selected = r.images.length - 1;
      if (i === repeat - 1) r.status = 'done';
      if (els.autoJudge.checked && judge?.ready) judgeImage(img);
    }
    r.since = null;
    render();
  }));

  running = false;
  clearInterval(ticker);
  els.runBtn.disabled = false;
  els.runBtn.textContent = t('btn.run');
  render();

  // A validation error is the same for every model, so show it once above the results.
  const failed = chosen.map((p) => runs[p.id]).filter((r) => r.status === 'error' && !r.wire?.status && !r.wire?.endpoint);
  if (failed.length && failed.length === chosen.length) showNotice(failed[0].error);
}

// Live seconds counter on every image still generating; the final number comes from the server.
function tick() {
  const now = performance.now();
  for (const el of document.querySelectorAll('.elapsed[data-pid]')) {
    const since = runs[el.dataset.pid]?.since;
    if (since != null) el.textContent = `${((now - since) / 1000).toFixed(1)} s`;
  }
}

// ───────────────────────── judge ─────────────────────────

// The judge sees the prompt, the checklist, and the image, but not which model made it.
async function judgeImage(img) {
  if (!judge?.ready || img.judge?.status === 'running') return;
  const spec = ran;
  img.judge = { status: 'running' };
  render();
  let data;
  try {
    const res = await fetch('/api/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageId: img.id, prompt: spec.prompt, checks: spec.checks }),
    });
    data = await res.json();
  } catch (err) {
    data = { ok: false, error: t('notice.serverError', { msg: err.message }) };
  }
  if (!data.ok) {
    img.judge = { status: 'error', error: data.error };
  } else {
    img.judge = { status: 'done', quality: data.quality, notes: data.notes, latencyMs: data.latencyMs };
    data.checks.forEach((verdict, i) => {
      const c = img.checks[i];
      if (!verdict || !c) return;
      c.judge = verdict;
      c.reason = verdict.reason;
      if (c.by !== 'you') { c.state = verdict.pass ? 'pass' : 'fail'; c.by = 'judge'; }
    });
  }
  render();
}

async function judgeAll() {
  const queue = providers.flatMap((p) => runs[p.id]?.images ?? []).filter((img) => !['done', 'running'].includes(img.judge?.status));
  await Promise.all(Array.from({ length: Math.min(JUDGE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await judgeImage(queue.shift());
  }));
}

function updateJudgeTools() {
  els.judgeTools.hidden = !judge?.ready;
  if (!judge?.ready) return;
  const all = providers.flatMap((p) => runs[p.id]?.images ?? []);
  const busy = all.some((img) => img.judge?.status === 'running');
  els.judgeBtn.textContent = busy ? t('judge.running') : t('judge.btn', { model: judge.model });
  els.judgeBtn.disabled = busy || !all.some((img) => img.judge?.status !== 'done');
  els.judgeTools.title = t('judge.title');
}

// ───────────────────────── interaction ─────────────────────────

function onGalleryClick(e) {
  const el = e.target.closest('[data-check],[data-star],[data-thumb],[data-zoom],[data-judge]');
  if (!el) return;
  const action = ['check', 'star', 'thumb', 'zoom', 'judge'].find((k) => el.dataset[k] != null);
  const [pid, idx, extra] = el.dataset[action].split(':');
  const r = runs[pid];
  const img = r?.images[Number(idx)];
  if (!img) return;

  if (action === 'check') {
    // Click cycles: not scored → pass → fail → not scored. A judge verdict flips on the first click, and the hand tick wins.
    const c = img.checks[Number(extra)];
    if (c.by === 'judge') c.state = c.state === 'pass' ? 'fail' : 'pass';
    else c.state = c.state == null ? 'pass' : c.state === 'pass' ? 'fail' : null;
    c.by = 'you';
  } else if (action === 'star') {
    const n = Number(extra);
    img.stars = img.stars === n ? 0 : n;
  } else if (action === 'thumb') {
    r.selected = Number(idx);
  } else if (action === 'zoom') {
    return openLightbox(pid, Number(idx));
  } else {
    return judgeImage(img);
  }
  render();
}

function setupLightbox() {
  els.lbPrev.addEventListener('click', () => showLightbox(lbIndex - 1));
  els.lbNext.addEventListener('click', () => showLightbox(lbIndex + 1));
  els.lbClose.addEventListener('click', () => els.lightbox.close());
  els.lightbox.addEventListener('click', (e) => { if (e.target === els.lightbox) els.lightbox.close(); });
  els.lightbox.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') showLightbox(lbIndex - 1);
    if (e.key === 'ArrowRight') showLightbox(lbIndex + 1);
  });
}

// Every image of the run in model order, so ← / → flips between models at the same pixel size.
function lightboxItems() {
  return providers.flatMap((p) => (runs[p.id]?.images ?? []).map((img, i) => ({ p, img, i })));
}

function openLightbox(pid, idx) {
  const items = lightboxItems();
  const at = items.findIndex((x) => x.p.id === pid && x.i === idx);
  if (at < 0) return;
  showLightbox(at);
  if (!els.lightbox.open) els.lightbox.showModal();
}

function showLightbox(at) {
  const items = lightboxItems();
  if (!items.length) return;
  lbIndex = (at + items.length) % items.length;
  const { p, img, i } = items[lbIndex];
  const n = runs[p.id].images.length;
  els.lbImg.src = img.url;
  els.lbImg.alt = t('img.alt', { model: p.label });
  const passed = img.checks.filter((c) => c.state === 'pass').length;
  const rated = img.checks.filter((c) => c.state).length;
  els.lbCaption.innerHTML = [
    `<b class="p-${p.id}"><span class="swatch" aria-hidden="true"></span>${esc(p.label)}${n > 1 ? ` · ${i + 1}/${n}` : ''}</b>`,
    sec(img.latencyMs),
    img.width ? `${img.width}×${img.height}` : '',
    rated ? t('lb.checks', { pass: passed, total: img.checks.length }) : '',
    img.judge?.status === 'done' ? t('lb.quality', { q: img.judge.quality }) : '',
  ].filter(Boolean).join(' · ');
  const multi = items.length > 1;
  els.lbPrev.hidden = !multi;
  els.lbNext.hidden = !multi;
}

// ───────────────────────── render ─────────────────────────

function renderProviders() {
  setHtml(els.providers, providers.map((p) => `
    <li class="provider p-${p.id}" data-ready="${p.ready}" ${p.ready ? '' : `title="${esc(t('provider.setHint', { vars: p.problems.join(', ').replace(/ is empty/g, '') }))}"`}>
      <span class="swatch" aria-hidden="true"></span>
      <span class="provider-text">
        <b>${esc(p.label)}</b>
        <small>${p.ready ? esc(`${p.model} · ${p.host}`) : t('provider.notConfigured')}</small>
      </span>
    </li>`).join(''));
}

function renderPicks() {
  setHtml(els.modelPicks, providers.map((p) => `
    <label class="pick p-${p.id}" ${p.ready ? '' : `title="${esc(t('provider.setHint', { vars: p.problems.join(', ').replace(/ is empty/g, '') }))}"`}>
      <input type="checkbox" data-pick="${p.id}" ${p.ready && picks.has(p.id) ? 'checked' : ''} ${p.ready ? '' : 'disabled'}>
      <span class="swatch" aria-hidden="true"></span>
      <span>${esc(p.label)}${p.ready ? '' : ` <small class="muted">${t('provider.notConfigured')}</small>`}</span>
    </label>`).join(''));
}

function render() {
  const has = ran != null;
  els.resultsEmpty.hidden = has;
  els.gallery.hidden = !has;
  els.score.hidden = !has;
  els.protocolSection.hidden = !has;
  updateJudgeTools();
  if (!has) return;

  const shown = providers.filter((p) => runs[p.id] && runs[p.id].status !== 'skipped');
  els.score.style.setProperty('--cols', shown.length);
  setHtml(els.score, scoreboard(shown));

  const cards = shown.map((p) => {
    let el = els.gallery.querySelector(`[data-pid="${p.id}"]`);
    if (!el) {
      el = document.createElement('article');
      el.className = `card p-${p.id}`;
      el.dataset.pid = p.id;
      el.innerHTML = '<header class="card-head"></header><div class="shot-wrap"></div><div class="card-body"></div>';
    }
    renderCard(el, p);
    return el;
  });
  if (cards.some((el, i) => els.gallery.children[i] !== el) || els.gallery.children.length !== cards.length) {
    els.gallery.replaceChildren(...cards);
  }

  renderProtocol();
  tick();
}

// ── scoreboard: one column per model, the best value in each row highlighted ──

function scoreboard(shown) {
  const s = Object.fromEntries(shown.map((p) => [p.id, stats(p)]));
  const live = shown.filter((p) => s[p.id].n > 0);
  const best = (key, pickMin) => {
    const vals = live.map((p) => s[p.id][key]).filter((v) => v != null);
    // A tie across every model isn't a "best", so mark nothing.
    if (vals.length < 2 || vals.every((v) => v === vals[0])) return null;
    return pickMin ? Math.min(...vals) : Math.max(...vals);
  };
  const fastest = best('median', true);
  const mostFollowed = live.every((p) => s[p.id].rated > 0) ? best('ratio', false) : null;
  const topQuality = best('quality', false);
  const topStars = best('stars', false);
  const cheapest = best('cost', true);

  const head = `<div class="sc corner"></div>` + shown.map((p) => `
    <div class="sc sc-head p-${p.id}"><span class="p-name"><span class="swatch" aria-hidden="true"></span>${esc(p.label)}</span></div>`).join('');

  const row = (title, sub, cell) => `<div class="sc sc-label">${title}<small>${sub}</small></div>` + shown.map((p) => {
    const r = runs[p.id];
    const st = s[p.id];
    let body;
    if (r.status === 'off') body = `<span class="muted">${t('head.notConfigured')}</span>`;
    else if (!st.n && r.status === 'error') body = `<span class="err">${r.wire?.status ? `HTTP ${r.wire.status}` : t('head.failed')}</span>`;
    else if (!st.n) body = `<span class="skeleton small" aria-label="${t('cell.waiting')}"></span>`;
    else body = cell(p, st);
    return `<div class="sc sc-val p-${p.id}"><span class="sc-tag"><span class="swatch" aria-hidden="true"></span>${esc(p.label)}</span>${body}</div>`;
  }).join('');
  const val = (text, sub = '', isBest = false, pill = '') => `
    <span class="v ${isBest ? 'best' : ''}">${text}${isBest && pill ? ` <span class="pill">${pill}</span>` : ''}</span>${sub ? `<small class="muted">${sub}</small>` : ''}`;

  return head +
    row(t('score.time'), t('score.timeSub'), (p, st) => val(
      sec(st.median),
      st.n > 1 ? t('score.timeRange', { n: st.n, min: sec(st.min), max: sec(st.max) }) : (fastest != null && st.median !== fastest ? t('score.slower', { x: (st.median / fastest).toFixed(1) }) : ''),
      st.median === fastest, t('score.fastest'))) +
    row(t('score.follow'), t('score.followSub', { n: ran.checks.length }), (p, st) => {
      if (!ran.checks.length) return val('—', t('score.noChecklist'));
      if (!st.rated) return val('—', st.judging ? t('score.judging') : t('score.notScored'));
      const rest = st.total - st.rated;
      return val(`${st.pass} / ${st.rated}`, [pct(st.ratio), rest ? t('score.unscored', { n: rest }) : ''].filter(Boolean).join(' · '), st.ratio === mostFollowed, t('score.best'));
    }) +
    (judge?.ready ? row(t('score.quality'), t('score.qualitySub'), (p, st) =>
      st.quality == null
        ? val('—', st.judging ? t('score.judging') : t('score.notJudged'))
        : val(`${st.quality.toFixed(1)}<small> / 10</small>`, st.judging ? t('score.judging') : '', st.quality === topQuality, t('score.best'))) : '') +
    row(t('score.stars'), t('score.starsSub'), (p, st) =>
      st.stars == null ? val('—', t('score.notRated')) : val(`★ ${st.stars.toFixed(1)}`, '', st.stars === topStars, t('score.best'))) +
    row(t('score.cost'), t('score.costSub'), (p, st) => {
      if (st.cost == null) return val('—', p.price ? t('score.noUsage', { out: usd(p.price.output) }) : t('score.noUsageNoPrice'));
      return val(usd(st.cost), st.outTokens != null ? t('score.tokens', { n: Math.round(st.outTokens).toLocaleString() }) : '', st.cost === cheapest, t('score.cheapest'));
    });
}

function stats(p) {
  const imgs = runs[p.id]?.images ?? [];
  const lat = imgs.map((i) => i.latencyMs).filter((x) => x != null);
  let pass = 0;
  let rated = 0;
  for (const img of imgs) {
    for (const c of img.checks) {
      if (!c.state) continue;
      rated++;
      if (c.state === 'pass') pass++;
    }
  }
  const judged = imgs.filter((i) => i.judge?.status === 'done').map((i) => i.judge.quality);
  const starred = imgs.filter((i) => i.stars > 0).map((i) => i.stars);
  const costs = imgs.map((i) => i.cost).filter((c) => c != null);
  const outs = imgs.map((i) => i.usage?.output).filter((c) => c != null);
  return {
    n: imgs.length,
    median: lat.length ? median(lat) : null,
    min: lat.length ? Math.min(...lat) : null,
    max: lat.length ? Math.max(...lat) : null,
    pass,
    rated,
    total: imgs.length * ran.checks.length,
    ratio: rated ? pass / rated : null,
    quality: judged.length ? avg(judged) : null,
    judging: imgs.some((i) => i.judge?.status === 'running'),
    stars: starred.length ? avg(starred) : null,
    cost: costs.length ? avg(costs) : null,
    outTokens: outs.length ? avg(outs) : null,
  };
}

// ── one card per model ──

function renderCard(el, p) {
  const r = runs[p.id];
  const img = r.images[r.selected];
  const [head, shotWrap, body] = el.children;
  const [w, h] = sizes[ran.size][ran.aspect];

  setHtml(head, `
    <span class="p-name"><span class="swatch" aria-hidden="true"></span>${esc(p.label)}</span>
    <span class="muted p-model">${esc(img?.model || p.model)} · ${esc(p.vendor)}</span>`);

  let shot;
  if (r.status === 'off') {
    shot = `<div class="shot empty-shot" style="aspect-ratio:${w}/${h}"><p class="muted">${t('cell.off', { vars: esc(p.problems.join(', ').replace(/ is empty/g, '')) })}</p></div>`;
  } else if (img) {
    shot = `
      <button type="button" class="shot" data-zoom="${p.id}:${r.selected}" style="aspect-ratio:${img.width || w}/${img.height || h}" aria-label="${esc(t('img.open', { model: p.label }))}">
        <img src="${esc(img.url)}" alt="${esc(t('img.alt', { model: p.label }))}">
      </button>`;
  } else if (r.status === 'running') {
    shot = `<div class="shot pending" style="aspect-ratio:${w}/${h}"><span class="elapsed" data-pid="${p.id}">0.0 s</span><span class="muted">${t('cell.generating')}</span></div>`;
  } else {
    shot = `<div class="shot empty-shot failed" style="aspect-ratio:${w}/${h}"><p class="err">${esc(r.error || t('cell.failed'))}</p></div>`;
  }
  const thumbs = r.images.length > 1 || (r.images.length && r.status === 'running')
    ? `<div class="thumbs">${r.images.map((x, i) => `
        <button type="button" class="thumb ${i === r.selected ? 'on' : ''}" data-thumb="${p.id}:${i}" aria-label="${t('img.pick', { n: i + 1 })}">
          <img src="${esc(x.url)}" alt=""><span>${sec(x.latencyMs)}</span>
        </button>`).join('')}${r.status === 'running' ? `<span class="thumb pending"><span class="elapsed" data-pid="${p.id}">0.0 s</span></span>` : ''}</div>`
    : '';
  setHtml(shotWrap, shot + thumbs);

  setHtml(body, img ? cardBody(p, r, img) : '');
}

function cardBody(p, r, img) {
  const idx = r.selected;
  const scale = Math.max(...providers.flatMap((x) => (runs[x.id]?.images ?? []).map((i) => i.latencyMs || 0)), 1);
  const tm = img.timing;
  const bar = tm ? `
    <span class="tbar" role="img" aria-label="${esc(timingText(tm))}">
      ${tm.connectMs ? `<span class="seg connect" style="width:${pctOf(tm.connectMs, scale)}"></span>` : ''}
      <span class="seg response" style="width:${pctOf(tm.responseMs, scale)}"></span>
    </span>` : '';
  const ext = (img.mime || 'image/png').split('/')[1].replace('jpeg', 'jpg');
  const meta = [
    img.width ? `${img.width}×${img.height}` : '',
    img.bytes ? (img.bytes >= 1e6 ? `${(img.bytes / 1e6).toFixed(1)} MB` : `${Math.round(img.bytes / 1e3)} KB`) : '',
    img.usage?.output != null ? t('card.tokens', { n: img.usage.output.toLocaleString() }) : '',
    img.cost != null ? usd(img.cost) : '',
    `<a href="${esc(img.url)}" download="${p.id}-${ran.aspect.replace(':', 'x')}-${idx + 1}.${ext}">${t('card.download')}</a>`,
  ].filter(Boolean).join(' · ');
  const mismatch = img.width && sizes[ran.size][ran.aspect][0] !== img.width;

  const checks = ran.checks.length ? `
    <ol class="checks">${ran.checks.map((text, ci) => {
      const c = img.checks[ci];
      const mark = c.state === 'pass' ? '✓' : c.state === 'fail' ? '✗' : '';
      const overrode = c.by === 'you' && c.judge && (c.state === 'pass') !== c.judge.pass && c.state != null;
      const reason = c.reason ? `<small>${overrode ? `${t('check.judgeSaid', { mark: c.judge.pass ? '✓' : '✗' })} ` : ''}${esc(c.reason)}</small>` : '';
      return `
        <li data-state="${c.state ?? 'none'}">
          <button type="button" class="tick" data-check="${p.id}:${idx}:${ci}" aria-label="${esc(t('check.toggle', { text }))}" title="${t('check.title')}">${mark}</button>
          <span class="c-text">${esc(text)}${reason}</span>
        </li>`;
    }).join('')}</ol>` : `<p class="muted small">${t('card.noChecklist')}</p>`;

  let judged = '';
  if (judge?.ready) {
    const j = img.judge;
    if (j?.status === 'done') judged = `<span class="q-score"><b>${j.quality}</b>/10</span><span class="q-notes">${esc(j.notes)}</span>`;
    else if (j?.status === 'running') judged = `<span class="muted">${t('score.judging')}</span>`;
    else judged = `${j?.status === 'error' ? `<span class="err">${esc(j.error)}</span>` : ''}<button type="button" class="link" data-judge="${p.id}:${idx}">${t('card.judge')}</button>`;
  }
  const stars = `
    <span class="stars" role="group" aria-label="${t('score.stars')}">${[1, 2, 3, 4, 5].map((n) => `
      <button type="button" class="${n <= img.stars ? 'on' : ''}" data-star="${p.id}:${idx}:${n}" aria-label="${t('card.starN', { n })}" aria-pressed="${n <= img.stars}">★</button>`).join('')}
    </span>`;

  return `
    <div class="timing">
      <b class="m-time">${sec(img.latencyMs)}</b>
      <span class="muted">${esc(timingText(tm))}</span>
    </div>
    ${bar}
    <p class="meta muted">${meta}</p>
    ${mismatch ? `<p class="muted small">${t('card.sizeMismatch')}</p>` : ''}
    ${r.status === 'error' ? `<p class="err small">${esc(r.error)}</p>` : ''}
    <h3 class="sub-title">${t('card.checklist')}</h3>
    ${checks}
    <h3 class="sub-title">${t('card.quality')}</h3>
    <div class="quality">${judged}</div>
    <div class="rating"><span class="muted">${t('card.yourRating')}</span>${stars}</div>
    ${img.revisedPrompt ? `<details class="revised"><summary>${t('card.revised')}</summary><p>${esc(img.revisedPrompt)}</p></details>` : ''}`;
}

function timingText(tm) {
  if (!tm) return '';
  return tm.reused ? t('timing.warm', { s: sec(tm.responseMs) }) : t('timing.cold', { connect: tm.connectMs, s: sec(tm.responseMs) });
}

function renderProtocol() {
  const open = new Set([...els.protocol.querySelectorAll('details[open]')].map((x) => x.dataset.id));
  const items = providers.filter((p) => runs[p.id]?.wire).map((p) => {
    const d = runs[p.id].wire;
    const status = d.status ? `HTTP ${d.status}` : d.ok ? '' : t('wire.noResponse');
    return `
      <details class="wire p-${p.id}" data-id="${p.id}" ${open.has(p.id) ? 'open' : ''}>
        <summary>
          <span class="p-name"><span class="swatch" aria-hidden="true"></span>${esc(p.label)}</span>
          <code>POST ${esc(d.endpoint || '')}</code>
          <span class="muted">${[status, d.latencyMs != null ? sec(d.latencyMs) : ''].filter(Boolean).join(' · ')}</span>
        </summary>
        <div class="wire-body">
          <div><h3>${t('wire.request')}</h3><pre>${esc(JSON.stringify(d.request ?? null, null, 2))}</pre></div>
          <div><h3>${t('wire.response')}</h3><pre>${esc(typeof d.response === 'string' ? d.response : JSON.stringify(d.response ?? d.error ?? null, null, 2))}</pre></div>
        </div>
      </details>`;
  });
  setHtml(els.protocol, items.join('') || `<p class="empty">${t('protocol.empty')}</p>`);
}

// ───────────────────────── helpers ─────────────────────────

function setHtml(el, markup) {
  if (lastHtml.get(el) === markup) return;
  lastHtml.set(el, markup);
  el.innerHTML = markup;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function avg(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sec(ms) {
  if (ms == null) return '—';
  return ms < 10_000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`;
}

function pct(p) {
  return `${Math.round(p * 100)}%`;
}

function pctOf(ms, scale) {
  return `${((ms / scale) * 100).toFixed(1)}%`;
}

function usd(v) {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  // Below $1 keep two significant digits but never fewer than two decimals: $0.10, $0.042.
  return `$${v.toFixed(Math.max(2, 1 - Math.floor(Math.log10(v || 1e-9))))}`;
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
