// Web IQ demo server
// - Serves the browser app from ./public
// - GET  /api/config    : which search services and the relevance judge are configured (never returns keys)
// - POST /api/search    : runs one search service on { provider, query, topic, count, chars, market } and returns
//                         normalized results, measured latency, content size, cost, and the raw request/response
// - POST /api/relevance : grades every service's results 0-3 from one pooled, shuffled input, without service names,
//                         with the LLM judge or a decision model; repeats within a service score 0 as duplicates
// - POST /api/speedtest : one warm-up plus N sequential searches on one service; returns every latency
// Keys are read from .env and never leave this process. No npm dependencies.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

loadEnvFile(path.join(ROOT, '.env'));

// ───────────────────────── config ─────────────────────────

const env = (key, fallback = '') => (process.env[key] ?? '').trim() || fallback;

// Parallel prices by mode: turbo and fast $1, basic and advanced $5. PARALLEL_MODE can list several modes, one lane
// each; the default runs the two $5 modes, the tier that compares with Web IQ's.
const PARALLEL_MODES = [...new Set(env('PARALLEL_MODE', 'basic,advanced').toLowerCase().split(',').map((m) => m.trim()).filter(Boolean))];

// Every service is asked for the same number of results with the same per-result content budget where it
// supports one, so latency, content size, and relevance compare like for like. Prices are list prices in USD
// per 1,000 searches as of October 2026; set *_PRICE_PER_1K to match your contract.
const PROVIDERS = [
  { id: 'webiq', label: 'Microsoft Web IQ', vendor: 'Microsoft', envPrefix: 'WEBIQ', defaultBaseUrl: 'https://api.microsoft.ai/v3', defaultPrice: 7, signup: 'https://www.microsoft.com/en-us/webiq' },
  { id: 'tavily', label: 'Tavily', vendor: 'Tavily', envPrefix: 'TAVILY', defaultBaseUrl: 'https://api.tavily.com', defaultPrice: 8, signup: 'https://app.tavily.com' },
  { id: 'exa', label: 'Exa', vendor: 'Exa', envPrefix: 'EXA', defaultBaseUrl: 'https://api.exa.ai', defaultPrice: 7, signup: 'https://dashboard.exa.ai' },
  { id: 'brave', label: 'Brave Search', vendor: 'Brave', envPrefix: 'BRAVE', defaultBaseUrl: 'https://api.search.brave.com', defaultPrice: 5, signup: 'https://api-dashboard.search.brave.com' },
  { id: 'perplexity', label: 'Perplexity Search', vendor: 'Perplexity', envPrefix: 'PERPLEXITY', defaultBaseUrl: 'https://api.perplexity.ai', defaultPrice: 5, signup: 'https://www.perplexity.ai/account/api' },
  ...PARALLEL_MODES.map((mode) => ({
    id: PARALLEL_MODES.length > 1 ? `parallel-${mode}` : 'parallel', service: 'parallel', mode,
    label: PARALLEL_MODES.length > 1 ? `Parallel ${mode[0].toUpperCase()}${mode.slice(1)}` : 'Parallel', vendor: 'Parallel Web Systems', envPrefix: 'PARALLEL',
    defaultBaseUrl: 'https://api.parallel.ai', defaultPrice: mode === 'basic' || mode === 'advanced' ? 5 : 1, signup: 'https://platform.parallel.ai',
  })),
  { id: 'serpapi', label: 'Google via SerpApi', vendor: 'SerpApi', envPrefix: 'SERPAPI', defaultBaseUrl: 'https://serpapi.com', defaultPrice: 15, signup: 'https://serpapi.com/manage-api-key' },
].map((p) => ({
  service: p.id,
  ...p,
  baseUrl: env(`${p.envPrefix}_BASE_URL`, p.defaultBaseUrl).replace(/\/+$/, ''),
  apiKey: env(`${p.envPrefix}_API_KEY`),
  pricePer1k: readNumber(`${p.envPrefix}_PRICE_PER_1K`, p.defaultPrice),
}));

const OPTIONS = {
  webiqFormat: env('WEBIQ_CONTENT_FORMAT', 'passage'),
  // Sent only when set; Web IQ's own default is strict. The news endpoint has no safeSearch parameter.
  webiqSafeSearch: /^(off|strict)$/i.test(env('WEBIQ_SAFE_SEARCH')) ? env('WEBIQ_SAFE_SEARCH').toLowerCase() : '',
  tavilyDepth: env('TAVILY_SEARCH_DEPTH', 'basic'),
  exaType: env('EXA_SEARCH_TYPE', 'auto'),
  serpapiNoCache: !/^(0|false|no|off)$/i.test(env('SERPAPI_NO_CACHE', 'true')),
};

// The relevance judge uses the Responses API on an Azure OpenAI / Foundry resource.
const MODEL = {
  envPrefix: 'MODEL',
  rawBaseUrl: env('MODEL_BASE_URL'),
  apiKey: env('MODEL_API_KEY'),
  authHeader: env('MODEL_AUTH_HEADER', 'auto').toLowerCase(),
};
MODEL.endpoint = resolveResponsesEndpoint(MODEL.rawBaseUrl);
const JUDGE_MODEL = env('JUDGE_MODEL');
const JUDGE_EFFORT = env('JUDGE_REASONING_EFFORT');

// Decision models can grade relevance instead of the LLM judge, with the same settings as decision/.env.
// They answer typed questions with probabilities: here, one 0-3 score question per result.
//   systemone : { model, state, questions: { name: { type: score, instructions, criteria: [level, …] } } }
//               Microsoft-Decision-1 (Foundry) and TypeSafe Jev
//   decisions : { model, input, questions: [ { type: score, name, instructions, levels: [{ label, description }] } ] }
//               OpenAI / Azure OpenAI Decisions API
const DECISION_JUDGES = [
  { id: 'microsoft', label: 'Microsoft-Decision-1', protocol: 'systemone', envPrefix: 'MS_DECISION', defaultModel: 'Microsoft-Decision-1', defaultBaseUrl: '' },
  { id: 'openai', label: 'GPT Decisions API', protocol: 'decisions', envPrefix: 'GPT_DECISION', defaultModel: 'gpt-6-luna', defaultBaseUrl: '' },
  { id: 'jev', label: 'Jev', protocol: 'systemone', envPrefix: 'JEV', defaultModel: 'jev-latest', defaultBaseUrl: 'https://api.typesafe.ai' },
].map((d) => {
  const rawBaseUrl = env(`${d.envPrefix}_BASE_URL`, d.defaultBaseUrl);
  return {
    ...d,
    rawBaseUrl,
    endpoint: resolveDecisionEndpoint(d.protocol, rawBaseUrl),
    apiKey: env(`${d.envPrefix}_API_KEY`),
    model: env(`${d.envPrefix}_MODEL`, d.defaultModel),
    authHeader: env(`${d.envPrefix}_AUTH_HEADER`, 'auto').toLowerCase(),
  };
});
// llm, or a decision judge id; the page can switch per run.
const DEFAULT_JUDGE = env('RELEVANCE_JUDGE', 'llm').toLowerCase();
const DECISION_BATCH = 20; // score questions per decision request; batches run in parallel

