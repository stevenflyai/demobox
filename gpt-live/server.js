// GPT-Live demo server
// - Serves the browser app from ./public
// - POST /api/session : WebRTC. Relays the browser's SDP offer to {BASE_URL}/live/sessions and returns the answer.
// - WS   /live        : WebSocket relay. Opens {BASE_URL}/live/sessions with the key and pipes events both ways.
// The API key is read from .env and never leaves this process.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

loadEnvFile(path.join(ROOT, '.env'));

// ───────────────────────── config ─────────────────────────

const env = (key, fallback = '') => (process.env[key] ?? '').trim() || fallback;
const truthy = (v) => /^(1|true|yes|on)$/i.test(v);

const rawBaseUrl = env('BASE_URL') || env('AZURE_OPENAI_ENDPOINT');
const config = {
  rawBaseUrl,
  baseUrl: normalizeBaseUrl(rawBaseUrl),
  apiKey: env('API_KEY') || env('AZURE_OPENAI_API_KEY'),
  model: env('GPT_LIVE_MODEL', 'gpt-live-1'),
  voice: env('GPT_LIVE_VOICE', 'marin'),
  delegationModel: env('DELEGATION_MODEL'),
  reasoningEffort: env('DELEGATION_REASONING_EFFORT'),
  webSearch: truthy(env('ENABLE_WEB_SEARCH')),
  authHeader: env('AUTH_HEADER', 'auto').toLowerCase(),
  port: Number(env('PORT', '3000')) || 3000,
  debug: truthy(env('DEBUG')),
  hubUrl: process.env.DEMOBOX_HUB_URL || 'http://localhost:8000',
};

const DEFAULT_INSTRUCTIONS = [
  'You are a warm, concise voice assistant in a live product demo.',
  'Speak naturally in short sentences and reply in the language the user speaks.',
  'When you need facts, the current time, the weather, or anything you are unsure of, delegate to your backend instead of guessing.',
].join(' ');

const BACKEND_INSTRUCTIONS = [
  'You are the reasoning backend for a live voice assistant.',
  'Your answer is spoken aloud by the voice model, so reply in one to three short, plain sentences:',
  'no markdown, lists, tables, or URLs.',
  'Use the tools when they help. Reply in the language the user is speaking.',
].join(' ');

// Function tools run in the browser (see public/app.js → TOOL_HANDLERS). Keep names in sync.
const FUNCTION_TOOLS = [
  {
    type: 'function',
    name: 'get_current_time',
    description: 'Get the current local date and time in a timezone.',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA timezone name, for example Asia/Shanghai or America/Seattle.' },
      },
      required: ['timezone'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name in English, for example Shanghai or Singapore.' },
      },
      required: ['location'],
      additionalProperties: false,
    },
  },
];

function configProblems() {
  const problems = [];
  if (!config.rawBaseUrl) problems.push('BASE_URL is empty');
  else if (!config.baseUrl) problems.push(`BASE_URL is not a valid URL (${config.rawBaseUrl})`);
  if (!config.apiKey || /^<|your|xxx/i.test(config.apiKey)) problems.push('API_KEY is empty');
  return problems;
}

function isAzureHost(host) {
  return /\.(azure\.com|azure-api\.net|azure\.cn)$/i.test(host);
}

function authHeaders() {
  let mode = config.authHeader;
  if (mode !== 'api-key' && mode !== 'bearer') {
    mode = isAzureHost(safeHost(config.baseUrl)) ? 'api-key' : 'bearer';
  }
  return mode === 'api-key' ? { 'api-key': config.apiKey } : { Authorization: `Bearer ${config.apiKey}` };
}

