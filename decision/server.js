// Decision models demo server
// - Serves the browser app from ./public
// - GET  /api/config : which providers are configured (never returns keys)
// - POST /api/decide : runs one provider on { provider, state, questions } and returns normalized answers,
//                      latency with a connect/response breakdown, usage, and the raw request/response.
// - POST /api/warm   : opens (or keeps open) one pooled connection per provider with a keyless GET,
//                      so a run measures the model rather than the TLS handshake. Nothing is billed.
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

// Two wire protocols cover all three providers:
//   systemone : { model, state, questions: { name: { type: noul|choice|score, instructions, criteria } } }
//               used by Microsoft-Decision-1 (Foundry) and TypeSafe Jev
//   decisions : { model, input, questions: [ { type: predicate|choice|score, name, instructions, choices|levels } ] }
//               used by the OpenAI / Azure OpenAI Decisions API
const PROVIDERS = [
  {
    id: 'microsoft',
    label: 'Microsoft-Decision-1',
    vendor: 'Microsoft Foundry',
    protocol: 'systemone',
    envPrefix: 'MS_DECISION',
    defaultModel: 'Microsoft-Decision-1',
    defaultBaseUrl: '',
    defaultPrice: { input: 0.042, output: 0 },
  },
  {
    id: 'openai',
    label: 'GPT Decisions API',
    vendor: 'OpenAI / Azure OpenAI',
    protocol: 'decisions',
    envPrefix: 'GPT_DECISION',
    defaultModel: 'gpt-6-luna',
    defaultBaseUrl: '',
    defaultPrice: { input: 0.10, output: 0 },
  },
  {
    id: 'jev',
    label: 'Jev',
    vendor: 'TypeSafe',
    protocol: 'systemone',
    envPrefix: 'JEV',
    defaultModel: 'jev-latest',
    defaultBaseUrl: 'https://api.typesafe.ai',
    defaultPrice: { input: 0.042, output: 0 },
  },
].map((p) => {
  const rawBaseUrl = env(`${p.envPrefix}_BASE_URL`, p.defaultBaseUrl);
  return {
    ...p,
    rawBaseUrl,
    endpoint: resolveEndpoint(p, rawBaseUrl),
    apiKey: env(`${p.envPrefix}_API_KEY`),
    model: env(`${p.envPrefix}_MODEL`, p.defaultModel),
    authHeader: env(`${p.envPrefix}_AUTH_HEADER`, 'auto').toLowerCase(),
    price: readPrice(p),
  };
});

// List price in USD per 1M tokens, for the cost row. Defaults are published list prices as of
// October 2026; set *_PRICE_INPUT_PER_1M / *_PRICE_OUTPUT_PER_1M to match your contract.
function readPrice(p) {
  const input = Number(env(`${p.envPrefix}_PRICE_INPUT_PER_1M`, String(p.defaultPrice.input)));
  const output = Number(env(`${p.envPrefix}_PRICE_OUTPUT_PER_1M`, String(p.defaultPrice.output)));
  return Number.isFinite(input) && Number.isFinite(output) ? { input, output } : null;
}

const PORT = Number(env('PORT', '3001')) || 3001;
const TIMEOUT_MS = (Number(env('REQUEST_TIMEOUT_SECONDS', '30')) || 30) * 1000;
const DEBUG = /^(1|true|yes|on)$/i.test(env('DEBUG'));
const HUB_URL = process.env.DEMOBOX_HUB_URL || 'http://localhost:8000';

// Pooled keep-alive connections to the providers. Idle sockets close after a minute;
// the page's warm-up ping (every 20s) keeps them open while it is visible.
const SOCKET_IDLE_MS = 60_000;
const AGENTS = {
  'https:': new https.Agent({ keepAlive: true, timeout: SOCKET_IDLE_MS }),
  'http:': new http.Agent({ keepAlive: true, timeout: SOCKET_IDLE_MS }),
};
const roundTrips = new Map(); // host → last TCP handshake in ms, i.e. about one network round trip

const QUESTION_TYPES = new Set(['yesno', 'choice', 'score']);
const MAX_QUESTIONS = 20;
const MAX_STATE_CHARS = 60_000;