const PORT = Number(env('PORT', '3003')) || 3003;
const TIMEOUT_MS = (Number(env('REQUEST_TIMEOUT_SECONDS', '90')) || 90) * 1000;
const DEBUG = /^(1|true|yes|on)$/i.test(env('DEBUG'));
const HUB_URL = process.env.DEMOBOX_HUB_URL || 'http://localhost:8000';

const AGENTS = {
  'https:': new https.Agent({ keepAlive: true, timeout: 60_000 }),
  'http:': new http.Agent({ keepAlive: true, timeout: 60_000 }),
};
const roundTrips = new Map(); // host → last TCP handshake in ms, i.e. about one network round trip

const TOPICS = new Set(['web', 'news']);
const COUNTS = new Set([3, 5, 10]);
const CHARS = new Set([500, 1000, 2000, 4000]);
const MAX_CHARS = Math.max(...CHARS); // the judge sees all of every result, up to the largest budget
// News mode searches the past week wherever the API has a time window (Tavily, Exa, Brave, Perplexity, SerpApi); Web IQ and Parallel have none.
const NEWS_WINDOW_MS = 7 * 864e5;
// Market → language and country, plus the spellings each service wants.
const MARKETS = {
  'en-US': { language: 'en', country: 'US', tavily: 'united states', brave: 'en', google: 'en' },
  'en-GB': { language: 'en', country: 'GB', tavily: 'united kingdom', brave: 'en', google: 'en' },
  'zh-CN': { language: 'zh', country: 'CN', tavily: 'china', brave: 'zh-hans', google: 'zh-cn' },
  'ja-JP': { language: 'ja', country: 'JP', tavily: 'japan', brave: 'jp', google: 'ja' },
  'de-DE': { language: 'de', country: 'DE', tavily: 'germany', brave: 'de', google: 'de' },
};
const MAX_QUERY_CHARS = 1000;
const MAX_SPEED_RUNS = 20;


function providerProblems(p) {
  const problems = [];
  if (!p.apiKey || /^<|your|xxx/i.test(p.apiKey)) problems.push(`${p.envPrefix}_API_KEY is empty`);
  try { new URL(p.baseUrl); } catch { problems.push(`${p.envPrefix}_BASE_URL is not a valid URL`); }
  return problems;
}

function modelProblems(modelVar, model) {
  const problems = [];
  if (!MODEL.rawBaseUrl) problems.push('MODEL_BASE_URL is empty');
  else if (!MODEL.endpoint) problems.push(`MODEL_BASE_URL is not a valid URL (${MODEL.rawBaseUrl})`);
  if (!MODEL.apiKey || /^<|your|xxx/i.test(MODEL.apiKey)) problems.push('MODEL_API_KEY is empty');
  if (!model) problems.push(`${modelVar} is empty`);
  return problems;
}

function isAzureHost(host) {
  return /\.(azure\.com|azure-api\.net|azure\.cn)$/i.test(host);
}

function modelAuthHeaders() {
  let mode = MODEL.authHeader;
  if (mode !== 'api-key' && mode !== 'bearer') mode = isAzureHost(safeHost(MODEL.endpoint)) ? 'api-key' : 'bearer';
  return mode === 'api-key' ? { 'api-key': MODEL.apiKey } : { Authorization: `Bearer ${MODEL.apiKey}` };
}

// Accept whatever the portal shows (resource endpoint, project URL, or a full path) and return the Responses URL.
function resolveResponsesEndpoint(raw) {
  if (!raw) return '';
  let u;
  try { u = new URL(raw.trim()); } catch { return ''; }
  let pathname = u.pathname.replace(/\/+$/, '');
  if (!/\/responses$/i.test(pathname)) {
    if (isAzureHost(u.hostname)) pathname = '/openai/v1/responses'; // also drops /images/generations or /api/projects/...
    else pathname = /\/v1$/i.test(pathname) ? `${pathname}/responses` : `${pathname}/v1/responses`;
  }
  return `${u.protocol}//${u.host}${pathname}`;
}

function decisionProblems(d) {
  const problems = [];
  if (!d.rawBaseUrl) problems.push(`${d.envPrefix}_BASE_URL is empty`);
  else if (!d.endpoint) problems.push(`${d.envPrefix}_BASE_URL is not a valid URL (${d.rawBaseUrl})`);
  if (!d.apiKey || /^<|your|xxx/i.test(d.apiKey)) problems.push(`${d.envPrefix}_API_KEY is empty`);
  return problems;
}

function decisionAuthHeaders(d) {
  let mode = d.authHeader;
  if (mode !== 'api-key' && mode !== 'bearer') mode = isAzureHost(safeHost(d.endpoint)) ? 'api-key' : 'bearer';
  return mode === 'api-key' ? { 'api-key': d.apiKey } : { Authorization: `Bearer ${d.apiKey}` };
}

// Same rules as the decision demo: accept the portal's resource endpoint, project URL, or full path.
function resolveDecisionEndpoint(protocol, raw) {
  if (!raw) return '';
  let u;
  try { u = new URL(raw.trim()); } catch { return ''; }
  let pathname = u.pathname.replace(/\/+$/, '');
  const azure = isAzureHost(u.hostname);
  if (protocol === 'decisions') {
    if (!/\/decisions$/i.test(pathname)) {
      if (azure) pathname = '/openai/v1/decisions';
      else if (u.hostname === 'api.openai.com') pathname = '/v1/decisions';
      else pathname = `${pathname}/decisions`;
    }
  } else if (!/\/systemone$/i.test(pathname)) {
    if (azure) pathname = '/providers/microsoft/v1/systemone';
    else pathname = /\/v1$/i.test(pathname) ? `${pathname}/systemone` : `${pathname}/v1/systemone`;
  }
  return `${u.protocol}//${u.host}${pathname}`;
}

