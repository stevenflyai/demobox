// Web IQ demo: send one query to every selected search service in parallel and compare search time, relevance
// (graded blind by a judge model), freshness, content returned, and cost; plus a speed test.

import { SCENARIOS } from './scenarios.js';
import { t, lang, setLang, applyStatic, LANGS } from './i18n.js';

const $ = (id) => document.getElementById(id);
const els = {
  lang: $('lang'),
  modelChip: $('modelChip'),
  preset: $('preset'),
  query: $('query'),
  market: $('market'),
  count: $('count'),
  chars: $('chars'),
  picks: $('picks'),
  judge: $('judge'),
  runBtn: $('runBtn'),
  speedBtn: $('speedBtn'),
  notice: $('notice'),
  board: $('board'),
  speedSection: $('speedSection'),
  speedLegend: $('speedLegend'),
  speed: $('speed'),
  lanes: $('lanes'),
  resultsEmpty: $('resultsEmpty'),
  protocol: $('protocol'),
  protocolSection: $('protocolSection'),
};

const DRAFT_KEY = 'webiq-demo.draft';
const SPEED_RUNS = 10;

let cfg = null;        // /api/config
let lanes = [];        // search services
let picks = null;      // Set of lane ids to run
let runs = {};         // laneId → { status, search, rel, error, since }
let ran = null;        // settings of the last run
let speed = null;      // { status, spec, byLane: { id → { status, latencies, roundTripMs, error } } }
let sort = { key: null, dir: 1 };
let running = false;
let ticker = null;
const expanded = new Set(); // "laneId:index" of source snippets opened by the viewer
const lastHtml = new WeakMap();

init();

async function init() {
  applyStatic();
  for (const [code, name] of Object.entries(LANGS)) els.lang.append(new Option(name, code));
  els.lang.value = lang;
  els.lang.addEventListener('change', () => switchLang(els.lang.value));
  const groups = new Map();
  for (const s of SCENARIOS) {
    if (!groups.has(s.group)) {
      const g = document.createElement('optgroup');
      g.dataset.group = s.group;
      g.label = t(`group.${s.group}`, null, s.group);
      groups.set(s.group, els.preset.appendChild(g));
    }
    groups.get(s.group).append(new Option(scenarioTitle(s), s.id));
  }

  try {
    cfg = await (await fetch('/api/config')).json();
  } catch {
    showNotice(t('notice.unreachable'));
    return;
  }
  if (cfg.hubUrl) $('home').href = cfg.hubUrl;
  for (const m of cfg.markets) els.market.append(new Option(t(`market.${m}`, null, m), m));
  lanes = cfg.providers;
  renderJudges();

  const draft = loadDraft();
  if (draft) {
    els.preset.value = SCENARIOS.some((s) => s.id === draft.preset) ? draft.preset : SCENARIOS[0].id;
    els.query.value = draft.query ?? '';
    setTopic(draft.topic);
    if (cfg.markets.includes(draft.market)) els.market.value = draft.market;
    if (draft.count) els.count.value = String(draft.count);
    if (draft.chars) els.chars.value = String(draft.chars);
    if (cfg.judges.some((j) => j.id === draft.judge && j.ready) || draft.judge === '') els.judge.value = draft.judge;
    // Stored as the lanes switched off, so a lane added since (e.g. another Parallel mode) starts switched on.
    if (Array.isArray(draft.unpicked)) picks = new Set(lanes.filter((l) => l.ready && !draft.unpicked.includes(l.id)).map((l) => l.id));
  } else {
    loadScenario(SCENARIOS[0]);
  }
  if (!picks) picks = new Set(lanes.filter((l) => l.ready).map((l) => l.id));

  els.preset.addEventListener('change', () => { loadScenario(SCENARIOS.find((s) => s.id === els.preset.value)); saveDraft(); });
  els.query.addEventListener('input', saveDraft);
  for (const el of [els.market, els.count, els.chars]) el.addEventListener('change', saveDraft);
  els.judge.addEventListener('change', () => { renderHeader(); saveDraft(); });
  for (const el of document.querySelectorAll('input[name="topic"]')) el.addEventListener('change', saveDraft);
  els.picks.addEventListener('change', (e) => {
    if (!e.target.matches('input[data-pick]')) return;
    if (e.target.checked) picks.add(e.target.dataset.pick); else picks.delete(e.target.dataset.pick);
    saveDraft();
  });
  els.runBtn.addEventListener('click', run);
  els.speedBtn.addEventListener('click', speedTest);
  els.board.addEventListener('click', (e) => {
    const th = e.target.closest('[data-sort]');
    if (!th) return;
    sort = sort.key === th.dataset.sort ? { key: sort.key, dir: -sort.dir } : { key: th.dataset.sort, dir: 1 };
    render();
  });
  els.lanes.addEventListener('click', (e) => {
    const snip = e.target.closest('[data-snip]');
    if (!snip) return;
    if (expanded.has(snip.dataset.snip)) expanded.delete(snip.dataset.snip); else expanded.add(snip.dataset.snip);
    render();
  });

  renderHeader();
  renderPicks();
  els.runBtn.disabled = false;
  els.speedBtn.disabled = false;
  if (!cfg.ready) showNotice(t('notice.noProvider'), 'info');
}

