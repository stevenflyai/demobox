// Image models demo server
// - Serves the browser app from ./public
// - GET  /api/config     : which models (and the optional judge) are configured (never returns keys)
// - POST /api/generate   : runs one model on { provider, prompt, aspect, size, quality, webGrounding } and returns
//                          the image id, its measured latency, token usage and cost, and the raw request/response
// - GET  /api/images/:id : the generated image (kept in memory for the last MAX_IMAGES runs)
// - POST /api/judge      : asks a vision model whether an image meets each checklist item, and rates its quality
// Keys are read from .env and never leave this process. No npm dependencies.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

loadEnvFile(path.join(ROOT, '.env'));

// ───────────────────────── config ─────────────────────────

const env = (key, fallback = '') => (process.env[key] ?? '').trim() || fallback;

// Two wire protocols:
//   openai : { model, prompt, size: "WxH", quality, n }   → <base>/openai/v1/images/generations
//   mai    : { model, prompt, width, height, web_grounding } → <resource>.services.ai.azure.com/mai/v1/images/generations
// Both return { data: [{ b64_json }] }.
const PROVIDERS = [
  {
    id: 'flare',
    label: 'GPT-Image-2.5 Flare',
    vendor: 'Azure OpenAI',
    protocol: 'openai',
    group: 'GPT_IMAGE',
    envPrefix: 'GPT_IMAGE_FLARE',
    defaultModel: 'gpt-image-2.5-flare',
    defaultPrice: { input: 5, output: 30 },
  },
  {
    id: 'sunburst',
    label: 'GPT-Image-2.5 Sunburst',
    vendor: 'Azure OpenAI',
    protocol: 'openai',
    group: 'GPT_IMAGE',
    envPrefix: 'GPT_IMAGE_SUNBURST',
    defaultModel: 'gpt-image-2.5-sunburst',
    defaultPrice: { input: 5, output: 30 },
  },
  {
    id: 'mai',
    label: 'MAI-Image-2.6',
    vendor: 'Microsoft AI',
    protocol: 'mai',
    group: 'MAI',
    envPrefix: 'MAI_IMAGE',
    defaultModel: 'MAI-Image-2.6',
    defaultPrice: { input: 5, output: 38 },
  },
  {
    id: 'maiflash',
    label: 'MAI-Image-2.6-Flash',
    vendor: 'Microsoft AI',
    protocol: 'mai',
    group: 'MAI',
    envPrefix: 'MAI_IMAGE_FLASH',
    defaultModel: 'MAI-Image-2.6-Flash',
    defaultPrice: { input: 1.75, output: 19 },
  },
].map((p) => ({ ...p, ...connection(p.envPrefix, p.group, p.protocol, p.defaultModel), price: readPrice(p) }));

// The judge is an Azure OpenAI deployment, so it shares the GPT-Image resource unless JUDGE_* says otherwise.
const JUDGE = connection('JUDGE', 'GPT_IMAGE', 'responses', '');
JUDGE.envPrefix = 'JUDGE';
JUDGE.effort = env('JUDGE_REASONING_EFFORT');

// Each model reads its group's GPT_IMAGE_* or MAI_* connection; its own *_BASE_URL / *_API_KEY / *_AUTH_HEADER win.
// The *Var fields name the variable actually in use, so error messages point at the right line in .env.
function connection(prefix, group, protocol, defaultModel) {
  const pick = (suffix) => (env(`${prefix}_${suffix}`) ? `${prefix}_${suffix}` : `${group}_${suffix}`);
  const urlVar = pick('BASE_URL');
  const keyVar = pick('API_KEY');
  const authVar = pick('AUTH_HEADER');
  const rawBaseUrl = env(urlVar);
  return {
    protocol,
    urlVar,
    keyVar,
    authVar,
    rawBaseUrl,
    endpoint: resolveEndpoint(protocol, rawBaseUrl),
    apiKey: env(keyVar),
    model: env(`${prefix}_MODEL`, defaultModel),
    authHeader: env(authVar, 'auto').toLowerCase(),
  };
}

// List price in USD per 1M tokens (text input, image output) for the cost row. Defaults are published list
// prices as of October 2026; set *_PRICE_INPUT_PER_1M / *_PRICE_OUTPUT_PER_1M to match your contract.
function readPrice(p) {
  const input = Number(env(`${p.envPrefix}_PRICE_INPUT_PER_1M`, String(p.defaultPrice.input)));
  const output = Number(env(`${p.envPrefix}_PRICE_OUTPUT_PER_1M`, String(p.defaultPrice.output)));
  return Number.isFinite(input) && Number.isFinite(output) ? { input, output } : null;
}