function judgeList() {
  const llmProblems = modelProblems('JUDGE_MODEL', JUDGE_MODEL);
  return [
    { id: 'llm', kind: 'llm', label: JUDGE_MODEL || 'LLM judge', model: JUDGE_MODEL || null, host: safeHost(MODEL.endpoint) || null, ready: llmProblems.length === 0, problems: llmProblems },
    ...DECISION_JUDGES.map((d) => {
      const problems = decisionProblems(d);
      return { id: d.id, kind: 'decision', label: d.label, model: d.model, host: safeHost(d.endpoint) || null, ready: problems.length === 0, problems };
    }),
  ];
}

function readNumber(key, fallback) {
  const n = Number(env(key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

// ───────────────────────── search services ─────────────────────────

// Each service: build(p, q) → { url, method, headers, body }, parse(data, q) → [{ title, url, content, date, dateKind }],
// cost(data, p) → USD for this call. q = { query, topic, count, chars, market }.
const SERVICES = {
  webiq: {
    // https://api.microsoft.ai/v3/search/web and /search/news; content arrives as query-relevant passages.
    build: (p, q) => ({
      url: `${p.baseUrl.replace(/\/search(\/\w+)?$/i, '')}/search/${q.topic === 'news' ? 'news' : 'web'}`,
      method: 'POST',
      headers: { 'x-apikey': p.apiKey, 'Content-Type': 'application/json' },
      body: {
        query: q.query,
        maxResults: q.count,
        contentFormat: OPTIONS.webiqFormat,
        maxLength: q.chars,
        language: MARKETS[q.market].language,
        region: MARKETS[q.market].country,
        ...(OPTIONS.webiqSafeSearch && q.topic !== 'news' ? { safeSearch: OPTIONS.webiqSafeSearch } : {}),
      },
    }),
    // Whether Web IQ decided the query needs fresh documents (web search only); there is no request parameter for it.
    freshIntent: (d) => (typeof d?.querySignals?.freshness === 'boolean' ? d.querySignals.freshness : null),
    parse: (d) => firstArray(d, ['webResults', 'newsResults', 'results', 'value']).map((r) => ({
      title: r.title ?? r.name,
      url: r.url,
      content: r.content ?? r.snippet ?? r.description,
      ...pickDate(r, [['datePublished', 'published'], ['publishedAt', 'published'], ['lastUpdatedAt', 'updated'], ['lastUpdated', 'updated'], ['crawledAt', 'crawled']]),
    })),
  },

  tavily: {
    build: (p, q) => ({
      url: `${p.baseUrl}/search`,
      method: 'POST',
      headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
      body: {
        query: q.query,
        max_results: q.count,
        search_depth: OPTIONS.tavilyDepth,
        topic: q.topic === 'news' ? 'news' : 'general',
        ...(q.topic === 'news' ? { time_range: 'week' } : {}),
        include_usage: true,
        ...(q.topic === 'news' ? {} : { country: MARKETS[q.market].tavily }),
      },
    }),
    parse: (d) => firstArray(d, ['results']).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      ...pickDate(r, [['published_date', 'published']]),
    })),
    // 1 credit for basic/fast, 2 for advanced; the list price is per 1,000 basic searches.
    cost: (d, p) => (num(d?.usage?.credits) != null ? (d.usage.credits * p.pricePer1k) / 1000 : null),
  },

  exa: {
    build: (p, q) => ({
      url: `${p.baseUrl}/search`,
      method: 'POST',
      headers: { 'x-api-key': p.apiKey, 'Content-Type': 'application/json' },
      body: {
        query: q.query,
        type: OPTIONS.exaType,
        numResults: q.count,
        userLocation: MARKETS[q.market].country,
        ...(q.topic === 'news' ? { category: 'news', startPublishedDate: new Date(Date.now() - NEWS_WINDOW_MS).toISOString() } : {}),
        contents: { highlights: { maxCharacters: q.chars } },
      },
    }),
    parse: (d) => firstArray(d, ['results']).map((r) => ({
      title: r.title,
      url: r.url,
      content: Array.isArray(r.highlights) && r.highlights.length ? r.highlights.join(' … ') : r.text ?? r.summary,
      ...pickDate(r, [['publishedDate', 'published']]),
    })),
    cost: (d) => num(d?.costDollars?.total), // Exa reports the actual charge
  },

  brave: {
    // Web search with extra_snippets returns the description plus up to five more excerpts per result.
    build: (p, q) => {
      const params = new URLSearchParams({
        q: q.query,
        count: String(q.count),
        country: MARKETS[q.market].country,
        search_lang: MARKETS[q.market].brave,
        extra_snippets: 'true',
        ...(q.topic === 'news' ? { freshness: 'pw' } : {}),
      });
      return {
        url: `${p.baseUrl}/res/v1/${q.topic === 'news' ? 'news' : 'web'}/search?${params}`,
        method: 'GET',
        headers: { 'X-Subscription-Token': p.apiKey, Accept: 'application/json' },
      };
    },
    parse: (d) => (Array.isArray(d?.web?.results) ? d.web.results : firstArray(d, ['results'])).map((r) => ({
      title: stripTags(r.title),
      url: r.url,
      content: stripTags([r.description, ...(Array.isArray(r.extra_snippets) ? r.extra_snippets : [])].filter(Boolean).join(' … ')),
      ...pickDate(r, [['page_age', 'updated']]), // when Brave saw the page change, not necessarily first published
    })),
  },

  perplexity: {
    build: (p, q) => ({
      url: `${p.baseUrl}/search`,
      method: 'POST',
      headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
      body: {
        query: q.query,
        max_results: q.count,
        max_tokens_per_page: Math.max(64, Math.round(q.chars / 4)),
        country: MARKETS[q.market].country,
        search_language_filter: [MARKETS[q.market].language],
        ...(q.topic === 'news' ? { search_recency_filter: 'week' } : {}),
      },
    }),
    parse: (d) => firstArray(d, ['results']).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.snippet,
      ...pickDate(r, [['date', 'published'], ['last_updated', 'updated']]),
    })),
  },

  parallel: {
    build: (p, q) => ({
      url: `${p.baseUrl.replace(/\/v1(beta)?$/i, '')}/v1/search`,
      method: 'POST',
      headers: { 'x-api-key': p.apiKey, 'Content-Type': 'application/json' },
      body: {
        objective: q.query,
        search_queries: [q.query.slice(0, 200)],
        mode: p.mode,
        advanced_settings: {
          max_results: q.count,
          excerpt_settings: { max_chars_per_result: q.chars },
          location: MARKETS[q.market].country.toLowerCase(),
        },
      },
    }),
    parse: (d) => firstArray(d, ['results']).map((r) => ({
      title: r.title,
      url: r.url,
      content: Array.isArray(r.excerpts) ? r.excerpts.join(' … ') : r.excerpt ?? r.content,
      ...pickDate(r, [['publish_date', 'published']]),
    })),
  },

  serpapi: {
    // Google's results page, scraped and parsed by SerpApi. Snippets only (no page text), so the content budget
    // doesn't apply. The key can only go in the query string. no_cache stops a repeated query (speed test) from
    // returning SerpApi's one-hour cache instead of a live Google search.
    build: (p, q) => {
      const params = new URLSearchParams({
        engine: 'google',
        q: q.query,
        num: String(q.count),
        hl: MARKETS[q.market].google,
        gl: MARKETS[q.market].country.toLowerCase(),
        ...(q.topic === 'news' ? { tbm: 'nws', tbs: 'qdr:w' } : {}),
        ...(OPTIONS.serpapiNoCache ? { no_cache: 'true' } : {}),
        api_key: p.apiKey,
      });
      return { url: `${p.baseUrl.replace(/\/search(\.json)?$/i, '')}/search.json?${params}`, method: 'GET', headers: {} };
    },
    parse: (d, q) => firstArray(d, [q.topic === 'news' ? 'news_results' : 'organic_results']).map((r) => ({
      title: r.title,
      url: r.link,
      content: r.snippet,
      ...pickDate({ date: displayDate(r.date) }, [['date', 'published']]),
    })),
  },
};