function providerProblems(p) {
  const problems = [];
  if (!p.rawBaseUrl) problems.push(`${p.envPrefix}_BASE_URL is empty`);
  else if (!p.endpoint) problems.push(`${p.envPrefix}_BASE_URL is not a valid URL (${p.rawBaseUrl})`);
  if (!p.apiKey || /^<|your|xxx/i.test(p.apiKey)) problems.push(`${p.envPrefix}_API_KEY is empty`);
  return problems;
}

function isAzureHost(host) {
  return /\.(azure\.com|azure-api\.net|azure\.cn)$/i.test(host);
}

function authHeaders(p) {
  let mode = p.authHeader;
  if (mode !== 'api-key' && mode !== 'bearer') {
    mode = isAzureHost(safeHost(p.endpoint)) ? 'api-key' : 'bearer';
  }
  return mode === 'api-key' ? { 'api-key': p.apiKey } : { Authorization: `Bearer ${p.apiKey}` };
}

// Accept whatever the portal shows (resource endpoint, project URL, or the full path) and return the full POST URL.
function resolveEndpoint(p, raw) {
  if (!raw) return '';
  let u;
  try { u = new URL(raw.trim()); } catch { return ''; }
  let pathname = u.pathname.replace(/\/+$/, '');
  const azure = isAzureHost(u.hostname);

  if (p.protocol === 'decisions') {
    if (!/\/decisions$/i.test(pathname)) {
      if (azure) pathname = '/openai/v1/decisions';
      else if (u.hostname === 'api.openai.com') pathname = '/v1/decisions';
      else pathname = `${pathname}/decisions`;
    }
  } else if (!/\/systemone$/i.test(pathname)) {
    if (azure) pathname = '/providers/microsoft/v1/systemone'; // also drops /openai/v1 or /api/projects/... pasted from the portal
    else pathname = /\/v1$/i.test(pathname) ? `${pathname}/systemone` : `${pathname}/v1/systemone`;
  }
  return `${u.protocol}//${u.host}${pathname}`;
}

// ───────────────────────── request mapping ─────────────────────────

// Canonical question (from the browser): { name, type: yesno|choice|score, instructions, options: [{ value, description }] }
// For choice, options are the labels to pick from. For score, options are the levels, lowest first.

function buildRequest(p, state, questions) {
  if (p.protocol === 'decisions') {
    return {
      model: p.model,
      input: typeof state === 'string' ? state : JSON.stringify(state, null, 2),
      questions: questions.map((q) => {
        if (q.type === 'yesno') return { type: 'predicate', name: q.name, instructions: q.instructions };
        if (q.type === 'choice') {
          return {
            type: 'choice', name: q.name, instructions: q.instructions,
            choices: q.options.map((o) => ({ value: o.value, description: o.description || o.value })),
          };
        }
        return {
          type: 'score', name: q.name, instructions: q.instructions,
          levels: q.options.map((o) => ({ label: o.value, description: o.description || o.value })),
        };
      }),
    };
  }

  const out = {};
  for (const q of questions) {
    if (q.type === 'yesno') out[q.name] = { type: 'noul', instructions: q.instructions };
    else if (q.type === 'choice') {
      out[q.name] = {
        type: 'choice', instructions: q.instructions,
        criteria: Object.fromEntries(q.options.map((o) => [o.value, o.description || o.value])),
      };
    } else {
      // Score levels are a plain ordered list of strings; fold the description into the level text.
      out[q.name] = {
        type: 'score', instructions: q.instructions,
        criteria: q.options.map((o) => (o.description ? `${o.value}: ${o.description}` : o.value)),
      };
    }
  }
  return { model: p.model, state, questions: out };
}

// ───────────────────────── response normalization ─────────────────────────

// Normalized answer: { name, kind: yesno|choice|score|refusal|missing,
//                      probability?, choice?, score?, confidence?, dist?: [{ label, p }] }  (dist in option order)