const PORT = Number(env('PORT', '3002')) || 3002;
const TIMEOUT_MS = (Number(env('REQUEST_TIMEOUT_SECONDS', '180')) || 180) * 1000;
const DEBUG = /^(1|true|yes|on)$/i.test(env('DEBUG'));
const HUB_URL = process.env.DEMOBOX_HUB_URL || 'http://localhost:8000';

const AGENTS = {
  'https:': new https.Agent({ keepAlive: true, timeout: 60_000 }),
  'http:': new http.Agent({ keepAlive: true, timeout: 60_000 }),
};

// Every aspect ratio maps to one pixel size that all four models accept, so they render the same number of
// pixels: GPT-Image needs edges in multiples of 16; MAI-Image-2.6 needs both edges ≥ 768 and at most
// 2,359,296 pixels. "large" sits right at the MAI limit.
const SIZES = {
  standard: {
    '1:1': [1024, 1024], '3:2': [1536, 1024], '2:3': [1024, 1536], '4:3': [1280, 960],
    '3:4': [960, 1280], '16:9': [1536, 864], '9:16': [864, 1536],
  },
  large: {
    '1:1': [1536, 1536], '3:2': [1872, 1248], '2:3': [1248, 1872], '4:3': [1776, 1328],
    '3:4': [1328, 1776], '16:9': [2048, 1152], '9:16': [1152, 2048],
  },
};
const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']; // GPT-Image only; MAI has no quality setting
const MAX_PROMPT_CHARS = 32_000;
const MAX_CHECKS = 20;

// Generated images, newest last. Each is a few MB, so only the most recent ones are kept.
const MAX_IMAGES = 48;
const images = new Map(); // id → { buf, mime, provider }

function problemsOf(c) {
  const problems = [];
  if (!c.rawBaseUrl) problems.push(`${c.urlVar} is empty`);
  else if (!c.endpoint) problems.push(`${c.urlVar} is not a valid URL (${c.rawBaseUrl})`);
  if (!c.apiKey || /^<|your|xxx/i.test(c.apiKey)) problems.push(`${c.keyVar} is empty`);
  if (!c.model) problems.push(`${c.envPrefix}_MODEL is empty`);
  return problems;
}

function isAzureHost(host) {
  return /\.(azure\.com|azure-api\.net|azure\.cn)$/i.test(host);
}

function authHeaders(c) {
  let mode = c.authHeader;
  if (mode !== 'api-key' && mode !== 'bearer') {
    mode = isAzureHost(safeHost(c.endpoint)) ? 'api-key' : 'bearer';
  }
  return mode === 'api-key' ? { 'api-key': c.apiKey } : { Authorization: `Bearer ${c.apiKey}` };
}

// Accept whatever the portal shows (resource endpoint, project URL, or the full path) and return the full POST URL.
function resolveEndpoint(protocol, raw) {
  if (!raw) return '';
  let u;
  try { u = new URL(raw.trim()); } catch { return ''; }
  let host = u.host;
  let pathname = u.pathname.replace(/\/+$/, '');
  const azure = isAzureHost(u.hostname);
  const tail = protocol === 'responses' ? '/responses' : '/images/generations';
  // A full path is used as-is, but only for its own API: a pasted /openai/... URL never reaches a MAI model, and vice versa.
  const isMaiPath = /\/mai\//i.test(pathname);
  const asIs = pathname.toLowerCase().endsWith(tail) && (protocol === 'mai') === isMaiPath;

  if (!asIs) {
    if (protocol === 'mai') {
      // MAI models are served only on the services.ai.azure.com name of the same resource.
      if (azure) host = host.replace(/\.(openai|cognitiveservices)\.azure\.com$/i, '.services.ai.azure.com');
      pathname = azure ? `/mai/v1${tail}` : `${pathname.replace(/\/(mai\/)?v1$/i, '')}/mai/v1${tail}`;
    } else if (azure) {
      pathname = `/openai/v1${tail}`; // also drops /api/projects/... pasted from the portal
    } else {
      pathname = /\/v1$/i.test(pathname) ? `${pathname}${tail}` : `${pathname}/v1${tail}`;
    }
  }
  return `${u.protocol}//${host}${pathname}${u.search}`;
}

// ───────────────────────── generation ─────────────────────────