function validateSearch(body) {
  if (!body || typeof body !== 'object') return 'Request body must be JSON';
  if (typeof body.query !== 'string' || !body.query.trim()) return 'The question is empty';
  if (body.query.length > MAX_QUERY_CHARS) return `The question is longer than ${MAX_QUERY_CHARS} characters`;
  if (!TOPICS.has(body.topic)) return `Unknown topic "${body.topic}"`;
  if (!COUNTS.has(body.count)) return `Result count must be one of ${[...COUNTS].join(', ')}`;
  if (!CHARS.has(body.chars)) return `Content per result must be one of ${[...CHARS].join(', ')}`;
  if (!MARKETS[body.market]) return `Unknown market "${body.market}"`;
  body.query = body.query.trim();
  return null;
}

async function runSearch(p, q) {
  const req = SERVICES[p.service].build(p, q);
  const body = req.body ? JSON.stringify(req.body) : undefined;
  if (DEBUG) console.log(`[${p.id}] → ${req.method} ${redactUrl(req.url)}\n${body ?? ''}`);
  const upstream = await send(req.url, { method: req.method, headers: { Accept: 'application/json', ...req.headers }, body });
  let data = null;
  try { data = JSON.parse(upstream.text); } catch { /* not JSON */ }
  if (DEBUG) console.log(`[${p.id}] ← ${upstream.status} ${upstream.timing.totalMs}ms ${upstream.text.slice(0, 800)}`);
  return { req, data, ...upstream };
}

async function search(req, res) {
  const body = await readJson(req);
  const p = PROVIDERS.find((x) => x.id === body?.provider);
  if (!p) return sendJson(res, 400, { ok: false, error: 'Unknown search service' });
  const problems = providerProblems(p);
  if (problems.length) return sendJson(res, 200, { ok: false, provider: p.id, notConfigured: true, error: problems.join('; ') });
  const invalid = validateSearch(body);
  if (invalid) return sendJson(res, 400, { ok: false, provider: p.id, error: invalid });

  const q = { query: body.query, topic: body.topic, count: body.count, chars: body.chars, market: body.market };
  let r;
  try {
    r = await runSearch(p, q);
  } catch (err) {
    const reason = err.code === 'TIMEOUT' ? err.message : err.code || err.message;
    return sendJson(res, 200, { ok: false, provider: p.id, error: `Could not reach ${safeHost(p.baseUrl)}: ${reason}` });
  }
  const wire = { endpoint: `${r.req.method} ${redactUrl(r.req.url)}`, request: r.req.body ?? redactParams(new URL(r.req.url).searchParams), response: r.data ? shorten(r.data) : r.text.slice(0, 4000) };
  if (r.status < 200 || r.status >= 300) {
    const error = upstreamError(`${p.envPrefix}_API_KEY`, `${p.envPrefix}_BASE_URL`, r.status, r.data, r.text);
    console.warn(`[${p.id}] ${r.status} ${error}`);
    return sendJson(res, 200, { ok: false, provider: p.id, status: r.status, latencyMs: r.timing.totalMs, timing: r.timing, error, ...wire });
  }

  const results = SERVICES[p.service].parse(r.data, q)
    .filter((x) => x && typeof x.url === 'string')
    .slice(0, q.count)
    .map((x) => {
      // Some APIs treat the content budget as a target (Exa's highlights run over it), so hold every service to it here.
      const full = clean(x.content);
      const content = clip(full, q.chars);
      // With no publish or update date from the service, a date in the URL (arXiv ID, /2026/08/08/) says when the page was written.
      const fromUrl = (!x.date || x.dateKind === 'crawled') ? urlDate(x.url) : null;
      return {
        title: clean(x.title) || x.url,
        url: x.url,
        domain: safeHost(x.url).replace(/^www\./, ''),
        content,
        ...(content.length < full.length ? { trimmedFrom: full.length } : {}),
        date: fromUrl?.date ?? x.date ?? null,
        dateKind: fromUrl ? 'url' : x.date ? x.dateKind : null,
        ...(fromUrl?.month ? { dateMonth: true } : {}),
        ...(fromUrl && x.date ? { crawledAt: x.date } : {}),
      };
    });
  const contextChars = results.reduce((n, x) => n + x.content.length, 0);
  const costFn = SERVICES[p.service].cost;
  const cost = (costFn && costFn(r.data, p)) ?? (p.pricePer1k != null ? p.pricePer1k / 1000 : null);

  console.log(`[${p.id}] ${r.status} ${r.timing.totalMs}ms ${results.length} results ${contextChars} chars`);
  sendJson(res, 200, {
    ok: true,
    provider: p.id,
    status: r.status,
    latencyMs: r.timing.totalMs,
    timing: r.timing,
    results,
    contextChars,
    freshIntent: SERVICES[p.service].freshIntent?.(r.data) ?? null,
    cost,
    ...wire,
  });
}