function normalizeAnswers(p, data, questions) {
  if (p.protocol === 'decisions') {
    const list = Array.isArray(data?.answers) ? data.answers : [];
    return questions.map((q, i) => {
      const a = list.find((x) => x?.name === q.name) ?? list[i];
      return normalizeOne(q, a, (a) => {
        const probs = Array.isArray(a.probabilities) ? a.probabilities : [];
        return q.options.map((o, idx) => {
          const hit = probs.find((x) => (q.type === 'score' ? x.value === idx || x.label === o.value : String(x.value) === o.value));
          return { label: o.value, p: num(hit?.probability) };
        });
      });
    });
  }

  const answers = data?.answers && typeof data.answers === 'object' ? data.answers : {};
  return questions.map((q) =>
    normalizeOne(q, answers[q.name], (a) => {
      const probs = a.probabilities ?? {};
      return q.options.map((o, idx) => {
        // choice: keyed by value; score: keyed by level index ("0", "1", …). Arrays are accepted too.
        let v = Array.isArray(probs)
          ? (probs.find((x) => x?.value === o.value || x?.value === idx || x?.label === o.value)?.probability ?? probs[idx])
          : (q.type === 'score' ? probs[idx] ?? probs[String(idx)] : probs[o.value]);
        return { label: o.value, p: num(v) };
      });
    }),
  );
}

function normalizeOne(q, a, readDist) {
  if (!a || typeof a !== 'object') return { name: q.name, kind: 'missing' };
  if (a.type === 'refusal') return { name: q.name, kind: 'refusal' };
  const confidence = num(a.confidence);

  if (q.type === 'yesno') {
    return { name: q.name, kind: 'yesno', probability: num(a.noul ?? a.probability ?? a.value), confidence };
  }
  const dist = readDist(a);
  if (q.type === 'choice') {
    return { name: q.name, kind: 'choice', choice: a.choice != null ? String(a.choice) : null, confidence, dist };
  }
  let score = num(a.score);
  if (score == null && dist.every((d) => d.p != null)) score = dist.reduce((s, d, i) => s + d.p * i, 0);
  return { name: q.name, kind: 'score', score, confidence, dist };
}

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    input: num(u.input_tokens ?? u.prompt_tokens),
    output: num(u.output_tokens ?? u.completion_tokens),
  };
}

// ───────────────────────── validation ─────────────────────────

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'Request body must be JSON';
  let { state, questions } = body;
  if (typeof state === 'string') {
    if (!state.trim()) return 'State is empty';
    if (state.length > MAX_STATE_CHARS) return `State is longer than ${MAX_STATE_CHARS} characters`;
  } else if (!state || typeof state !== 'object') return 'State must be text or a JSON object';
  if (!Array.isArray(questions) || questions.length === 0) return 'Add at least one question';
  if (questions.length > MAX_QUESTIONS) return `At most ${MAX_QUESTIONS} questions`;

  const names = new Set();
  for (const q of questions) {
    if (!q || typeof q !== 'object') return 'Each question must be an object';
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(q.name || '')) return `Question name "${q.name ?? ''}" must start with a letter and use letters, digits, or _`;
    if (names.has(q.name)) return `Question name "${q.name}" is used twice`;
    names.add(q.name);
    if (!QUESTION_TYPES.has(q.type)) return `Question "${q.name}" has an unknown type`;
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) return `Question "${q.name}" needs instructions`;
    if (q.type === 'yesno') { q.options = []; continue; }
    if (!Array.isArray(q.options) || q.options.length < 2) return `Question "${q.name}" needs at least two ${q.type === 'score' ? 'levels' : 'options'}`;
    const values = new Set();
    for (const o of q.options) {
      if (typeof o?.value !== 'string' || !o.value.trim()) return `Question "${q.name}" has an empty option`;
      if (values.has(o.value)) return `Question "${q.name}" lists "${o.value}" twice`;
      values.add(o.value);
      if (o.description != null && typeof o.description !== 'string') return `Question "${q.name}" has an invalid description`;
    }
  }
  return null;
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
          id: p.id, label: p.label, vendor: p.vendor, protocol: p.protocol, envPrefix: p.envPrefix,
          model: p.model, host: safeHost(p.endpoint) || null, endpoint: p.endpoint || null, price: p.price,
          ready: problems.length === 0, problems,
        };
      });
      const readyCount = providers.filter((p) => p.ready).length;
      return sendJson(res, 200, {
        ready: readyCount > 0,
        problems: readyCount ? [] : ['No provider is configured in decision/.env'],
        providers,
        hubUrl: HUB_URL,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/decide') {
      return await decide(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/warm') {
      return sendJson(res, 200, { providers: await warm() });
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, res);

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[http] error', err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
  }
});