function buildRequest(p, { prompt, aspect, size, quality, webGrounding }) {
  const [width, height] = SIZES[size][aspect];
  if (p.protocol === 'openai') return { model: p.model, prompt, size: `${width}x${height}`, quality, n: 1 };
  const body = { model: p.model, prompt, width, height };
  if (webGrounding) body.web_grounding = true;
  return body;
}

function validateGenerate(body) {
  if (!body || typeof body !== 'object') return 'Request body must be JSON';
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return 'The prompt is empty';
  if (body.prompt.length > MAX_PROMPT_CHARS) return `The prompt is longer than ${MAX_PROMPT_CHARS} characters`;
  if (!SIZES[body.size]) return `Unknown size "${body.size}"`;
  if (!SIZES[body.size][body.aspect]) return `Unknown aspect ratio "${body.aspect}"`;
  if (!QUALITIES.includes(body.quality)) return `Unknown quality "${body.quality}"`;
  body.prompt = body.prompt.trim();
  body.webGrounding = body.webGrounding === true;
  return null;
}

async function generate(req, res) {
  const body = await readJson(req);
  const p = PROVIDERS.find((x) => x.id === body?.provider);
  if (!p) return sendJson(res, 400, { ok: false, error: 'Unknown model' });

  const problems = problemsOf(p);
  if (problems.length) return sendJson(res, 200, { ok: false, provider: p.id, notConfigured: true, error: problems.join('; ') });

  const invalid = validateGenerate(body);
  if (invalid) return sendJson(res, 400, { ok: false, provider: p.id, error: invalid });

  const request = buildRequest(p, body);
  if (DEBUG) console.log(`[${p.id}] → POST ${p.endpoint}\n${JSON.stringify(request)}`);

  let upstream;
  try {
    upstream = await send(p.endpoint, {
      method: 'POST',
      headers: { ...authHeaders(p), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (err) {
    const reason = err.code === 'TIMEOUT' ? err.message : err.code || err.message;
    console.warn(`[${p.id}] ${reason}`);
    return sendJson(res, 200, { ok: false, provider: p.id, error: `Could not reach ${safeHost(p.endpoint)}: ${reason}`, endpoint: p.endpoint, request });
  }
  const { status, text, timing } = upstream;
  const latencyMs = timing.totalMs;

  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  const response = data ? redactImages(data) : text.slice(0, 4000);
  if (DEBUG) console.log(`[${p.id}] ← ${status} ${latencyMs}ms ${JSON.stringify(response).slice(0, 1000)}`);

  if (status < 200 || status >= 300) {
    const error = upstreamError(p, status, data, text);
    console.warn(`[${p.id}] ${status} ${error}`);
    return sendJson(res, 200, { ok: false, provider: p.id, status, latencyMs, timing, error, endpoint: p.endpoint, request, response });
  }

  const first = Array.isArray(data?.data) ? data.data.find((d) => d?.b64_json) : null;
  if (!first) {
    return sendJson(res, 200, { ok: false, provider: p.id, status, latencyMs, timing, error: 'The response has no image (data[].b64_json is missing)', endpoint: p.endpoint, request, response });
  }

  const buf = Buffer.from(first.b64_json, 'base64');
  const mime = sniffMime(buf);
  const dims = imageSize(buf);
  const id = randomUUID();
  images.set(id, { buf, mime, provider: p.id });
  while (images.size > MAX_IMAGES) images.delete(images.keys().next().value);

  const usage = normalizeUsage(data?.usage);
  const cost = usage && p.price ? ((usage.input ?? 0) * p.price.input + (usage.output ?? 0) * p.price.output) / 1e6 : null;

  console.log(`[${p.id}] ${status} ${latencyMs}ms ${dims ? `${dims.width}x${dims.height}` : ''} ${formatBytes(buf.length)}`);
  sendJson(res, 200, {
    ok: true,
    provider: p.id,
    status,
    latencyMs,
    timing,
    model: data?.model ?? p.model,
    image: { id, url: `/api/images/${id}`, mime, bytes: buf.length, ...dims },
    revisedPrompt: typeof first.revised_prompt === 'string' ? first.revised_prompt : null,
    usage,
    cost,
    endpoint: p.endpoint,
    request,
    response,
  });
}

// OpenAI: { input_tokens, output_tokens }. MAI: { num_input_text_tokens, num_input_image_tokens, num_output_tokens }.
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input = num(u.input_tokens ?? u.prompt_tokens ?? u.num_input_text_tokens);
  const output = num(u.output_tokens ?? u.completion_tokens ?? u.num_output_tokens);
  return input == null && output == null ? null : { input, output };
}

// Base64 images make the wire view unreadable; replace each with its size.
function redactImages(value) {
  if (Array.isArray(value)) return value.map(redactImages);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    k === 'b64_json' && typeof v === 'string'
      ? [k, `<base64 image, ${formatBytes(v.length * 0.75)}>`]
      : [k, redactImages(v)]));
}

// ───────────────────────── judge ─────────────────────────

const JUDGE_INSTRUCTIONS = [
  'You grade an AI-generated image. You are given the prompt the image model received, a numbered list of requirements, and the image.',
  'For each requirement, decide whether the image clearly satisfies it. Be strict: if it is only partly met, ambiguous, or you cannot tell, it fails. For text in the image, the spelling must match exactly.',
  'Give a one-sentence reason per requirement that names what you see.',
  'Then rate the overall image quality from 1 to 10, ignoring the requirements: realism or stylistic coherence, anatomy and hands, legibility of any text, lighting, composition, and visible artifacts. 10 is flawless professional work.',
].join('\n');

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checks', 'quality', 'quality_notes'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'pass', 'reason'],
        properties: { index: { type: 'integer' }, pass: { type: 'boolean' }, reason: { type: 'string' } },
      },
    },
    quality: { type: 'integer' },
    quality_notes: { type: 'string' },
  },
};