async function speedtest(req, res) {
  const body = await readJson(req);
  const p = PROVIDERS.find((x) => x.id === body?.provider);
  if (!p) return sendJson(res, 400, { ok: false, error: 'Unknown search service' });
  const problems = providerProblems(p);
  if (problems.length) return sendJson(res, 200, { ok: false, provider: p.id, notConfigured: true, error: problems.join('; ') });
  const invalid = validateSearch(body);
  if (invalid) return sendJson(res, 400, { ok: false, provider: p.id, error: invalid });
  const n = Math.min(MAX_SPEED_RUNS, Math.max(1, Number(body.runs) || 10));
  const q = { query: body.query, topic: body.topic, count: body.count, chars: body.chars, market: body.market };

  const latencies = [];
  let cost = 0;
  // The first call opens the connection and is not counted, so every measured call runs on a warm socket.
  for (let i = 0; i <= n; i++) {
    let r;
    try { r = await runSearch(p, q); } catch (err) {
      return sendJson(res, 200, { ok: false, provider: p.id, latencies, error: `Could not reach ${safeHost(p.baseUrl)}: ${err.code || err.message}` });
    }
    if (r.status < 200 || r.status >= 300) {
      return sendJson(res, 200, { ok: false, provider: p.id, latencies, status: r.status, error: upstreamError(`${p.envPrefix}_API_KEY`, `${p.envPrefix}_BASE_URL`, r.status, r.data, r.text) });
    }
    if (i > 0) latencies.push(r.timing.totalMs);
    cost += SERVICES[p.service].cost?.(r.data, p) ?? p.pricePer1k / 1000;
  }
  const host = new URL(p.baseUrl).host;
  console.log(`[${p.id}] speed test ${n} runs: ${latencies.join(', ')} ms`);
  sendJson(res, 200, { ok: true, provider: p.id, latencies, roundTripMs: roundTrips.get(host) ?? null, cost });
}

// ───────────────────────── relevance judge ─────────────────────────

// Relevance is graded per result, on exactly what the search returned, across all services in one
// call: one consistent judge, and documents from other services show when a result is out of date.
const RELEVANCE_INSTRUCTIONS = [
  'You grade web search results for how well each one helps answer a question. You get the current date and time (UTC, with the weekday), the question, and numbered documents. Each document is the title, URL, date (if any), and the excerpt a search service returned. Grade only what the document shows, because that is all a model answering from it would see.',
  'Grades:',
  '3 = gives the answer, or most of it, with specifics: the fact, figure, name, date, version, or named development asked for. When the question spells out a list of things to give (named items to compare, or named attributes of each, such as a launch date, a price, and a chip), 3 needs most of them; a document with only one or a few of them is 2. A question that asks in general (latest updates, what is new) does not spell out a list; the broad-question rule applies to it instead. For a broad question (latest developments, what is new, trends), 3 needs concrete, checkable specifics such as named releases, features, methods, papers, products, or results; a generic list of trends or buzzwords is 2 at most.',
  '2 = partly answers: only some of the things a question lists, relevant specifics that help but are not the main thing asked, or the answer only implied or stated in general terms.',
  '1 = on topic but does not help answer: background, a general page, or information that has been superseded.',
  '0 = off topic, empty, or spam.',
  'Superseded means replaced, not merely older. When the question asks for the latest, current, or recent information, a document is superseded (1) only if what it presents as current has since been replaced, as the other documents or the dates show: it calls version 26 the latest when another document shows a newer version released, or it reports a figure or result that a newer document updates.',
  'Tell a narrow question from a broad one. A narrow question asks for the single latest item (the latest version, the most recent result, today\'s figure); only documents with that item answer it. A broad question asks about recent updates or developments in general; a document about anything still current answers it, even if other documents are newer. For example, coverage of the current major release still answers "what are the latest updates" after a point release, but not "what is the latest version number".',
  'Questions about today, yesterday, or this week mean that period where the question is set, in its own time zone (US markets: New York time, where a trading day runs 9:30 a.m. to 4 p.m.). Before that period has any activity at the time given (a market question asked before the open, or on a weekend or holiday), today means the most recent session: a document about that last completed session answers it, and so does one about moves so far today (pre-market futures); the asker may be in a time zone where that session already falls on today. Otherwise a document about an earlier day or week does not answer such a question (1), however close in time; one about the right period that gives figures or reasons does. Tell which day a document covers from what it reports (the weekday, date, and events it names), not from its date label alone: services\' dates are often stale or wrong, and live pages keep an old URL or date while their text is new. Use the date and time given here, not your own sense of the date.',
  'Do not grade down a document for its age alone; recency is measured separately. Do not rely on your own knowledge of what is current; it may be out of date.',
  'Grade each document on its own; any number of them may earn the same grade. Grade every document exactly once, by its number.',
].join('\n');

const RELEVANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['grades'],
  properties: {
    grades: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['n', 'grade'], properties: { n: { type: 'integer', minimum: 1 }, grade: { type: 'integer', minimum: 0, maximum: 3 } } },
    },
  },
};

async function relevance(req, res) {
  const body = await readJson(req, 4_000_000);
  const judge = judgeList().find((j) => j.id === (body?.judge || DEFAULT_JUDGE));
  if (!judge) return sendJson(res, 400, { ok: false, error: `Unknown judge "${body?.judge}"` });
  if (!judge.ready) return sendJson(res, 200, { ok: false, notConfigured: true, error: judge.problems.join('; ') });
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) return sendJson(res, 400, { ok: false, error: 'The question is empty' });
  if (!Array.isArray(body.lanes)) return sendJson(res, 400, { ok: false, error: 'lanes must be an array' });

  // Share grades only when the URL, full excerpt, title, and date match across services.
  // Within a service, a repeated URL or excerpt is a duplicate and scores 0.
  const docs = [];
  const byKey = new Map();
  const lanes = body.lanes.slice(0, 12).map((lane) => {
    const seenUrls = new Set();
    const seenTexts = new Set();
    const items = (Array.isArray(lane?.sources) ? lane.sources.slice(0, 10) : []).map((s) => {
      const url = normalizeUrl(s?.url);
      const text = clean(s?.content).slice(0, MAX_CHARS);
      const title = clean(s?.title);
      const date = s?.date ? (s.dateKind === 'url' ? `published (from the URL): ${s.dateMonth ? String(s.date).slice(0, 7) : String(s.date).slice(0, 10)}` : `${s.dateKind || 'date'}: ${s.date}`) : '';
      if (seenUrls.has(url) || (text && seenTexts.has(text))) return { dup: true };
      seenUrls.add(url);
      if (text) seenTexts.add(text);
      const key = JSON.stringify([url, title, date, text]);
      let doc = byKey.get(key);
      if (!doc) {
        doc = { title, url: String(s?.url ?? ''), date, text };
        byKey.set(key, doc);
        docs.push(doc);
      }
      return { doc };
    });
    return { id: String(lane?.id ?? ''), items };
  });
  if (!docs.length) return sendJson(res, 200, { ok: true, judge: judge.id, latencyMs: 0, documents: 0, lanes: Object.fromEntries(lanes.map((l) => [l.id, l.items.map(() => ({ grade: 0, dup: true }))])) });

  // Shuffled so a document's position doesn't reveal which service returned it.
  for (let i = docs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [docs[i], docs[j]] = [docs[j], docs[i]];
  }
  docs.forEach((d, i) => { d.n = i + 1; });
  const list = docs.map((d) => `[${d.n}] ${d.title}\n${d.url}${d.date ? `\n${d.date}` : ''}\n${d.text || '(no excerpt)'}`).join('\n\n');
  const input = `Now: ${nowForJudge()}\n\nQuestion: ${question}\n\nDocuments:\n\n${list}`;

  const started = performance.now();
  const r = judge.kind === 'llm' ? await gradeWithLlm(input, docs) : await gradeWithDecision(DECISION_JUDGES.find((d) => d.id === judge.id), input, docs);
  const latencyMs = Math.round(performance.now() - started);
  if (!r.ok) return sendJson(res, 200, { ok: false, judge: judge.id, status: r.status, error: r.error });
  const grades = r.grades;

  console.log(`[relevance:${judge.id}] ${latencyMs}ms ${docs.length} documents${r.requests > 1 ? ` in ${r.requests} requests` : ''}`);
  sendJson(res, 200, {
    ok: true,
    judge: judge.id,
    latencyMs,
    documents: docs.length,
    usage: r.usage ?? null,
    lanes: Object.fromEntries(lanes.map((l) => [l.id, l.items.map((x) => (x.dup ? { grade: 0, dup: true } : { grade: grades.get(x.doc.n) }))])),
  });
}