// ───────────────────────── language ─────────────────────────

function switchLang(next) {
  setLang(next);
  for (const o of els.preset.options) o.textContent = scenarioTitle(SCENARIOS.find((s) => s.id === o.value));
  for (const g of els.preset.querySelectorAll('optgroup')) g.label = t(`group.${g.dataset.group}`, null, g.dataset.group);
  for (const o of els.market.options) o.textContent = t(`market.${o.value}`, null, o.value);
  if (!running) els.runBtn.textContent = t('btn.run');
  renderHeader();
  renderPicks();
  renderJudges();
  render();
}

function scenarioTitle(s) {
  return t(`scenario.${s.id}`, null, s.title);
}

function laneSub(l) {
  return [l.vendor, l.mode].filter(Boolean).join(' · ');
}

// ───────────────────────── editor ─────────────────────────

function loadScenario(s) {
  els.query.value = s.query;
  setTopic(s.topic);
  if (cfg?.markets.includes(s.market)) els.market.value = s.market;
}

function setTopic(topic) {
  for (const el of document.querySelectorAll('input[name="topic"]')) el.checked = el.value === (topic === 'news' ? 'news' : 'web');
}

function readSpec() {
  return {
    query: els.query.value.trim(),
    topic: document.querySelector('input[name="topic"]:checked')?.value ?? 'web',
    market: els.market.value,
    count: Number(els.count.value),
    chars: Number(els.chars.value),
  };
}

// Off, the LLM judge, and the decision models; unconfigured ones are listed but disabled.
function renderJudges() {
  const keep = els.judge.value;
  els.judge.replaceChildren(new Option(t('judge.off'), ''), ...cfg.judges.map((j) => {
    const o = new Option(`${t(j.kind === 'llm' ? 'judge.llm' : 'judge.decision', { label: j.label, model: j.model ?? '' })}${j.ready ? '' : ` (${t('pick.notConfigured')})`}`, j.id);
    o.disabled = !j.ready;
    return o;
  }));
  const fallback = cfg.judges.find((j) => j.id === cfg.defaultJudge && j.ready) ?? cfg.judges.find((j) => j.ready);
  els.judge.value = keep && cfg.judges.some((j) => j.id === keep && j.ready) ? keep : fallback?.id ?? '';
}

function judgeById(id) {
  return cfg.judges.find((j) => j.id === id) ?? null;
}

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      preset: els.preset.value, ...readSpec(), query: els.query.value,
      judge: els.judge.value, unpicked: picks ? lanes.filter((l) => !picks.has(l.id)).map((l) => l.id) : undefined,
    }));
  } catch { /* storage unavailable */ }
}

// ───────────────────────── run ─────────────────────────