function buildSession({ voice, instructions } = {}) {
  const session = {
    model: config.model,
    instructions: (typeof instructions === 'string' && instructions.trim().slice(0, 6000)) || DEFAULT_INSTRUCTIONS,
    audio: { output: { voice: /^[\w-]{1,40}$/.test(voice || '') ? voice : config.voice } },
  };

  if (config.delegationModel) {
    const responses = {
      model: config.delegationModel,
      instructions: BACKEND_INSTRUCTIONS,
      tools: [...(config.webSearch ? [{ type: 'web_search' }] : []), ...FUNCTION_TOOLS],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    };
    if (config.reasoningEffort) responses.reasoning = { effort: config.reasoningEffort };
    session.delegation = { type: 'responses', responses };
  } else {
    session.delegation = { type: 'client' };
  }
  return session;
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
      const problems = configProblems();
      return sendJson(res, 200, {
        ready: problems.length === 0,
        problems,
        host: safeHost(config.baseUrl) || null,
        baseUrl: config.baseUrl || null,
        model: config.model,
        voice: config.voice,
        delegation: config.delegationModel
          ? { type: 'responses', model: config.delegationModel, webSearch: config.webSearch, tools: FUNCTION_TOOLS.map((t) => t.name) }
          : { type: 'client' },
        defaultInstructions: DEFAULT_INSTRUCTIONS,
        hubUrl: config.hubUrl,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/session') {
      return await createWebRtcSession(req, res);
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, res);

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[http] error', err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
  }
});

async function createWebRtcSession(req, res) {
  const problems = configProblems();
  if (problems.length) return sendJson(res, 500, { error: problems.join('; ') });

  const body = await readJson(req);
  if (!body?.sdp) return sendJson(res, 400, { error: 'Missing SDP offer' });

  const payload = {
    session: buildSession(body), // no audio.format: WebRTC negotiates it through SDP
    transport: { type: 'webrtc', sdp: body.sdp },
  };

  const target = `${config.baseUrl}/live/sessions`;
  console.log(`[webrtc] POST ${target}  model=${config.model} voice=${payload.session.audio.output.voice} delegation=${payload.session.delegation.type}`);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return sendJson(res, 502, { error: `Could not reach ${safeHost(config.baseUrl)}: ${err?.cause?.code || err.message}` });
  }

  const text = await upstream.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }

  if (!upstream.ok) {
    const message = upstreamError(upstream.status, data, text);
    console.warn(`[webrtc] ${upstream.status} ${message}`);
    return sendJson(res, upstream.status, { error: message, status: upstream.status, detail: data ?? text.slice(0, 2000) });
  }

  const ctype = upstream.headers.get('content-type') || '';
  const answer = data?.transport?.sdp ?? data?.sdp ?? (ctype.includes('application/sdp') || text.startsWith('v=0') ? text : null);
  if (!answer) return sendJson(res, 502, { error: 'The service answered without an SDP answer', detail: data ?? text.slice(0, 2000) });

  console.log(`[webrtc] session created ${data?.session?.id ?? ''}`);
  sendJson(res, 200, { sdp: answer, session: data?.session ?? null });
}