function validateGrades(entries, docs) {
  if (!Array.isArray(entries)) return { ok: false, error: 'The judge did not return relevance grades' };
  const expected = new Set(docs.map((doc) => doc.n));
  const grades = new Map();
  for (const entry of entries) {
    if (!Number.isInteger(entry?.n) || !expected.has(entry.n)) return { ok: false, error: 'The judge returned an unknown document number' };
    if (grades.has(entry.n)) return { ok: false, error: `The judge graded document [${entry.n}] more than once` };
    if (!Number.isInteger(entry.grade) || entry.grade < 0 || entry.grade > 3) {
      return { ok: false, error: `The judge returned an invalid or refused grade for document [${entry.n}]; expected an integer from 0 to 3` };
    }
    grades.set(entry.n, entry.grade);
  }
  if (grades.size !== expected.size) return { ok: false, error: `The judge left ${expected.size - grades.size} of ${expected.size} documents ungraded; relevance scores are unavailable` };
  return { ok: true, grades };
}

// The LLM judge grades every document in one call, as JSON.
async function gradeWithLlm(input, docs) {
  const request = {
    model: JUDGE_MODEL,
    instructions: RELEVANCE_INSTRUCTIONS,
    input,
    text: { format: { type: 'json_schema', name: 'relevance_grades', strict: true, schema: RELEVANCE_SCHEMA } },
  };
  if (JUDGE_EFFORT) request.reasoning = { effort: JUDGE_EFFORT };
  let r;
  try {
    r = await send(MODEL.endpoint, { method: 'POST', headers: { ...modelAuthHeaders(), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(request) });
  } catch (err) {
    return { ok: false, error: `Could not reach ${safeHost(MODEL.endpoint)}: ${err.code || err.message}` };
  }
  let data = null;
  try { data = JSON.parse(r.text); } catch { /* not JSON */ }
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, status: r.status, error: upstreamError('MODEL_API_KEY', 'MODEL_BASE_URL', r.status, data, r.text, JUDGE_MODEL, 'JUDGE_MODEL') };
  }
  let out = null;
  try { out = JSON.parse(outputText(data)); } catch { /* handled below */ }
  const validated = validateGrades(out?.grades, docs);
  if (!validated.ok) return validated;
  return {
    ...validated,
    requests: 1,
    usage: { input: num(data?.usage?.input_tokens), output: num(data?.usage?.output_tokens) },
  };
}

// A decision model gets the same rules and documents as its input, and one score question per document (levels 0-3).
// The grade is the most probable level. Batches of DECISION_BATCH questions run in parallel.
// Decision models take their task from the question and level text and treat the input as data, so the rules that
// matter most (judge content, not age) are stated here too; with them only in the input, older pages were marked down.
const DECISION_LEVELS = [
  ['0', 'Off topic, empty, or spam.'],
  ['1', 'On topic but does not help answer: background or a general page, or information that a newer document shows has been replaced (for example, it calls an older version the latest). Being older than other documents is not enough.'],
  ['2', 'Partly answers: relevant specifics that are not the main thing asked, or the answer stated only in general terms.'],
  ['3', 'Gives the answer with specifics. For a general question (latest updates, what is new), concrete specifics about a current development are enough. When the question itself lists the things to give, such as a launch date, a price, and a chip for each product, it covers most of that list. An older document qualifies when what it says is still current.'],
];

function decisionInstructions(n) {
  return `Grade document [${n}] for how well its text helps answer the question. Judge what it says, not when it was written: a date or age never lowers the grade by itself, and recency is measured separately. `
    + 'Grade down for age only when the question asks for a single latest item (the latest version, the most recent result, today\'s figure) and another document shows a newer one. '
    + 'For a broad question (latest developments, what is new), a document about something still current answers it even if other documents are newer. '
    + 'A question about today, yesterday, or this week is answered only by documents about that period, placed with the time given at the top of the input; a document about an earlier day is 1. Before a market opens, or when it is closed for the day, today means the most recent completed session (or moves so far today, such as futures). Tell the day from what the text reports (weekday, date, events), not from its date label, which is often stale. The full grading rules are at the top of the input.';
}

async function gradeWithDecision(d, input, docs) {
  const state = `${RELEVANCE_INSTRUCTIONS}\n\n${input}`;
  const batches = [];
  for (let i = 0; i < docs.length; i += DECISION_BATCH) batches.push(docs.slice(i, i + DECISION_BATCH));
  const results = await Promise.all(batches.map((batch) => decide(d, state, batch)));
  const failed = results.find((x) => !x.ok);
  if (failed) return failed;
  const grades = new Map(results.flatMap((x) => [...x.grades]));
  const usage = results.reduce((u, x) => ({ input: (u.input ?? 0) + (x.usage?.input ?? 0), output: (u.output ?? 0) + (x.usage?.output ?? 0) }), {});
  return { ok: true, requests: batches.length, grades, usage };
}