async function judge(req, res) {
  const problems = problemsOf(JUDGE);
  if (problems.length) return sendJson(res, 200, { ok: false, notConfigured: true, error: problems.join('; ') });

  const body = await readJson(req);
  const img = images.get(body?.imageId);
  if (!img) return sendJson(res, 200, { ok: false, error: 'This image is no longer on the server. Generate it again.' });
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return sendJson(res, 400, { ok: false, error: 'The prompt is empty' });
  const checks = Array.isArray(body.checks) ? body.checks.filter((c) => typeof c === 'string' && c.trim()).slice(0, MAX_CHECKS) : [];

  const list = checks.length ? checks.map((c, i) => `${i + 1}. ${c.trim()}`).join('\n') : '(none: return an empty checks array)';
  const request = {
    model: JUDGE.model,
    instructions: JUDGE_INSTRUCTIONS,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: `Prompt the image model received:\n"""\n${body.prompt.trim()}\n"""\n\nRequirements:\n${list}` },
        { type: 'input_image', image_url: `data:${img.mime};base64,${img.buf.toString('base64')}`, detail: 'high' },
      ],
    }],
    text: { format: { type: 'json_schema', name: 'image_grade', strict: true, schema: JUDGE_SCHEMA } },
  };
  if (JUDGE.effort) request.reasoning = { effort: JUDGE.effort };

  let upstream;
  try {
    upstream = await send(JUDGE.endpoint, {
      method: 'POST',
      headers: { ...authHeaders(JUDGE), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (err) {
    const reason = err.code === 'TIMEOUT' ? err.message : err.code || err.message;
    return sendJson(res, 200, { ok: false, error: `Could not reach ${safeHost(JUDGE.endpoint)}: ${reason}` });
  }
  const { status, text, timing } = upstream;
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (DEBUG) console.log(`[judge] ← ${status} ${timing.totalMs}ms ${text.slice(0, 1000)}`);
  if (status < 200 || status >= 300) {
    const error = upstreamError(JUDGE, status, data, text);
    console.warn(`[judge] ${status} ${error}`);
    return sendJson(res, 200, { ok: false, status, error });
  }

  let grade = null;
  try { grade = JSON.parse(outputText(data)); } catch { /* handled below */ }
  if (!grade || !Array.isArray(grade.checks)) return sendJson(res, 200, { ok: false, error: 'The judge did not return a grade' });

  console.log(`[judge] ${img.provider} ${timing.totalMs}ms quality ${grade.quality}`);
  sendJson(res, 200, {
    ok: true,
    model: data?.model ?? JUDGE.model,
    latencyMs: timing.totalMs,
    // The judge numbers requirements from 1; map back by position when the index is off.
    checks: checks.map((_, i) => {
      const c = grade.checks.find((x) => x?.index === i + 1) ?? grade.checks[i];
      return c ? { pass: c.pass === true, reason: String(c.reason ?? '') } : null;
    }),
    quality: Math.min(10, Math.max(1, Math.round(num(grade.quality) ?? 1))),
    notes: String(grade.quality_notes ?? ''),
  });
}

function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  for (const item of data?.output ?? []) {
    for (const c of item?.content ?? []) if (c?.type === 'output_text' && typeof c.text === 'string') return c.text;
  }
  return '';
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
        const problems = problemsOf(p);
        return {
          id: p.id, label: p.label, vendor: p.vendor, protocol: p.protocol, envPrefix: p.envPrefix,
          model: p.model, host: safeHost(p.endpoint) || null, endpoint: p.endpoint || null, price: p.price,
          ready: problems.length === 0, problems,
        };
      });
      const readyCount = providers.filter((p) => p.ready).length;
      const judgeProblems = problemsOf(JUDGE);
      return sendJson(res, 200, {
        ready: readyCount > 0,
        problems: readyCount ? [] : ['No model is configured in images/.env'],
        providers,
        judge: { ready: judgeProblems.length === 0, model: JUDGE.model || null, host: safeHost(JUDGE.endpoint) || null, problems: judgeProblems },
        sizes: SIZES,
        qualities: QUALITIES,
        hubUrl: HUB_URL,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/generate') return await generate(req, res);
    if (req.method === 'POST' && url.pathname === '/api/judge') return await judge(req, res);

    const imageMatch = url.pathname.match(/^\/api\/images\/([\w-]+)$/);
    if ((req.method === 'GET' || req.method === 'HEAD') && imageMatch) {
      const img = images.get(imageMatch[1]);
      if (!img) return sendJson(res, 404, { error: 'Image not found. Only the most recent images are kept.' });
      res.writeHead(200, { 'Content-Type': img.mime, 'Content-Length': img.buf.length, 'Cache-Control': 'private, max-age=86400, immutable' });
      return res.end(req.method === 'HEAD' ? undefined : img.buf);
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, res);

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[http] error', err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
  }
});