function upstreamError(status, data, text) {
  const msg = data?.error?.message || data?.message || (typeof text === 'string' ? text.slice(0, 400) : '') || `HTTP ${status}`;
  const hint =
    status === 401 || status === 403
      ? ' Check API_KEY (and AUTH_HEADER) in .env.'
      : status === 404
        ? ` Check BASE_URL and that "${config.model}" is deployed in that resource (GPT_LIVE_MODEL).`
        : status === 400 && /valid deployment/i.test(msg)
          ? ` Check that "${config.model}" (GPT_LIVE_MODEL)${config.delegationModel ? ` and "${config.delegationModel}" (DELEGATION_MODEL)` : ''} are deployment names in that resource.`
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

// ───────────────────────── websocket relay ─────────────────────────

const wss = new WebSocketServer({ server, path: '/live' });

wss.on('connection', (browser) => {
  let upstream = null;
  const queue = [];
  const toBrowser = (obj) => browser.readyState === WebSocket.OPEN && browser.send(JSON.stringify(obj));

  browser.on('message', (data, isBinary) => {
    const text = isBinary ? null : data.toString();

    if (!upstream) {
      // First message from the browser carries the UI choices: { type: 'demo.start', voice, instructions }
      let start = {};
      try { start = JSON.parse(text); } catch { /* ignore */ }
      if (start.type !== 'demo.start') return toBrowser({ type: 'demo.error', message: 'Expected demo.start first' });
      openUpstream(start);
      return;
    }

    if (upstream.readyState === WebSocket.OPEN) upstream.send(isBinary ? data : text);
    else if (upstream.readyState === WebSocket.CONNECTING) queue.push(isBinary ? data : text);
  });

  let sessionClosed = false;

  browser.on('close', () => {
    if (!upstream) return;
    if (upstream.readyState === WebSocket.OPEN && !sessionClosed) {
      try { upstream.send(JSON.stringify({ type: 'session.close' })); } catch { /* ignore */ }
      setTimeout(() => upstream.terminate(), 3000);
    } else if (upstream.readyState === WebSocket.OPEN) {
      upstream.close(1000);
    } else {
      upstream.terminate();
    }
  });

  function openUpstream(start) {
    const problems = configProblems();
    if (problems.length) {
      toBrowser({ type: 'demo.error', message: problems.join('; ') });
      return browser.close(1011, 'Server not configured');
    }

    const target = `${config.baseUrl.replace(/^http/i, 'ws')}/live/sessions`;
    const session = buildSession(start);
    console.log(`[ws] connecting ${target}  model=${config.model} voice=${session.audio.output.voice} delegation=${session.delegation.type}`);

    upstream = new WebSocket(target, { headers: authHeaders(), perMessageDeflate: false });
    let handshakeFailed = false;

    upstream.on('open', () => {
      upstream.send(JSON.stringify({ type: 'session.start', event_id: 'evt_session_start', session }));
      for (const m of queue.splice(0)) upstream.send(m);
    });

    upstream.on('message', (data, isBinary) => {
      if (browser.readyState !== WebSocket.OPEN) return;
      const text = isBinary ? null : data.toString();
      if (config.debug && text && !text.includes('"session.output_audio.delta"')) console.log('[ws] ←', text.slice(0, 500));
      else if (text && text.includes('"session.started"')) console.log('[ws] session started');
      if (text && text.includes('"session.closed"')) sessionClosed = true;
      browser.send(isBinary ? data : text);
    });

    upstream.on('unexpected-response', (_req, res) => {
      handshakeFailed = true;
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(body); } catch { /* not JSON */ }
        const message = upstreamError(res.statusCode, data, body);
        console.warn(`[ws] handshake ${res.statusCode} ${message}`);
        toBrowser({ type: 'demo.error', status: res.statusCode, message });
        browser.close(1011, 'Upstream refused the connection');
      });
    });

    upstream.on('error', (err) => {
      if (handshakeFailed) return; // already reported with the HTTP status
      console.warn('[ws] upstream error', err.message);
      toBrowser({ type: 'demo.error', message: `Connection to ${safeHost(config.baseUrl)} failed: ${err.code || err.message}` });
    });

    upstream.on('close', (code, reason) => {
      console.log(`[ws] upstream closed ${code} ${reason}`);
      toBrowser({ type: 'demo.upstream_closed', code, reason: reason.toString() });
      if (browser.readyState === WebSocket.OPEN) browser.close(1000, 'Upstream closed');
    });
  }
});

// ───────────────────────── start ─────────────────────────

// The WebSocket server re-emits the HTTP server's errors; handle both so a busy port prints one clear line.
wss.on('error', () => {});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use. The demo may already be running at http://localhost:${config.port}`);
    console.error('  Stop the other process, or set PORT in .env to use a different port.\n');
  } else {
    console.error('[server] error', err);
  }
  process.exit(1);
});

server.listen(config.port, () => {
  const problems = configProblems();
  console.log('');
  console.log('  GPT-Live demo');
  console.log(`  ▸ Open      http://localhost:${config.port}`);
  console.log(`  ▸ Endpoint  ${config.baseUrl || '(not set)'}`);
  console.log(`  ▸ Key       ${config.apiKey ? `set (${authHeaders()['api-key'] ? 'api-key header' : 'Bearer'})` : '(not set)'}`);
  console.log(`  ▸ Model     ${config.model}   voice ${config.voice}`);
  console.log(`  ▸ Backend   ${config.delegationModel ? `${config.delegationModel} (responses delegation${config.webSearch ? ', web_search' : ''})` : 'none (client delegation)'}`);
  for (const p of problems) console.log(`  ⚠ ${p} in ${path.join(ROOT, '.env')}`);
  console.log('');
});

// ───────────────────────── helpers ─────────────────────────

function normalizeBaseUrl(raw) {
  if (!raw) return '';
  let u;
  try { u = new URL(raw.trim()); } catch { return ''; }
  let p = u.pathname.replace(/\/+$/, '');
  if (/\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/i.test(u.hostname)) {
    if (!/\/openai\/v1$/i.test(p)) p = '/openai/v1'; // also drops /api/projects/... from Foundry project URLs
  } else if (u.hostname === 'api.openai.com' && !p) {
    p = '/v1';
  }
  return `${u.protocol}//${u.host}${p}`;
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