async function decide(d, state, batch) {
  const request = d.protocol === 'decisions'
    ? {
        model: d.model,
        input: state,
        questions: batch.map((doc) => ({ type: 'score', name: `doc${doc.n}`, instructions: decisionInstructions(doc.n), levels: DECISION_LEVELS.map(([label, description]) => ({ label, description })) })),
      }
    : {
        model: d.model,
        state,
        questions: Object.fromEntries(batch.map((doc) => [`doc${doc.n}`, { type: 'score', instructions: decisionInstructions(doc.n), criteria: DECISION_LEVELS.map(([label, description]) => `${label}: ${description}`) }])),
      };
  if (DEBUG) console.log(`[relevance:${d.id}] → POST ${d.endpoint} (${batch.length} questions)`);
  let r;
  try {
    r = await send(d.endpoint, { method: 'POST', headers: { ...decisionAuthHeaders(d), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(request) });
  } catch (err) {
    return { ok: false, error: `Could not reach ${safeHost(d.endpoint)}: ${err.code || err.message}` };
  }
  let data = null;
  try { data = JSON.parse(r.text); } catch { /* not JSON */ }
  if (DEBUG) console.log(`[relevance:${d.id}] ← ${r.status} ${r.timing.totalMs}ms ${r.text.slice(0, 800)}`);
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, status: r.status, error: upstreamError(`${d.envPrefix}_API_KEY`, `${d.envPrefix}_BASE_URL`, r.status, data, r.text, d.model, `${d.envPrefix}_MODEL`) };
  }
  const names = d.protocol === 'decisions'
    ? (Array.isArray(data?.answers) ? data.answers.map((answer) => answer?.name) : null)
    : (data?.answers && typeof data.answers === 'object' && !Array.isArray(data.answers) ? Object.keys(data.answers) : null);
  if (!names) return { ok: false, error: 'The judge did not return relevance answers' };
  const expected = new Map(batch.map((doc) => [`doc${doc.n}`, doc.n]));
  const validated = validateGrades(names.map((name) => ({ n: expected.get(name), grade: decisionGrade(d.protocol, data, name) })), batch);
  if (!validated.ok) return validated;
  return { ...validated, usage: { input: num(data?.usage?.input_tokens ?? data?.usage?.prompt_tokens), output: num(data?.usage?.output_tokens ?? data?.usage?.completion_tokens) } };
}

// Most probable level of one score answer; falls back to the reported score. Refusals and missing answers: null.
function decisionGrade(protocol, data, name) {
  const a = protocol === 'decisions'
    ? (Array.isArray(data?.answers) ? data.answers.find((x) => x?.name === name) : null)
    : data?.answers?.[name];
  if (!a || typeof a !== 'object' || a.type === 'refusal') return null;
  const probs = a.probabilities;
  const p = DECISION_LEVELS.map(([label], i) => num(Array.isArray(probs)
    ? probs.find((x) => x?.value === i || String(x?.value) === label || x?.label === label)?.probability ?? probs[i]
    : probs?.[label] ?? probs?.[i]));
  if (probs != null) {
    if (p.some((probability) => probability == null || probability < 0 || probability > 1) || p.every((probability) => probability === 0)) return null;
    return p.reduce((best, probability, index) => (probability > p[best] ? index : best), 0);
  }
  const score = num(a.score);
  return score == null || score < 0 || score > 3 ? null : Math.round(score);
}

// ───────────────────────── http ─────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/config') {
      const providers = PROVIDERS.map((p) => {
        const problems = providerProblems(p);
        return {
          id: p.id, label: p.label, vendor: p.vendor, envPrefix: p.envPrefix, host: safeHost(p.baseUrl),
          pricePer1k: p.pricePer1k, signup: p.signup, ready: problems.length === 0, problems,
          mode: p.mode ?? { webiq: [OPTIONS.webiqFormat, OPTIONS.webiqSafeSearch && `safeSearch ${OPTIONS.webiqSafeSearch}`].filter(Boolean).join(' · '), tavily: OPTIONS.tavilyDepth, exa: OPTIONS.exaType, serpapi: OPTIONS.serpapiNoCache ? 'no_cache' : 'cached' }[p.id] ?? null,
        };
      });
      const ready = providers.some((p) => p.ready);
      return sendJson(res, 200, {
        ready,
        problems: ready ? [] : ['No search service is configured in webiq/.env'],
        providers,
        judges: judgeList(),
        defaultJudge: DEFAULT_JUDGE,
        markets: Object.keys(MARKETS),
        hubUrl: HUB_URL,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/search') return await search(req, res);
    if (req.method === 'POST' && url.pathname === '/api/relevance') return await relevance(req, res);
    if (req.method === 'POST' && url.pathname === '/api/speedtest') return await speedtest(req, res);

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, res);

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[http] error', err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
  }
});

// HTTPS request on the keep-alive pool, timed by phase:
//   connectMs   DNS + TCP + TLS, 0 when an open connection was reused
//   responseMs  from connected to the last byte: upload, one round trip, service time, download
//   roundTripMs last TCP handshake to this host, about one network round trip
function send(url, { method = 'GET', headers = {}, body } = {}, retry = true) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const t0 = performance.now();
    let dnsAt, tcpAt, tlsAt;
    const req = lib.request(u, {
      method,
      headers: body ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers,
      agent: AGENTS[u.protocol],
      timeout: TIMEOUT_MS,
    });
    req.on('socket', (socket) => {
      if (req.reusedSocket) return;
      socket.once('lookup', () => { dnsAt = performance.now(); });
      socket.once('connect', () => { tcpAt = performance.now(); roundTrips.set(u.host, Math.round(tcpAt - (dnsAt ?? t0))); });
      socket.once('secureConnect', () => { tlsAt = performance.now(); });
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const end = performance.now();
        const connected = req.reusedSocket ? t0 : (tlsAt ?? tcpAt ?? t0);
        resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString('utf8'),
          timing: {
            reused: req.reusedSocket,
            connectMs: Math.round(connected - t0),
            responseMs: Math.round(end - connected),
            totalMs: Math.round(end - t0),
            roundTripMs: roundTrips.get(u.host) ?? null,
          },
        });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`timed out after ${TIMEOUT_MS / 1000}s`), { code: 'TIMEOUT' })));
    req.on('error', (err) => {
      // The server closed a pooled socket while it sat idle: retry once on a fresh connection.
      if (retry && req.reusedSocket && err.code === 'ECONNRESET') return send(url, { method, headers, body }, false).then(resolve, reject);
      reject(err);
    });
    req.end(body);
  });
}