async function decide(req, res) {
  const body = await readJson(req);
  const p = PROVIDERS.find((x) => x.id === body?.provider);
  if (!p) return sendJson(res, 400, { ok: false, error: 'Unknown provider' });

  const problems = providerProblems(p);
  if (problems.length) return sendJson(res, 200, { ok: false, provider: p.id, notConfigured: true, error: problems.join('; ') });

  const invalid = validateBody(body);
  if (invalid) return sendJson(res, 400, { ok: false, provider: p.id, error: invalid });

  const request = buildRequest(p, body.state, body.questions);
  if (DEBUG) console.log(`[${p.id}] → POST ${p.endpoint}\n${JSON.stringify(request)}`);

  const started = performance.now();
  let upstream;
  try {
    upstream = await send(p.endpoint, {
      method: 'POST',
      headers: { ...authHeaders(p), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const reason = err.code === 'TIMEOUT' ? err.message : err.code || err.message;
    console.warn(`[${p.id}] ${reason}`);
    return sendJson(res, 200, { ok: false, provider: p.id, latencyMs, error: `Could not reach ${safeHost(p.endpoint)}: ${reason}`, endpoint: p.endpoint, request });
  }
  const { status, text, timing } = upstream;
  const latencyMs = timing.totalMs;

  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (DEBUG) console.log(`[${p.id}] ← ${status} ${latencyMs}ms ${text.slice(0, 1000)}`);

  if (status < 200 || status >= 300) {
    const error = upstreamError(p, status, data, text);
    console.warn(`[${p.id}] ${status} ${error}`);
    return sendJson(res, 200, { ok: false, provider: p.id, status, latencyMs, timing, error, endpoint: p.endpoint, request, response: data ?? text.slice(0, 4000) });
  }

  const how = timing.reused ? 'warm' : `connect ${timing.connectMs}ms`;
  console.log(`[${p.id}] ${status} ${latencyMs}ms (${how}, response ${timing.responseMs}ms)`);
  sendJson(res, 200, {
    ok: true,
    provider: p.id,
    status,
    latencyMs,
    timing,
    model: data?.model ?? p.model,
    usage: normalizeUsage(data?.usage),
    answers: normalizeAnswers(p, data, body.questions),
    endpoint: p.endpoint,
    request,
    response: data ?? text.slice(0, 4000),
  });
}

// A keyless GET on the endpoint: the provider rejects it (401/404/405) without running a model,
// but the pooled connection stays open for the next run.
async function warm() {
  return Promise.all(PROVIDERS.filter((p) => !providerProblems(p).length).map(async (p) => {
    try {
      const { status, timing } = await send(p.endpoint, { headers: { Accept: 'application/json' } });
      return { id: p.id, ok: true, status, reused: timing.reused, ms: timing.totalMs, roundTripMs: timing.roundTripMs };
    } catch (err) {
      return { id: p.id, ok: false, error: err.code || err.message };
    }
  }));
}

// HTTPS request on the keep-alive pool, timed by phase:
//   connectMs   DNS + TCP + TLS, 0 when an open connection was reused
//   responseMs  from connected to the last byte: upload, one round trip, model time, download
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

function upstreamError(p, status, data, text) {
  const detail = Array.isArray(data?.detail) ? data.detail.map((d) => `${(d.loc || []).join('.')}: ${d.msg}`).join('; ') : '';
  const msg = data?.error?.message || data?.message || detail || (typeof data?.detail === 'string' ? data.detail : '') ||
    (typeof text === 'string' ? text.slice(0, 400) : '') || `HTTP ${status}`;
  const hint =
    status === 401 || status === 403
      ? ` Check ${p.envPrefix}_API_KEY (and ${p.envPrefix}_AUTH_HEADER) in .env.`
      : status === 404
        ? ` Check ${p.envPrefix}_BASE_URL. Calling ${p.endpoint}.`
        : status === 422 || (status === 400 && /model|deployment/i.test(msg))
          ? ` Check that "${p.model}" (${p.envPrefix}_MODEL) is the right model or deployment name.`
          : '';
  return hint ? `${msg.replace(/[.\s]*$/, '')}.${hint}` : msg;
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
  console.log('  Decision models demo');
  console.log(`  ▸ Open      http://localhost:${PORT}`);
  for (const p of PROVIDERS) {
    const problems = providerProblems(p);
    const where = problems.length ? `⚠ ${problems.join('; ')}` : `${p.endpoint}  model ${p.model}`;
    console.log(`  ▸ ${p.label.padEnd(21)} ${where}`);
  }
  console.log('');
});

// ───────────────────────── helpers ─────────────────────────

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