async function run() {
  if (running) return;
  hideNotice();
  const spec = readSpec();
  if (!spec.query) return showNotice(t('notice.noQuery'));
  const chosen = lanes.filter((l) => l.ready && picks.has(l.id));
  if (!chosen.length) return showNotice(t('notice.noLanes'));

  ran = { ...spec, judge: els.judge.value || null, relInfo: null };
  runs = Object.fromEntries(lanes.map((l) => [l.id, {
    status: !l.ready ? 'off' : chosen.includes(l) ? 'pending' : 'skipped',
    search: null, rel: null, error: null, since: null,
  }]));
  expanded.clear();
  running = true;
  els.runBtn.disabled = true;
  els.speedBtn.disabled = true;
  els.runBtn.textContent = t('btn.running');
  ticker = setInterval(tick, 100);
  render();

  // Relevance is graded once every search is back, all services in one call.
  await Promise.all(chosen.map(runLane));
  if (ran.judge) await gradeRelevance(chosen);

  running = false;
  clearInterval(ticker);
  els.runBtn.disabled = false;
  els.speedBtn.disabled = false;
  els.runBtn.textContent = t('btn.run');
  render();
}

async function runLane(l) {
  const r = runs[l.id];
  step(r, 'searching');
  const data = await post('/api/search', { provider: l.id, ...ran });
  r.search = data;
  if (!data.ok) return fail(r, data.error);
  r.status = 'done';
  r.since = null;
  render();
}

function step(r, status) {
  r.status = status;
  r.since = performance.now();
  render();
}

function fail(r, error) {
  r.status = 'error';
  r.error = error;
  r.since = null;
  render();
}

// Grades every result 0-3 without the service names; see /api/relevance.
async function gradeRelevance(chosen) {
  const graded = chosen.filter((l) => runs[l.id].search?.ok);
  if (!graded.length) return;
  const data = await post('/api/relevance', {
    judge: ran.judge,
    question: ran.query,
    lanes: graded.map((l) => ({ id: l.id, sources: runs[l.id].search.results.map((s) => ({ title: s.title, url: s.url, date: s.date, dateKind: s.dateKind, dateMonth: s.dateMonth, content: s.content })) })),
  });
  for (const l of graded) runs[l.id].rel = data.ok ? { ok: true, items: data.lanes[l.id] ?? [] } : { ok: false, error: data.error };
  if (data.ok) ran.relInfo = { judge: judgeById(data.judge), latencyMs: data.latencyMs, documents: data.documents };
  render();
}

function laneSources(r) {
  return r.search?.ok ? r.search.results : [];
}

async function post(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  } catch (err) {
    return { ok: false, error: t('notice.serverError', { msg: err.message }) };
  }
}

// Live seconds counter on every lane still working.
function tick() {
  const now = performance.now();
  for (const el of document.querySelectorAll('.elapsed[data-lane]')) {
    const since = runs[el.dataset.lane]?.since;
    if (since != null) el.textContent = `${((now - since) / 1000).toFixed(1)} s`;
  }
}

// ───────────────────────── speed test ─────────────────────────