function upstreamError(keyVar, urlVar, status, data, text, model, modelVar) {
  const err = data?.error && typeof data.error === 'object' ? data.error : null;
  const detail = Array.isArray(data?.detail) ? data.detail.map((d) => d?.msg).filter(Boolean).join('; ') : '';
  const msg = err?.message || data?.userMessage || data?.message || (typeof data?.error === 'string' ? data.error : '') || detail ||
    (typeof data?.detail === 'string' ? data.detail : '') || (typeof text === 'string' ? text.slice(0, 400) : '') || `HTTP ${status}`;
  const hint =
    status === 401 || status === 403
      ? ` Check ${keyVar} in .env.`
      : status === 404
        ? model ? ` Check ${urlVar}, and that "${model}" (${modelVar}) is a deployment in that resource.` : ` Check ${urlVar}.`
        : status === 402
          ? ' The account is out of credits.'
          : status === 429
            ? ' Rate limit or quota reached. Wait a moment and try again.'
            : model && (status === 400 || status === 422) && /model|deployment/i.test(msg)
              ? ` Check that "${model}" (${modelVar}) is the right deployment name.`
              : '';
  return hint ? `${String(msg).replace(/[.\s]*$/, '')}.${hint}` : String(msg);
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ───────────────────────── start ─────────────────────────

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. The demo may already be running at http://localhost:${PORT}`);
    console.error('  Stop the other process, or set PORT in .env to use a different port.\n');
  } else {
    console.error('[server] error', err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Web IQ demo');
  console.log(`  ▸ Open      http://localhost:${PORT}`);
  for (const p of PROVIDERS) {
    const problems = providerProblems(p);
    console.log(`  ▸ ${p.label.padEnd(18)} ${problems.length ? `⚠ ${problems.join('; ')}` : p.baseUrl}`);
  }
  for (const j of judgeList()) {
    console.log(`  ▸ ${`Judge: ${j.label}`.padEnd(30)} ${j.ready ? `${j.host}  model ${j.model}` : `⚠ ${j.problems.join('; ')}`}${j.id === DEFAULT_JUDGE ? '  (default)' : ''}`);
  }
  console.log('');
});

// ───────────────────────── helpers ─────────────────────────

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function firstArray(data, keys) {
  for (const k of keys) if (Array.isArray(data?.[k])) return data[k];
  return [];
}

// The first date field present, with what kind of date it is (published, updated, or crawled).
function pickDate(r, fields) {
  for (const [key, kind] of fields) {
    if (typeof r?.[key] === 'string' && r[key].trim()) return { date: asUtc(r[key].trim()), dateKind: kind };
  }
  return { date: null, dateKind: null };
}

// The publication date a URL carries: an arXiv ID (YYMM.NNNNN, month only), or /YYYY/MM/DD/ or /YYYY/MM/ in the path.
// A month-only date is the 1st of the month, so it never makes a page look newer than it is. Future dates are ignored.
function urlDate(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const make = (y, m, d) => {
    const t = Date.UTC(y, m - 1, d ?? 1);
    const ok = m >= 1 && m <= 12 && (d == null || (d >= 1 && d <= 31)) && y >= 1995 && t <= Date.now() + 864e5;
    return ok ? { date: new Date(t).toISOString(), ...(d == null ? { month: true } : {}) } : null;
  };
  const arxiv = /(^|\.)arxiv\.org$/.test(u.hostname) && u.pathname.match(/^\/(?:abs|html|pdf)\/(\d\d)(\d\d)\.\d{4,5}/);
  if (arxiv) return make(2000 + Number(arxiv[1]), Number(arxiv[2]));
  const day = u.pathname.match(/\/((?:19|20)\d\d)[/-](\d\d?)[/-](\d\d?)(?=[/\-_.]|$)/);
  if (day) return make(Number(day[1]), Number(day[2]), Number(day[3]));
  const month = u.pathname.match(/\/((?:19|20)\d\d)\/(\d\d)\//);
  return month ? make(Number(month[1]), Number(month[2])) : null;
}

// A date-time with no zone (Web IQ's lastUpdatedAt) would be read in the viewer's local time; treat it as UTC.
function asUtc(s) {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s) ? `${s}Z` : s;
}

// Google shows "3 days ago" for recent pages; turn that into an ISO date so it sorts and ages like the others.
const AGO_MS = { min: 6e4, minute: 6e4, hour: 36e5, hr: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6, 分钟: 6e4, 小时: 36e5, 天: 864e5, 周: 6048e5, 个月: 2592e6, 年: 31536e6 };
function displayDate(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const m = s.match(/(\d+)\s*(minute|min|hour|hr|day|week|month|year)s?\s+ago/i) || s.match(/(\d+)\s*(分钟|小时|天|周|个月|年)前/);
  if (m) return new Date(Date.now() - Number(m[1]) * AGO_MS[m[2].toLowerCase()]).toISOString();
  // An absolute date ("Jul 25, 2025", "2025年7月25日") is a calendar day; store it as that day in UTC like the other services.
  const zh = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const t = zh ? Date.UTC(Number(zh[1]), Number(zh[2]) - 1, Number(zh[3])) : Date.parse(s.trim());
  if (!Number.isFinite(t)) return s.trim();
  if (zh) return new Date(t).toISOString();
  const d = new Date(t);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
}

function stripTags(s) {
  return typeof s === 'string' ? s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') : s;
}

function clean(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

// The judge's clock: the UTC time with the weekday, so "today" and "this week" can be placed (a run from Asia is already tomorrow there).
function nowForJudge() {
  const d = new Date();
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC (${d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}); New York: ${d.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}`;
}

// Cut text to at most max characters, at a word break when one is near, ending in an ellipsis.
function clip(s, max) {
  if (!max || s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.9 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// The text of a Responses API reply.
function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  return (data?.output ?? []).flatMap((item) => item?.content ?? []).filter((c) => c?.type === 'output_text').map((c) => c.text ?? '').join('');
}

// Long strings make the wire view unreadable; keep the start of each.
function shorten(value, max = 400) {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}… (${value.length} chars)` : value;
  if (Array.isArray(value)) return value.map((v) => shorten(v, max));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v, max)]));
}

// Same page, however a service spells the URL: no scheme, www, trailing slash, fragment, or utm_ parameters.
function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    return `${u.host.replace(/^www\./i, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return String(raw ?? '');
  }
}

function redactUrl(url) {
  return url.replace(/([?&](?:key|api_key|apikey|token)=)[^&]+/gi, '$1…');
}

function redactParams(params) {
  return Object.fromEntries([...params].map(([k, v]) => [k, /^(key|api_key|apikey|token)$/i.test(k) ? '…' : v]));
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve(null); }
    });
    req.on('error', reject);
  });
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