// HTTPS request on the keep-alive pool, timed by phase:
//   connectMs   DNS + TCP + TLS, 0 when an open connection was reused
//   responseMs  from connected to the last byte: upload, model time, download of the image
function send(url, { method = 'GET', headers = {}, body } = {}, retry = true) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const t0 = performance.now();
    let tcpAt, tlsAt;
    const req = lib.request(u, {
      method,
      headers: body ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers,
      agent: AGENTS[u.protocol],
      timeout: TIMEOUT_MS,
    });
    req.on('socket', (socket) => {
      if (req.reusedSocket) return;
      socket.once('connect', () => { tcpAt = performance.now(); });
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

function upstreamError(c, status, data, text) {
  const err = data?.error && typeof data.error === 'object' ? data.error : null;
  const msg = err?.message || data?.message || (typeof data?.error === 'string' ? data.error : '') ||
    (typeof data?.detail === 'string' ? data.detail : '') || (typeof text === 'string' ? text.slice(0, 400) : '') || `HTTP ${status}`;
  const code = `${err?.code ?? ''} ${err?.type ?? ''} ${err?.innererror?.code ?? ''}`;
  if (/content_policy|content_filter|moderation|responsible ?ai|safety/i.test(`${code} ${msg}`)) {
    return `Blocked by the content filter: ${msg.replace(/[.\s]*$/, '')}. Rephrase the prompt.`;
  }
  const hint =
    status === 401 || status === 403
      ? ` Check ${c.keyVar} (and ${c.authVar}) in .env.`
      : status === 404
        ? ` Check ${c.urlVar}, and that "${c.model}" (${c.envPrefix}_MODEL) is a deployment in that resource. Calling ${c.endpoint}.`
        : status === 429
          ? ' Rate limit reached. Wait a minute, use fewer runs, or raise the deployment quota.'
          : (status === 400 || status === 422) && /model|deployment/i.test(msg)
            ? ` Check that "${c.model}" (${c.envPrefix}_MODEL) is the right deployment name.`
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
  console.log('  Image models demo');
  console.log(`  ▸ Open      http://localhost:${PORT}`);
  for (const c of [...PROVIDERS, { ...JUDGE, label: 'Judge' }]) {
    const problems = problemsOf(c);
    const where = problems.length ? `⚠ ${problems.join('; ')}` : `${c.endpoint}  model ${c.model}`;
    console.log(`  ▸ ${c.label.padEnd(23)} ${where}`);
  }
  console.log('');
});

// ───────────────────────── helpers ─────────────────────────

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function sniffMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

// Width and height from the PNG header or the first JPEG frame, so the page shows what the model actually returned.
function imageSize(buf) {
  if (buf[0] === 0x89 && buf.length > 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

function formatBytes(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;
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