// One warm-up call (not counted) plus SPEED_RUNS sequential calls per service, services in parallel.
async function speedTest() {
  if (running) return;
  hideNotice();
  const spec = readSpec();
  if (!spec.query) return showNotice(t('notice.noQuery'));
  const chosen = lanes.filter((l) => l.ready && picks.has(l.id));
  if (!chosen.length) return showNotice(t('notice.noLanes'));

  speed = { status: 'running', spec, byLane: Object.fromEntries(chosen.map((l) => [l.id, { status: 'running', latencies: [] }])) };
  running = true;
  els.runBtn.disabled = true;
  els.speedBtn.disabled = true;
  els.speedBtn.textContent = t('btn.speedRunning');
  render();

  await Promise.all(chosen.map(async (l) => {
    const data = await post('/api/speedtest', { provider: l.id, ...spec, runs: SPEED_RUNS });
    speed.byLane[l.id] = data.ok
      ? { status: 'done', latencies: data.latencies, roundTripMs: data.roundTripMs, cost: data.cost }
      : { status: 'error', latencies: data.latencies ?? [], error: data.error };
    render();
  }));

  speed.status = 'done';
  running = false;
  els.runBtn.disabled = false;
  els.speedBtn.disabled = false;
  els.speedBtn.textContent = t('btn.speed');
  render();
  els.speedSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ───────────────────────── render ─────────────────────────

function renderHeader() {
  if (!cfg) return;
  const j = judgeById(els.judge.value);
  setHtml(els.modelChip, j ? t('header.model', { model: esc(j.label === j.model ? j.model : `${j.label} · ${j.model}`), host: esc(j.host ?? '') }) : esc(t('header.noModel')));
}

function renderPicks() {
  setHtml(els.picks, lanes.map((l) => {
    const hint = l.ready ? '' : t('pick.getKey', { prefix: l.envPrefix });
    return `
      <label class="pick lane-${l.id}" ${hint ? `title="${esc(hint)}"` : ''}>
        <input type="checkbox" data-pick="${l.id}" ${l.ready && picks.has(l.id) ? 'checked' : ''} ${l.ready ? '' : 'disabled'}>
        <span class="swatch" aria-hidden="true"></span>
        <span class="pick-text">${esc(l.label)}${l.ready ? '' : ` <small class="muted">${l.signup ? `<a href="${esc(l.signup)}" target="_blank" rel="noopener">${t('pick.noKey')}</a>` : t('pick.notConfigured')}</small>`}</span>
      </label>`;
  }).join(''));
}

function render() {
  const has = ran != null;
  els.resultsEmpty.hidden = has || speed != null;
  els.board.hidden = !has;
  els.lanes.hidden = !has;
  els.protocolSection.hidden = !has;
  els.speedSection.hidden = !speed;
  if (speed) renderSpeed();
  if (!has) return;

  const shown = lanes.filter((l) => runs[l.id] && runs[l.id].status !== 'skipped');
  setHtml(els.board, board(shown));
  setHtml(els.lanes, shown.map(laneCard).join(''));
  renderProtocol(shown);
  tick();
}

// ── leaderboard: one row per lane, best value per column highlighted ──

function columns() {
  return [
    { key: 'search', label: t('col.search'), sub: t('col.searchSub'), best: 'min', val: (l, r) => (r.search?.ok ? r.search.latencyMs : null), fmt: (v) => ms(v) },
    { key: 'relevant', label: t('col.relevant'), sub: t('col.relevantSub'), best: 'max', val: (l, r) => relevanceScore(r), fmt: (v, l, r) => `${v.toFixed(1)}<small>/10 · ${t('rel.answers', { n: answering(r) })}${shortfall(r)}</small>` },
    {
      key: 'fresh', label: t('col.fresh'), sub: t('col.freshSub'), best: 'max',
      val: (l, r) => { const f = freshness(r); return f?.ranked ? f.time : null; },
      fmt: (v, l, r) => freshText(freshness(r)),
      unranked: (l, r) => { const f = freshness(r); return f ? freshText(f) : null; },
    },
    // Characters of page content the service returned: exact, unlike a token estimate. More isn't better or worse by itself.
    { key: 'content', label: t('col.content'), sub: t('col.contentSub'), best: null, val: (l, r) => (r.search?.ok ? r.search.contextChars : null), fmt: (v) => v.toLocaleString() },
    { key: 'cost', label: t('col.cost'), sub: t('col.costSub'), best: 'min', val: (l, r) => (r.search?.ok && r.search.cost != null ? r.search.cost * 1000 : null), fmt: (v) => usd(v) },
  ];
}

function board(shown) {
  const cols = columns();
  const vals = Object.fromEntries(shown.map((l) => [l.id, Object.fromEntries(cols.map((c) => [c.key, c.val(l, runs[l.id])]))]));
  const bests = Object.fromEntries(cols.map((c) => {
    if (!c.best) return [c.key, null];
    const vs = shown.map((l) => vals[l.id][c.key]).filter((v) => v != null);
    if (vs.length < 2 || vs.every((v) => v === vs[0])) return [c.key, null];
    return [c.key, c.best === 'min' ? Math.min(...vs) : Math.max(...vs)];
  }));

  let rows = [...shown];
  if (sort.key) {
    const c = cols.find((x) => x.key === sort.key);
    const dir = (c?.best === 'min' ? 1 : -1) * sort.dir;
    rows.sort((a, b) => {
      const va = vals[a.id][sort.key];
      const vb = vals[b.id][sort.key];
      if (va == null) return vb == null ? 0 : 1;
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
  }

  const head = `<div class="b-row b-head" role="row">
    <div class="b-cell b-lane" role="columnheader">${t('col.lane')}</div>
    ${cols.map((c) => `<button type="button" class="b-cell b-th ${sort.key === c.key ? 'sorted' : ''}" data-sort="${c.key}" role="columnheader">${c.label}<small>${c.sub}</small>${sort.key === c.key ? `<i aria-hidden="true">${sort.dir === 1 ? '↑' : '↓'}</i>` : ''}</button>`).join('')}
  </div>`;
  const body = rows.map((l) => {
    const r = runs[l.id];
    const cells = cols.map((c) => {
      const v = vals[l.id][c.key];
      let inner;
      const unranked = v == null && c.unranked ? c.unranked(l, r) : null;
      if (v != null) inner = `<span class="v ${bests[c.key] === v ? 'best' : ''}">${c.fmt(v, l, r)}</span>`;
      else if (unranked) inner = `<span class="v">${unranked}</span>`;
      else if (r.status === 'off') inner = '';
      else if (r.status === 'error') inner = '<span class="muted">—</span>';
      else if (isPending(l, r, c.key)) inner = '<span class="skeleton small"></span>';
      else inner = '<span class="muted">—</span>';
      return `<div class="b-cell" role="cell" data-label="${esc(c.label)}">${inner}</div>`;
    }).join('');
    const status = r.status === 'error' ? `<small class="err">${t('status.failed')}</small>` : r.status === 'off' ? `<small class="muted">${t('pick.notConfigured')}</small>` : '';
    return `<div class="b-row lane-${l.id}" role="row">
      <div class="b-cell b-lane" role="rowheader"><span class="swatch" aria-hidden="true"></span><span><b>${esc(l.label)}</b>${status}</span></div>
      ${cells}
    </div>`;
  }).join('');
  const info = ran.relInfo;
  const foot = info ? `<p class="b-foot muted">${t('rel.gradedBy', { judge: esc(info.judge ? (info.judge.label === info.judge.model ? info.judge.label : `${info.judge.label} (${info.judge.model})`) : ''), n: info.documents, s: sec(info.latencyMs) })}</p>` : '';
  return `<div class="b-table" role="table">${head}${body}</div>${foot}`;
}

function isPending(l, r, key) {
  if (key === 'relevant') return ran.judge && !!r.search?.ok && !r.rel;
  if (key === 'fresh') return !r.search || awaitingRelevance(r);
  return !['done', 'error', 'off'].includes(r.status) && !r.search;
}

// Mean gain over the number of results asked for, so missing results and duplicates count as 0. Scaled to 0-10.
// Gain per grade 0-3 is 0, 0, 1, 3: an on-topic result that doesn't help answer only fills the model's context.
function relevanceScore(r) {
  if (!r.rel?.ok) return null;
  const gain = [0, 0, 1, 3];
  const sum = r.rel.items.reduce((n, x) => n + (gain[x.grade] ?? 0), 0);
  return (sum / (3 * ran.count)) * 10;
}

function answering(r) {
  return r.rel?.ok ? r.rel.items.filter((x) => x.grade === 3).length : 0;
}

// "n/k returned" when a service sent fewer results than asked for, since the missing ones lower its score.
function shortfall(r) {
  const n = r.search?.ok ? r.search.results.length : 0;
  return n < ran.count ? ` · ${t('rel.returned', { n, k: ran.count })}` : '';
}

function awaitingRelevance(r) {
  return ran.judge && !!r.search?.ok && !r.rel;
}

// Newest date among the results the judge found useful (grade 2 or 3): a new page that doesn't help answer isn't
// fresh information. Without grades, among all results. Ranked only when it is a publish or update date (crawl
// times say when the service fetched a page) and at least half the useful results are dated, so a service that
// dates one result in five can't win on it.
function freshness(r) {
  if (awaitingRelevance(r)) return null;
  const sources = laneSources(r);
  if (!sources.length) return null;
  const graded = r.rel?.ok;
  const pool = graded ? sources.filter((_, i) => (r.rel.items[i]?.grade ?? 0) >= 2) : sources;
  if (graded && !pool.length) return { none: 'useful' };
  const dated = pool.map((s) => ({ time: Date.parse(s.date ?? ''), kind: s.dateKind, month: s.dateMonth })).filter((x) => Number.isFinite(x.time));
  const future = dated.filter((x) => isFuture(x.time)).length;
  const valid = dated.filter((x) => !isFuture(x.time));
  if (!valid.length) return { none: 'dates', of: pool.length, graded, future };
  const real = valid.filter((x) => x.kind !== 'crawled');
  const crawls = valid.filter((x) => x.kind === 'crawled').map((x) => x.time);
  const top = (real.length ? real : valid).reduce((a, b) => (b.time > a.time ? b : a));
  // A newer crawl than the newest publish date is worth showing: the page may be new, but the service didn't say when it was written.
  const newerCrawl = real.length && crawls.length && Math.max(...crawls) > top.time ? Math.max(...crawls) : null;
  return { ...top, real: real.length, of: pool.length, graded, future, newerCrawl, ranked: real.length > 0 && real.length * 2 >= pool.length };
}

// Further ahead than a time-zone slip: bad metadata, so ignored.
function isFuture(ts) {
  return ts > Date.now() + 24 * 3_600_000;
}

function freshText(f) {
  if (!f) return '—';
  if (f.none === 'useful') return `<span class="muted">${t('fresh.noUseful')}</span>`;
  const futureNote = f.future ? `<small class="err"> · ${t('fresh.future', { n: f.future })}</small>` : '';
  if (f.none === 'dates') return `<span class="muted">${t('fresh.noDates')}</span>${futureNote}`;
  const kind = dateKindLabel(f.kind) ? ` <small>${dateKindLabel(f.kind)}</small>` : '';
  const why = f.ranked ? t('fresh.whyRanked', { n: f.real, k: f.of }) : f.real ? t('fresh.whyFew', { n: f.real, k: f.of }) : t('fresh.whyCrawled');
  const tag = `<span class="tag ${f.ranked ? 'ranked' : 'unranked'}" title="${esc(why)}">${t(f.ranked ? 'fresh.ranked' : 'fresh.unranked')}</span>`;
  const crawlNote = f.newerCrawl ? `<small> · ${t('fresh.newerCrawl', { age: relAge(f.newerCrawl) })}</small>` : '';
  const age = `${dateText(f.time, f.month)}${kind}<small> · ${t(f.graded ? 'fresh.datedUseful' : 'fresh.dated', { n: f.real, k: f.of })}</small>${crawlNote}`;
  return `${f.ranked ? age : `<span class="unranked-v">${age}</span>`}${futureNote} ${tag}`;
}

// ── one card per lane ──

function laneCard(l) {
  const r = runs[l.id];
  const head = `
    <header class="card-head">
      <span class="p-name"><span class="swatch" aria-hidden="true"></span>${esc(l.label)}</span>
      <span class="muted p-sub">${esc(laneSub(l))}</span>
    </header>`;
  if (r.status === 'off') {
    return `<article class="card lane-${l.id} off">${head}<p class="muted small">${t('card.off', { prefix: esc(l.envPrefix) })}${l.signup ? ` · <a href="${esc(l.signup)}" target="_blank" rel="noopener">${t('pick.noKey')}</a>` : ''}</p></article>`;
  }

  const progress = r.status === 'searching' ? `<p class="progress"><span class="elapsed" data-lane="${l.id}">0.0 s</span> <span class="muted">${t('status.searching')}</span></p>` : '';
  const error = r.status === 'error' ? `<p class="err small">${esc(r.error)}</p>` : '';

  const rel = r.rel;
  const relevance = rel?.ok ? `
    <div class="grades">
      <span class="grade">${t('col.relevant')} <b>${relevanceScore(r).toFixed(1)}</b>/10</span>
      <span class="muted small">${t('card.relevance', { n: answering(r), k: ran.count })}</span>
    </div>` : rel && !rel.ok ? `<p class="err small">${t('card.relevanceFailed')}: ${esc(rel.error)}</p>`
    : awaitingRelevance(r) ? `<p class="progress muted">${t('status.judging')}</p>` : '';

  const s = r.search;
  const searchMeta = s?.ok ? `<p class="meta muted">${[
    t('card.searchTime', { ms: ms(s.latencyMs) }),
    t('card.results', { n: s.results.length }),
    t('card.context', { chars: s.contextChars.toLocaleString() }),
    s.freshIntent != null ? `<span class="${s.freshIntent ? '' : 'warn'}" title="${esc(t('card.freshIntentTitle'))}">${t(s.freshIntent ? 'card.freshIntentYes' : 'card.freshIntentNo')}</span>` : '',
    s.cost != null ? t('card.cost', { cost: usd(s.cost * 1000) }) : '',
  ].filter(Boolean).join(' · ')}</p>` : '';

  const sources = laneSources(r);
  const list = sources.length ? `
    <h3 class="sub-title">${t('card.sources', { n: sources.length })}</h3>
    <ol class="sources">${sources.map((x, i) => {
      const key = `${l.id}:${i}`;
      const g = rel?.ok ? rel.items[i] : null;
      const mark = !g ? '' : g.dup ? `<span class="rel dup" title="${t('rel.dupTitle')}">${t('rel.dup')}</span>` : g.grade == null ? '' : `<span class="rel g${g.grade}" title="${t(`rel.g${g.grade}`)}">${g.grade}</span>`;
      const ts = Date.parse(x.date ?? '');
      const date = Number.isFinite(ts) ? `${dateText(ts, x.dateMonth)}${isFuture(ts) ? ` ${t('date.future')}` : dateKindLabel(x.dateKind) ? ` ${dateKindLabel(x.dateKind)}` : ''}` : '';
      return `
        <li id="src-${l.id}-${i + 1}">
          <span class="n">${i + 1}</span>
          <div class="src">
            <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>
            <span class="src-meta">${mark}${esc(x.domain)}${date ? ` · ${esc(date)}` : ''}${x.content ? ` · ${x.content.length.toLocaleString()} ${t('card.chars')}` : ''}${x.trimmedFrom ? ` <span class="tag unranked" title="${esc(t('card.trimmedTitle'))}">${t('card.trimmed', { n: x.trimmedFrom.toLocaleString() })}</span>` : ''}</span>
            ${x.content ? `<button type="button" class="snip ${expanded.has(key) ? 'open' : ''}" data-snip="${key}" title="${t('card.expand')}">${esc(x.content)}</button>` : ''}
          </div>
        </li>`;
    }).join('')}</ol>` : (s?.ok ? `<p class="muted small">${t('card.noResults')}</p>` : '');

  const pending = r.status === 'searching' && !s ? '<span class="skeleton block"></span>' : '';
  return `<article class="card lane-${l.id}">${head}${progress}${error}${searchMeta}${relevance}${pending}${list}</article>`;
}

// ── speed chart: one row per service, sorted fastest first ──

function renderSpeed() {
  const rows = Object.entries(speed.byLane).map(([id, s]) => ({ l: lanes.find((x) => x.id === id), s, st: s.latencies.length ? pstats(s.latencies) : null }));
  rows.sort((a, b) => (a.st?.p50 ?? Infinity) - (b.st?.p50 ?? Infinity));
  const scale = Math.max(1, ...rows.map((x) => x.st?.max ?? 0));
  const fastest = rows.find((x) => x.st)?.st.p50;
  const pos = (v) => `${((v / scale) * 100).toFixed(1)}%`;

  els.speedLegend.innerHTML = t('speed.legend', { n: SPEED_RUNS, query: esc(speed.spec.query.slice(0, 60)) });
  setHtml(els.speed, rows.map(({ l, s, st }) => {
    let body;
    if (st) {
      body = `
        <span class="sp-track" role="img" aria-label="${esc(t('speed.aria', { p50: st.p50, p95: st.p95 }))}">
          <span class="sp-range" style="left:${pos(st.min)};width:${pos(st.max - st.min)}"></span>
          <span class="sp-p50" style="width:${pos(st.p50)}"></span>
          <span class="sp-p95" style="left:${pos(st.p95)}"></span>
        </span>
        <span class="sp-nums"><b>${st.p50} ms</b> p50 · ${st.p95} ms p95${s.roundTripMs != null ? ` · <span class="muted">${t('speed.rtt', { ms: s.roundTripMs })}</span>` : ''}${fastest && st.p50 !== fastest ? ` · <span class="muted">${t('speed.slower', { x: (st.p50 / fastest).toFixed(1) })}</span>` : ''}</span>`;
    } else if (s.status === 'running') {
      body = '<span class="sp-track"><span class="skeleton small"></span></span><span class="sp-nums muted">…</span>';
    } else {
      body = `<span class="sp-nums err">${esc(s.error ?? t('status.failed'))}</span>`;
    }
    return `<div class="sp-row lane-${l.id}"><span class="sp-name"><span class="swatch" aria-hidden="true"></span>${esc(l.label)}</span>${body}</div>`;
  }).join('') + `<p class="sp-key muted">${t('speed.key')}</p>`);
}

function renderProtocol(shown) {
  const open = new Set([...els.protocol.querySelectorAll('details[open]')].map((x) => x.dataset.id));
  const item = (l, kind, d) => {
    if (!d?.endpoint) return '';
    const id = `${l.id}-${kind}`;
    return `
      <details class="wire lane-${l.id}" data-id="${id}" ${open.has(id) ? 'open' : ''}>
        <summary>
          <span class="p-name"><span class="swatch" aria-hidden="true"></span>${esc(l.label)} · ${t(`wire.${kind}`)}</span>
          <code>${esc(d.endpoint)}</code>
          <span class="muted">${[d.status ? `HTTP ${d.status}` : '', d.latencyMs != null ? ms(d.latencyMs) : ''].filter(Boolean).join(' · ')}</span>
        </summary>
        <div class="wire-body">
          <div><h3>${t('wire.request')}</h3><pre>${esc(JSON.stringify(d.request ?? null, null, 2))}</pre></div>
          <div><h3>${t('wire.response')}</h3><pre>${esc(typeof d.response === 'string' ? d.response : JSON.stringify(d.response ?? d.error ?? null, null, 2))}</pre></div>
        </div>
      </details>`;
  };
  const items = shown.map((l) => item(l, 'search', runs[l.id].search)).join('');
  setHtml(els.protocol, items || `<p class="empty">${t('protocol.empty')}</p>`);
}

// ───────────────────────── helpers ─────────────────────────

function setHtml(el, markup) {
  if (lastHtml.get(el) === markup) return;
  lastHtml.set(el, markup);
  el.innerHTML = markup;
}

function pstats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { p50: q(0.5), p95: q(0.95), min: s[0], max: s[s.length - 1] };
}

function ms(v) {
  return v < 1000 ? `${v} ms` : sec(v);
}

function sec(v) {
  return v == null ? '—' : `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`;
}

function usd(v) {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(Math.max(2, 1 - Math.floor(Math.log10(v || 1e-9))))}`;
}

// A date read from the URL may give only the month (an arXiv ID); show it as the month, not as an exact age.
function dateText(ts, month) {
  return month ? new Date(ts).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' }) : relAge(ts);
}

function dateKindLabel(kind) {
  return { crawled: t('date.crawled'), updated: t('date.updated'), url: t('date.url') }[kind] ?? '';
}

function relAge(ts) {
  const d = Date.now() - ts;
  if (d < 0) return new Date(ts).toISOString().slice(0, 10);
  const h = d / 3_600_000;
  if (h < 1) return t('age.min', { n: Math.max(1, Math.round(d / 60_000)) });
  if (h < 48) return t('age.h', { n: Math.round(h) });
  if (h < 24 * 60) return t('age.d', { n: Math.round(h / 24) });
  return new Date(ts).toISOString().slice(0, 10);
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
