// DemoBox hub
// - Serves the launcher page from ./public
// - GET  /api/demos           : every demo in ../demos.json with its port and live status
// - POST /api/demos/:id/start : runs `npm start` in the demo's folder (after `npm install` if needed)
// - POST /api/demos/:id/stop  : stops a demo this hub started
// Run `node hub/server.js --all` to start every demo on launch. Listens on localhost only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HUB_DIR);
const PUBLIC_DIR = path.join(HUB_DIR, 'public');
const REGISTRY = path.join(ROOT, 'demos.json');

const PORT = Number(process.env.HUB_PORT) || 8000;
const HOST = '127.0.0.1';
const LOG_LINES = 200;
const IS_WINDOWS = process.platform === 'win32';

const children = new Map(); // id → { proc, phase: installing|starting|running|exited, log: string[], exitCode }

// ───────────────────────── registry ─────────────────────────

function loadDemos() {
  const list = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  return list.map((d) => {
    const dir = path.join(ROOT, d.dir);
    return { ...d, absDir: dir, port: demoPort(dir, d.defaultPort) };
  });
}

// The demo's own .env decides its port; fall back to the registry default.
function demoPort(dir, fallback) {
  for (const name of ['.env', '.env.example']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const m = fs.readFileSync(file, 'utf8').match(/^\s*PORT\s*=\s*['"]?(\d+)/m);
    if (m) return Number(m[1]);
  }
  return fallback;
}

// Every demo serves GET /api/config with { ready, problems }. Anything else on the port is "something else".
async function probe(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/config`, { signal: AbortSignal.timeout(1200) });
    const data = await res.json().catch(() => null);
    if (data && typeof data.ready === 'boolean') return { running: true, ready: data.ready, problems: data.problems ?? [] };
    return { running: true, foreign: true };
  } catch (err) {
    if (err?.name === 'TimeoutError') return { running: true, foreign: true };
    return { running: false };
  }
}

async function demoStatus(d) {
  const child = children.get(d.id);
  const live = await probe(d.port);
  return {
    id: d.id,
    name: d.name,
    tagline: d.tagline,
    description: d.description,
    tags: d.tags ?? [],
    i18n: d.i18n ?? {},
    dir: d.dir,
    port: d.port,
    url: `http://localhost:${d.port}`,
    installed: !needsInstall(d.absDir),
    ...live,
    managed: Boolean(child && child.phase !== 'exited'),
    phase: child?.phase ?? null,
    exitCode: child?.exitCode ?? null,
    log: child ? child.log.slice(-40) : [],
  };
}

function needsInstall(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return Object.keys(pkg.dependencies ?? {}).length > 0 && !fs.existsSync(path.join(dir, 'node_modules'));
  } catch {
    return false;
  }
}

// ───────────────────────── process control ─────────────────────────

async function startDemo(d) {
  const existing = children.get(d.id);
  if (existing && existing.phase !== 'exited') return { ok: true };
  if ((await probe(d.port)).running) return { ok: false, error: `Port ${d.port} is already in use` };

  const entry = { proc: null, phase: 'starting', log: [], exitCode: null };
  children.set(d.id, entry);

  if (needsInstall(d.absDir)) {
    entry.phase = 'installing';
    const code = await run(d, entry, ['install']);
    if (code !== 0) {
      entry.phase = 'exited';
      entry.exitCode = code;
      return { ok: false, error: 'npm install failed' };
    }
    entry.phase = 'starting';
  }
  run(d, entry, ['start']).then((code) => {
    entry.phase = 'exited';
    entry.exitCode = code;
  });
  return { ok: true };
}

function run(d, entry, args) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.PORT; // each demo reads its own PORT from its .env
    env.DEMOBOX_HUB_URL = `http://localhost:${PORT}`; // for the demo's "← DemoBox" link
    const proc = spawn(IS_WINDOWS ? 'npm.cmd' : 'npm', args, {
      cwd: d.absDir,
      env,
      shell: IS_WINDOWS,
      detached: !IS_WINDOWS, // own process group, so stop() also ends the node process npm started
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    entry.proc = proc;
    const onData = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        entry.log.push(line);
        console.log(`[${d.id}] ${line}`);
      }
      if (entry.log.length > LOG_LINES) entry.log.splice(0, entry.log.length - LOG_LINES);
      if (args[0] === 'start' && entry.phase === 'starting' && /localhost:\d+/.test(buf.toString())) entry.phase = 'running';
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => { entry.log.push(String(err.message)); resolve(1); });
    proc.on('exit', (code) => resolve(code ?? 0));
  });
}

function stopDemo(id) {
  const entry = children.get(id);
  if (!entry?.proc || entry.phase === 'exited') return false;
  try {
    if (IS_WINDOWS) spawn('taskkill', ['/pid', String(entry.proc.pid), '/T', '/F']);
    else process.kill(-entry.proc.pid, 'SIGTERM');
  } catch { /* already gone */ }
  return true;
}

function stopAll() {
  for (const id of children.keys()) stopDemo(id);
}

// ───────────────────────── http ─────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/demos') {
      const demos = loadDemos();
      return sendJson(res, 200, { demos: await Promise.all(demos.map(demoStatus)) });
    }

    const action = url.pathname.match(/^\/api\/demos\/([\w-]+)\/(start|stop)$/);
    if (req.method === 'POST' && action) {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request refused' });
      const d = loadDemos().find((x) => x.id === action[1]);
      if (!d) return sendJson(res, 404, { error: 'Unknown demo' });
      if (action[2] === 'start') return sendJson(res, 200, await startDemo(d));
      return sendJson(res, 200, { ok: stopDemo(d.id) });
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, res);

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[http] error', err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
  }
});

// Only the hub page itself may start or stop processes.
function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://localhost:${PORT}` || origin === `http://${HOST}:${PORT}`;
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

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ───────────────────────── start ─────────────────────────

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. The hub may already be running at http://localhost:${PORT}`);
    console.error('  Stop the other process, or set HUB_PORT to use a different port.\n');
  } else {
    console.error('[server] error', err);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopAll(); process.exit(0); });
}
process.on('exit', stopAll);

server.listen(PORT, HOST, async () => {
  const demos = loadDemos();
  console.log('');
  console.log('  DemoBox hub');
  console.log(`  ▸ Open      http://localhost:${PORT}`);
  for (const d of demos) console.log(`  ▸ ${d.name.padEnd(18)} http://localhost:${d.port}   (${d.dir}/)`);
  console.log('');
  if (process.argv.includes('--all')) {
    for (const d of demos) {
      const r = await startDemo(d);
      if (!r.ok) console.log(`[${d.id}] not started: ${r.error}`);
    }
  }
});
