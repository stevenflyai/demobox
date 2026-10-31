// GPT-Live browser client.
// WebRTC: mic and voice travel as media tracks; events go over the "oai-events" data channel.
// WebSocket: this page streams PCM16 24 kHz through the local server relay (/live) and plays the deltas back.

import { t, lang, setLang, applyStatic, LANGS } from './i18n.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), statusText: $('statusText'), lang: $('lang'),
  cfgHost: $('cfgHost'), cfgModel: $('cfgModel'), cfgBackend: $('cfgBackend'),
  laneVoice: $('laneVoice'), laneBackend: $('laneBackend'),
  canvas: $('timeline'), stageHint: $('stageHint'),
  startBtn: $('startBtn'), muteBtn: $('muteBtn'), clock: $('clock'), usage: $('usage'), notice: $('notice'),
  transcript: $('transcript'), transcriptEmpty: $('transcriptEmpty'),
  voice: $('voice'), transport: $('transport'), instructions: $('instructions'), resetInstructions: $('resetInstructions'),
  activity: $('activity'), activityEmpty: $('activityEmpty'),
  injectForm: $('inject'), injectText: $('injectText'), injectKind: $('injectKind'), injectBtn: $('injectBtn'), injectStatus: $('injectStatus'),
  log: $('log'), logCount: $('logCount'), audio: $('remoteAudio'),
};

// marin is the documented default; the rest are the GPT-Live launch voices.
const VOICES = ['marin', 'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam', 'meridian', 'bossa', 'tempo', 'beacon', 'delta', 'cinder'];
const SAMPLE_RATE = 24000;
const BIN = 0.05; // seconds per timeline bar

let CFG = null;

const S = {
  phase: 'idle', // idle | connecting | live | closing | closed
  transport: 'webrtc',
  pc: null, dc: null, ws: null,
  ctx: null, mic: null, micAnalyser: null, outAnalyser: null, worklet: null, player: null,
  t0: 0, tEnd: 0, muted: false, sessionId: null,
  closeTimer: null, startTimer: null,
  statusKey: 'status.checking',
};

// ───────────────────────── setup ─────────────────────────

init();

async function init() {
  applyStatic();
  fillLangs();
  renderConfig();
  setStatus('status.checking');
  restoreSettings();
  wireUi();
  requestAnimationFrame(frame);

  try {
    const res = await fetch('/api/config');
    CFG = await res.json();
  } catch {
    setPhase('idle', 'status.unreachable');
    els.status.dataset.state = 'error';
    return showNotice(t('notice.unreachable'));
  }

  if (CFG.hubUrl) document.getElementById('home').href = CFG.hubUrl;
  renderConfig();

  if (!VOICES.includes(CFG.voice)) VOICES.unshift(CFG.voice);
  fillVoices();
  if (!els.instructions.value.trim()) els.instructions.value = CFG.defaultInstructions;
  els.laneVoice.textContent = els.voice.value;

  if (!CFG.ready) {
    els.status.dataset.state = 'error';
    setStatus('status.needsSetup');
    showNotice(t('notice.fixEnv', { problems: CFG.problems.join('; ') }));
    return;
  }
  setPhase('idle');
}

function renderConfig() {
  if (!CFG) {
    els.laneVoice.textContent = t('lane.voice');
    els.laneBackend.textContent = t('lane.delegated');
    return;
  }
  const responses = CFG.delegation.type === 'responses';
  els.cfgHost.textContent = CFG.host || t('cfg.notSet');
  els.cfgHost.title = CFG.baseUrl || '';
  els.cfgModel.textContent = CFG.model;
  els.cfgBackend.textContent = responses ? CFG.delegation.model : t('cfg.none');
  els.laneBackend.textContent = responses ? CFG.delegation.model : t('cfg.notConfigured');
}

function fillLangs() {
  for (const [code, name] of Object.entries(LANGS)) els.lang.append(new Option(name, code));
  els.lang.value = lang;
}

function switchLang(next) {
  setLang(next);
  renderConfig();
  if (CFG) {
    const v = els.voice.value;
    fillVoices();
    els.voice.value = v;
  }
  renderControls();
  els.statusText.textContent = t(S.statusKey);
  renderLog();
}

function setStatus(key) {
  S.statusKey = key;
  els.statusText.textContent = t(key);
}

function fillVoices() {
  const saved = loadSettings().voice;
  els.voice.innerHTML = '';
  for (const v of VOICES) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v[0].toUpperCase() + v.slice(1) + (v === CFG?.voice ? ` ${t('setup.voiceDefault')}` : '');
    els.voice.append(o);
  }
  els.voice.value = VOICES.includes(saved) ? saved : CFG?.voice || 'marin';
}

function wireUi() {
  els.lang.addEventListener('change', () => switchLang(els.lang.value));
  els.startBtn.addEventListener('click', () => (S.phase === 'live' || S.phase === 'connecting' ? stop() : start()));
  els.muteBtn.addEventListener('click', toggleMute);
  els.resetInstructions.addEventListener('click', () => {
    if (CFG) els.instructions.value = CFG.defaultInstructions;
    saveSettings();
  });
  for (const el of [els.voice, els.transport, els.instructions]) el.addEventListener('change', saveSettings);
  els.voice.addEventListener('change', () => (els.laneVoice.textContent = els.voice.value));
  els.injectForm.addEventListener('submit', (e) => { e.preventDefault(); injectContext(); });
  els.injectText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); injectContext(); }
  });
  document.querySelector('details.log').addEventListener('toggle', renderLog);
  window.addEventListener('beforeunload', () => { if (S.phase === 'live') send({ type: 'session.close' }); });
}

function loadSettings() {
  try { return JSON.parse(localStorage.getItem('gptlive.settings') || '{}'); } catch { return {}; }
}
function saveSettings() {
  try {
    localStorage.setItem('gptlive.settings', JSON.stringify({
      voice: els.voice.value, transport: els.transport.value, instructions: els.instructions.value,
    }));
  } catch { /* storage unavailable */ }
}
function restoreSettings() {
  const s = loadSettings();
  if (s.transport) els.transport.value = s.transport;
  if (s.instructions) els.instructions.value = s.instructions;
}

// ───────────────────────── phases ─────────────────────────

function setPhase(phase, labelKey) {
  S.phase = phase;
  els.status.dataset.state = phase === 'idle' || phase === 'closed' ? 'ready' : phase;
  setStatus(labelKey || `status.${phase}`);

  const busy = phase === 'live' || phase === 'connecting' || phase === 'closing';
  els.startBtn.disabled = phase === 'closing' || !CFG?.ready;
  renderControls();
  els.startBtn.classList.toggle('end', busy);
  els.muteBtn.disabled = phase !== 'live';
  for (const el of [els.voice, els.transport, els.instructions]) el.disabled = busy;
  els.resetInstructions.disabled = busy;
  const canInject = phase === 'live';
  for (const el of [els.injectText, els.injectKind, els.injectBtn]) el.disabled = !canInject;
  els.stageHint.hidden = phase !== 'idle';
}

function renderControls() {
  const phase = S.phase;
  const busy = phase === 'live' || phase === 'connecting' || phase === 'closing';
  els.startBtn.textContent = t(busy ? (phase === 'connecting' ? 'btn.cancel' : 'btn.end') : phase === 'closed' ? 'btn.startAgain' : 'btn.start');
  els.muteBtn.textContent = t(S.muted ? 'btn.unmute' : 'btn.mute');
}

// ───────────────────────── start / stop ─────────────────────────

async function start() {
  if (!CFG?.ready) return;
  resetSession();
  S.transport = els.transport.value;
  setPhase('connecting');

  try {
    S.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await S.ctx.resume();

    S.mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const micSource = S.ctx.createMediaStreamSource(S.mic);
    S.micAnalyser = makeAnalyser();
    micSource.connect(S.micAnalyser);
    S.outAnalyser = makeAnalyser();

    if (S.transport === 'webrtc') await connectWebRtc();
    else await connectWebSocket(micSource);
  } catch (err) {
    if (S.phase === 'closed') return;
    const msg = err?.name === 'NotAllowedError'
      ? t('notice.micBlocked')
      : err?.message || String(err);
    fail(msg);
  }
}

function stop() {
  if (S.phase === 'connecting') return finish(t('notice.cancelled'));
  if (S.phase !== 'live') return;
  setPhase('closing');
  if (!send({ type: 'session.close' })) return finish();
  S.closeTimer = setTimeout(() => finish(t('notice.noFinalUsage')), 6000);
}

function finish(message, isError = false) {
  if (S.phase === 'closed') return;
  clearTimeout(S.closeTimer);
  clearTimeout(S.startTimer);
  const wasLive = S.t0 > 0;
  S.tEnd = wasLive ? (performance.now() - S.t0) / 1000 : 0;
  teardown();
  setPhase('closed');
  if (message) showNotice(message, !isError);
  for (const d of DELEGATIONS.values()) if (!d.end) d.end = S.tEnd;
}

function fail(message) {
  finish(message, true);
  els.status.dataset.state = 'error';
  setStatus('status.error');
}

function teardown() {
  try { S.player?.stop(); } catch { /* ignore */ }
  try { S.worklet?.port.close(); S.worklet?.disconnect(); } catch { /* ignore */ }
  S.mic?.getTracks().forEach((t) => t.stop());
  try { S.dc?.close(); } catch { /* ignore */ }
  try { S.pc?.close(); } catch { /* ignore */ }
  try { if (S.ws && S.ws.readyState <= 1) S.ws.close(); } catch { /* ignore */ }
  try { S.ctx?.close(); } catch { /* ignore */ }
  els.audio.srcObject = null;
  Object.assign(S, { pc: null, dc: null, ws: null, ctx: null, mic: null, micAnalyser: null, outAnalyser: null, worklet: null, player: null, muted: false });
  els.muteBtn.setAttribute('aria-pressed', 'false');
  els.muteBtn.textContent = t('btn.mute');
}

function resetSession() {
  hideNotice();
  S.t0 = 0; S.tEnd = 0; S.sessionId = null; S.muted = false;
  TL.bins = []; TL.binIdx = -1; TL.accYou = 0; TL.accLive = 0;
  DELEGATIONS.clear();
  TX.bubbles = []; TX.last = { you: null, live: null };
  els.transcript.innerHTML = '';
  els.transcriptEmpty.hidden = false;
  els.activity.innerHTML = '';
  els.activityEmpty.hidden = false;
  els.usage.textContent = '';
  els.clock.textContent = '0:00';
  els.injectStatus.textContent = '';
  LOG.lines = []; LOG.audioIn = 0; LOG.audioOut = 0; renderLog();
}

// ───────────────────────── transports ─────────────────────────

async function connectWebRtc() {
  const pc = new RTCPeerConnection();
  S.pc = pc;

  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    els.audio.srcObject = stream;
    els.audio.play().catch(() => {});
    try { S.ctx.createMediaStreamSource(stream).connect(S.outAnalyser); } catch { /* level meter only */ }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && S.phase !== 'closed') fail(t('notice.mediaFailed'));
  };

  for (const track of S.mic.getAudioTracks()) pc.addTrack(track, S.mic);

  const dc = pc.createDataChannel('oai-events');
  S.dc = dc;
  dc.onmessage = (e) => { try { onServerEvent(JSON.parse(e.data)); } catch (err) { console.warn('bad event', err); } };
  dc.onopen = () => {
    // The session starts when it is created; session.started should follow. Don't hang if it doesn't.
    S.startTimer = setTimeout(() => { if (S.phase === 'connecting') markLive(); }, 5000);
  };
  dc.onclose = () => { if (S.phase === 'live' || S.phase === 'closing') finish(t('notice.connClosed')); };

  await pc.setLocalDescription(await pc.createOffer());
  await waitForIce(pc, 3000);
  if (S.phase !== 'connecting') return;

  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: pc.localDescription.sdp, voice: els.voice.value, instructions: els.instructions.value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    logLine('err', `POST /api/session ${res.status} ${JSON.stringify(data.detail ?? data.error)}`);
    throw new Error(data.error || t('notice.sessionFailed', { status: res.status }));
  }
  if (S.phase !== 'connecting') return;
  S.sessionId = data.session?.id || null;
  logLine('in', `session created over WebRTC ${S.sessionId ?? ''}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
}

function waitForIce(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, timeoutMs);
  });
}

async function connectWebSocket(micSource) {
  // Playback chain: buffer sources → analyser → speakers
  S.outAnalyser.connect(S.ctx.destination);
  S.player = new PcmPlayer(S.ctx, S.outAnalyser);

  await S.ctx.audioWorklet.addModule('pcm-capture.js');
  S.worklet = new AudioWorkletNode(S.ctx, 'pcm-capture', { processorOptions: { targetRate: SAMPLE_RATE, chunkMs: 40 } });
  const sink = S.ctx.createGain();
  sink.gain.value = 0;
  micSource.connect(S.worklet);
  S.worklet.connect(sink).connect(S.ctx.destination);
  S.worklet.port.onmessage = (e) => {
    if (S.phase !== 'live' || S.ws?.readyState !== WebSocket.OPEN) return;
    S.ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: bytesToBase64(new Uint8Array(e.data)) }));
    LOG.audioIn++;
  };

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live`);
  S.ws = ws;
  ws.onopen = () => {
    const startMsg = { type: 'demo.start', voice: els.voice.value, instructions: els.instructions.value };
    ws.send(JSON.stringify(startMsg));
    logLine('out', `${JSON.stringify(startMsg)}  (the server sends session.start with model and delegation from .env)`);
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    try { onServerEvent(JSON.parse(e.data)); } catch (err) { console.warn('bad event', err); }
  };
  ws.onclose = (e) => {
    if (S.phase === 'connecting') fail(S.lastError || e.reason || t('notice.closedBeforeStart'));
    else if (S.phase === 'live' || S.phase === 'closing') finish(S.lastError || t('notice.connClosed'), !!S.lastError);
  };
}

// ───────────────────────── events ─────────────────────────

let seq = 0;
function send(evt) {
  if (!evt.event_id) evt.event_id = `c${Date.now().toString(36)}_${++seq}`;
  const json = JSON.stringify(evt);
  if (S.dc?.readyState === 'open') S.dc.send(json);
  else if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(json);
  else return false;
  logEvent('out', evt);
  return true;
}

function onServerEvent(evt) {
  logEvent('in', evt);

  switch (evt.type) {
    case 'session.started':
      S.sessionId = evt.session?.id || S.sessionId;
      markLive();
      break;

    case 'session.output_audio.delta':
      S.player?.enqueue(evt.delta, evt.start_ms, evt.end_ms);
      break;

    case 'session.input_transcript.delta':
      addTranscript('you', evt.delta, evt.start_ms, evt.end_ms);
      break;

    case 'session.output_transcript.delta':
      addTranscript('live', evt.delta, evt.start_ms, evt.end_ms);
      break;

    case 'session.delegation.created':
      onDelegationCreated(evt);
      break;

    case 'response.event':
      onResponseEvent(evt.delegation_id, evt.event || {});
      break;

    case 'session.usage.updated':
      showUsage(evt.usage, evt.context_window);
      break;

    case 'session.input_audio.muted':
    case 'session.input_audio.unmuted':
      break;

    case 'session.instructions.appended':
    case 'session.thinking.appended':
    case 'session.commentary.appended':
      els.injectStatus.textContent = t('inject.received');
      break;

    case 'session.closed':
      showUsage(evt.usage);
      addSystemLine(t('sys.ended', { reason: humanReason(evt.reason), time: fmtTime(evt.usage?.seconds ?? 0) }));
      finish();
      break;

    case 'error':
      onError(evt.error || evt);
      break;

    case 'demo.error':
      S.lastError = evt.message;
      logLine('err', evt.message);
      if (S.phase === 'connecting') fail(evt.message);
      else showNotice(evt.message);
      break;

    case 'demo.upstream_closed':
      if (S.phase === 'live' || S.phase === 'closing') finish(S.lastError || t('notice.upstreamClosed', { detail: `${evt.code}${evt.reason ? `: ${evt.reason}` : ''}` }), !!S.lastError);
      break;
  }
}

function markLive() {
  if (S.phase !== 'connecting') return;
  clearTimeout(S.startTimer);
  S.t0 = performance.now();
  setPhase('live');
  addSystemLine(t('sys.started', { id: S.sessionId ? ` (${S.sessionId})` : '' }));
}

function onError(err) {
  const msg = err.message || err.code || t('notice.unknownError');
  const hint = /deploy|model/i.test(msg) ? t('hint.deploy') : /voice/i.test(msg) ? t('hint.voice') : '';
  S.lastError = `${msg}${hint}`;
  if (S.phase === 'connecting') return fail(S.lastError);
  showNotice(`${err.code ? `${err.code}: ` : ''}${msg}${hint}`);
}

function humanReason(r) {
  const known = ['close_requested', 'expired', 'content', 'remote_hangup', 'connection_lost'];
  return known.includes(r) ? t(`reason.${r}`) : r || t('reason.closed');
}

function showUsage(usage, ctxWindow) {
  const parts = [];
  if (usage?.seconds != null) parts.push(t('usage.billed', { time: fmtTime(usage.seconds) }));
  if (ctxWindow?.usage_ratio != null) parts.push(t('usage.context', { pct: Math.round(ctxWindow.usage_ratio * 100) }));
  if (parts.length) els.usage.textContent = parts.join(lang === 'zh' ? '，' : ', ');
}

// ───────────────────────── mute & context ─────────────────────────

function toggleMute() {
  if (S.phase !== 'live') return;
  S.muted = !S.muted;
  S.mic?.getAudioTracks().forEach((t) => (t.enabled = !S.muted)); // a disabled track sends silence
  send({ type: S.muted ? 'session.input_audio.mute' : 'session.input_audio.unmute' });
  els.muteBtn.setAttribute('aria-pressed', String(S.muted));
  els.muteBtn.textContent = t(S.muted ? 'btn.unmute' : 'btn.mute');
}

function injectContext() {
  const content = els.injectText.value.trim();
  if (!content || S.phase !== 'live') return;
  const kind = els.injectKind.value; // instructions | thinking | commentary
  if (send({ type: `session.${kind}.append`, content, delegation_id: null })) {
    els.injectStatus.textContent = t('inject.sending');
    els.injectText.value = '';
    addSystemLine(t('sys.context', { kind: els.injectKind.selectedOptions[0].textContent.toLowerCase(), content }));
  }
}

// ───────────────────────── transcript ─────────────────────────

const TX = { bubbles: [], last: { you: null, live: null } };

function addTranscript(speaker, delta, startMs, endMs) {
  if (!delta) return;
  const nowMs = elapsed() * 1000;
  const start = startMs ?? nowMs;
  const end = endMs ?? start;
  let b = TX.last[speaker];
  const latest = TX.bubbles[TX.bubbles.length - 1];
  // Fragments can interleave between speakers; keep appending to a speaker's bubble while they're still mid-thought.
  if (!b || (latest !== b && start - b.end > 900)) {
    b = newBubble(speaker, start);
    TX.bubbles.push(b);
    TX.last[speaker] = b;
  }
  b.text += delta;
  b.end = Math.max(b.end, end);
  b.textEl.textContent = b.text;
  scrollToEnd(els.transcript);
}

function newBubble(speaker, startMs) {
  els.transcriptEmpty.hidden = true;
  const li = document.createElement('li');
  li.className = `msg ${speaker}`;
  const who = document.createElement('div');
  who.className = 'who';
  who.innerHTML = `<b>${speaker === 'you' ? t('conv.you') : 'GPT-Live'}</b><span>${fmtTime(startMs / 1000)}</span>`;
  const text = document.createElement('div');
  text.className = 'text';
  li.append(who, text);
  els.transcript.append(li);
  return { speaker, text: '', end: startMs, textEl: text };
}

function addSystemLine(message) {
  els.transcriptEmpty.hidden = true;
  const li = document.createElement('li');
  li.className = 'msg system';
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = message;
  li.append(text);
  els.transcript.append(li);
  TX.last = { you: null, live: null };
  scrollToEnd(els.transcript);
}

function scrollToEnd(el) {
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

// ───────────────────────── delegation & tools ─────────────────────────

const DELEGATIONS = new Map();

const TOOL_HANDLERS = {
  async get_current_time({ timezone }) {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const now = new Date();
      return {
        timezone: tz,
        local_time: now.toLocaleString('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
        utc: now.toISOString(),
      };
    } catch {
      return { error: `Unknown timezone "${tz}"` };
    }
  },

  async get_weather({ location }) {
    const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(location)}`);
    const place = geo.results?.[0];
    if (!place) return { error: `Couldn't find a place called "${location}"` };
    const wx = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`);
    const c = wx.current || {};
    return {
      location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
      conditions: weatherText(c.weather_code),
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      observed_local: c.time,
      source: 'Open-Meteo',
    };
  },
};

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function weatherText(code) {
  const table = [
    [[0], 'clear sky'], [[1], 'mainly clear'], [[2], 'partly cloudy'], [[3], 'overcast'], [[45, 48], 'fog'],
    [[51, 53, 55], 'drizzle'], [[56, 57], 'freezing drizzle'], [[61, 63, 65], 'rain'], [[66, 67], 'freezing rain'],
    [[71, 73, 75, 77], 'snow'], [[80, 81, 82], 'rain showers'], [[85, 86], 'snow showers'], [[95], 'thunderstorm'], [[96, 99], 'thunderstorm with hail'],
  ];
  return table.find(([codes]) => codes.includes(code))?.[1] ?? 'unknown';
}

function onDelegationCreated(evt) {
  const info = evt.delegation || {};
  const d = getDelegation(info.id || evt.response_id || `d${DELEGATIONS.size + 1}`);
  d.target = info.target || 'responses';
  d.responseId = evt.response_id || d.responseId;

  if (d.target === 'client') {
    // Client delegation: this demo has no backend of its own, so tell GPT-Live plainly.
    setTaskState(d, t('task.noBackend'));
    d.end = elapsed();
    send({
      type: 'session.commentary.append',
      delegation_id: d.id,
      content: 'There is no backend connected in this demo, so I cannot look that up right now. Set DELEGATION_MODEL in .env to enable it.',
    });
  }
}

function getDelegation(id) {
  let d = DELEGATIONS.get(id);
  if (d) return d;

  els.activityEmpty.hidden = true;
  const li = document.createElement('li');
  li.className = 'task';
  li.innerHTML = `<div class="task-head"><span>${t('task.delegated')}</span><span class="task-state"></span></div><p class="task-text"></p><div class="tools"></div>`;
  li.querySelector('.task-state').textContent = t('task.thinking');
  li.querySelector('.t').textContent = fmtTime(elapsed());
  els.activity.prepend(li);

  d = {
    id, target: 'responses', responseId: null, start: elapsed(), end: null, label: 'thinking',
    text: '', pending: [], toolNames: [],
    el: li, stateEl: li.querySelector('.task-state'), textEl: li.querySelector('.task-text'), toolsEl: li.querySelector('.tools'),
  };
  DELEGATIONS.set(id, d);
  return d;
}

function setTaskState(d, label, failed = false) {
  d.stateEl.textContent = label;
  d.el.dataset.state = failed ? 'failed' : '';
}

function onResponseEvent(delegationId, ev) {
  const d = getDelegation(delegationId || ev.response?.id || 'responses');
  if (d.end) { d.end = null; } // work resumed (e.g. after tool results)

  switch (ev.type) {
    case 'response.created':
      d.responseId = ev.response?.id || d.responseId;
      setTaskState(d, t('task.thinking'));
      break;

    case 'response.output_text.delta':
      d.text += ev.delta || '';
      d.textEl.textContent = d.text;
      setTaskState(d, t('task.answering'));
      break;

    case 'response.output_item.added':
      if (ev.item?.type === 'web_search_call') addToolRow(d, 'web_search', '', t('tool.searching'));
      break;

    case 'response.output_item.done': {
      const item = ev.item || {};
      if (item.type === 'function_call') runFunctionCall(d, item);
      else if (item.type === 'web_search_call') {
        const row = d.toolsEl.lastElementChild;
        if (row) row.querySelector('.result').textContent = item.action?.query ? t('tool.searched', { q: item.action.query }) : t('tool.doneShort');
      }
      break;
    }

    case 'response.completed':
    case 'response.incomplete': {
      const pending = d.pending.splice(0);
      if (pending.length) {
        setTaskState(d, t('task.runningTools'));
        Promise.all(pending).then((results) => {
          if (S.phase !== 'live') return;
          for (const r of results) {
            send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: r.call_id, output: r.output } });
          }
          send({ type: 'response.create' });
          setTaskState(d, t('task.thinking'));
        });
      } else {
        const tokens = ev.response?.usage?.total_tokens;
        setTaskState(d, tokens ? t('task.doneTokens', { n: tokens }) : t('task.done'));
        d.end = elapsed();
      }
      break;
    }

    case 'response.failed':
    case 'error': {
      const msg = ev.response?.error?.message || ev.error?.message || ev.message || t('task.backendError');
      setTaskState(d, t('task.failed'), true);
      d.textEl.textContent = (d.text ? `${d.text}\n` : '') + msg;
      d.end = elapsed();
      break;
    }
  }
}

function runFunctionCall(d, item) {
  let args = {};
  try { args = JSON.parse(item.arguments || '{}'); } catch { /* keep empty */ }
  const row = addToolRow(d, item.name, item.arguments || '{}', t('tool.running'));
  d.toolNames.push(item.name);
  d.label = d.toolNames.join(', ');
  setTaskState(d, t('task.callingTools'));

  const handler = TOOL_HANDLERS[item.name];
  const p = (handler ? handler(args) : Promise.resolve({ error: `Unknown tool ${item.name}` }))
    .catch((err) => ({ error: String(err?.message || err) }))
    .then((result) => {
      row.querySelector('.result').textContent = summarize(result);
      return { call_id: item.call_id, output: JSON.stringify(result) };
    });
  d.pending.push(p);
}

function addToolRow(d, name, args, status) {
  const div = document.createElement('div');
  div.className = 'tool';
  const call = document.createElement('div');
  call.className = 'call';
  const b = document.createElement('b');
  b.textContent = name;
  call.append(b, document.createTextNode(args ? `(${compactArgs(args)})` : ''));
  const result = document.createElement('div');
  result.className = 'result';
  result.textContent = status;
  div.append(call, result);
  d.toolsEl.append(div);
  return div;
}

function compactArgs(json) {
  try {
    return Object.entries(JSON.parse(json)).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
  } catch {
    return json;
  }
}

function summarize(result) {
  if (result?.error) return t('tool.error', { msg: result.error });
  if (result?.conditions) return `${result.location}: ${result.conditions}, ${result.temperature_c}°C`;
  if (result?.local_time) return result.local_time;
  return JSON.stringify(result).slice(0, 160);
}

// ───────────────────────── audio ─────────────────────────

function makeAnalyser() {
  const a = S.ctx.createAnalyser();
  a.fftSize = 1024;
  a.smoothingTimeConstant = 0;
  return a;
}

const levelBuf = new Float32Array(1024);
function level(analyser) {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(levelBuf);
  let sum = 0;
  for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / levelBuf.length) + 1e-9);
  return Math.min(1, Math.max(0, (db + 60) / 48));
}

class PcmPlayer {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.dest = destination;
    this.next = 0;
    this.lastEnd = null;
    this.sources = new Set();
  }

  enqueue(b64, startMs, endMs) {
    if (!b64) return;
    const bytes = base64ToBytes(b64);
    const n = bytes.length >> 1;
    if (!n) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const buffer = this.ctx.createBuffer(1, n, SAMPLE_RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;

    const now = this.ctx.currentTime;
    let when = Math.max(now + 0.06, this.next);
    // Gaps between start/end ranges are silence; honour them while audio is still queued.
    if (startMs != null && this.lastEnd != null && this.next > now) {
      const gap = (startMs - this.lastEnd) / 1000;
      if (gap > 0.005 && gap < 1.5) when += gap;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.dest);
    src.onended = () => this.sources.delete(src);
    src.start(when);
    this.sources.add(src);
    this.next = when + buffer.duration;
    this.lastEnd = endMs ?? (startMs != null ? startMs + buffer.duration * 1000 : null);
  }

  stop() {
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
    this.next = 0;
  }
}

function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ───────────────────────── timeline ─────────────────────────

const TL = { bins: [], binIdx: -1, accYou: 0, accLive: 0, colors: null, lastClock: '' };

const colorQuery = window.matchMedia('(prefers-color-scheme: dark)');
colorQuery.addEventListener?.('change', () => (TL.colors = null));

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { you: v('--you'), live: v('--live'), backend: v('--backend'), backendTint: v('--backend-tint'), line: v('--line'), grid: v('--grid'), muted: v('--muted'), ink: v('--ink'), font: v('--font') };
}

function elapsed() {
  if (S.phase === 'live' || S.phase === 'closing') return S.t0 ? (performance.now() - S.t0) / 1000 : 0;
  return S.tEnd;
}

function frame() {
  const live = S.phase === 'live' || S.phase === 'closing';
  if (live && S.t0) {
    const t = elapsed();
    const idx = Math.floor(t / BIN);
    TL.accYou = Math.max(TL.accYou, S.muted ? 0 : level(S.micAnalyser));
    TL.accLive = Math.max(TL.accLive, level(S.outAnalyser));
    if (idx !== TL.binIdx) {
      if (TL.binIdx >= 0) TL.bins.push({ t: TL.binIdx * BIN, you: TL.accYou, live: TL.accLive });
      TL.binIdx = idx;
      TL.accYou = 0;
      TL.accLive = 0;
      while (TL.bins.length && TL.bins[0].t < t - 60) TL.bins.shift();
    }
    const clock = fmtTime(t);
    if (clock !== TL.lastClock) els.clock.textContent = TL.lastClock = clock;
  }
  draw();
  requestAnimationFrame(frame);
}

function draw() {
  const c = els.canvas;
  const rect = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = rect.width;
  const H = rect.height;
  if (!W || !H) return;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
  }
  const g = c.getContext('2d');
  const col = (TL.colors ||= readColors());
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const AXIS = 24;
  const laneH = (H - AXIS) / 3;
  const now = elapsed();
  const win = W < 520 ? 12 : 24;
  const left = 6;
  const right = W - 14;
  const pps = (right - left) / win;
  const viewStart = Math.max(0, now - win); // fill from the left first, then scroll
  const x = (t) => left + (t - viewStart) * pps;

  // lane dividers & axis
  g.lineWidth = 1;
  g.strokeStyle = col.grid;
  for (let i = 1; i < 3; i++) hline(g, 0, W, Math.round(i * laneH) + 0.5);
  g.strokeStyle = col.line;
  hline(g, 0, W, Math.round(3 * laneH) + 0.5);

  const started = S.t0 > 0 || S.tEnd > 0;
  if (started) {
    // time grid
    const step = win > 15 ? 5 : 3;
    g.font = `500 11px ${col.font}`;
    g.fillStyle = col.muted;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let t = Math.ceil(viewStart / step) * step; t <= now; t += step) {
      const X = Math.round(x(t)) + 0.5;
      g.strokeStyle = col.grid;
      vline(g, X, 0, 3 * laneH);
      g.fillText(fmtTime(t), Math.max(X, left + 12), H - AXIS / 2);
    }

    // voice bars
    const bw = Math.max(1.5, BIN * pps - 1.25);
    const maxH = laneH - 16;
    for (const b of TL.bins) {
      const X = x(b.t + BIN);
      if (X - bw < left || X - bw > right) continue;
      if (b.you > 0.03) {
        const h = Math.max(2, b.you * maxH);
        g.fillStyle = col.you;
        g.fillRect(X - bw, laneH * 0.5 - h / 2, bw, h);
      }
      if (b.live > 0.03) {
        const h = Math.max(2, b.live * maxH);
        g.fillStyle = col.live;
        g.fillRect(X - bw, laneH * 1.5 - h / 2, bw, h);
      }
    }

    // backend work blocks
    const y = laneH * 2 + laneH * 0.22;
    const h = laneH * 0.56;
    g.textAlign = 'left';
    g.font = `500 12px ${col.font}`;
    for (const d of DELEGATIONS.values()) {
      const x1 = Math.max(left, x(d.start));
      const x2 = Math.min(right, x(d.end ?? now));
      if (x2 < left) continue;
      const w = Math.max(4, x2 - x1);
      g.fillStyle = col.backendTint;
      g.strokeStyle = col.backend;
      roundRect(g, x1, y, w, h, 6);
      g.fill();
      g.stroke();
      if (w > 40) {
        g.save();
        g.beginPath();
        g.rect(x1 + 8, y, w - 12, h);
        g.clip();
        g.fillStyle = col.backend;
        g.fillText(d.label, x1 + 9, y + h / 2 + 0.5);
        g.restore();
      }
    }

    // now marker
    if (S.phase === 'live' || S.phase === 'closing') {
      g.strokeStyle = col.ink;
      g.globalAlpha = 0.25;
      vline(g, Math.round(x(now)) + 0.5, 0, 3 * laneH);
      g.globalAlpha = 1;
    }
  }
}

function hline(g, x1, x2, y) { g.beginPath(); g.moveTo(x1, y); g.lineTo(x2, y); g.stroke(); }
function vline(g, x, y1, y2) { g.beginPath(); g.moveTo(x, y1); g.lineTo(x, y2); g.stroke(); }
function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ───────────────────────── log & helpers ─────────────────────────

const LOG = { lines: [], audioIn: 0, audioOut: 0, pending: false };

function logEvent(dir, evt) {
  if (evt.type === 'session.output_audio.delta') { LOG.audioOut++; return scheduleLog(); }
  if (evt.type === 'session.input_audio.append') { LOG.audioIn++; return scheduleLog(); }
  let text = JSON.stringify(evt);
  if (text.length > 1500) text = `${text.slice(0, 1500)}… (${text.length} chars)`;
  logLine(evt.type === 'error' ? 'err' : dir, text);
}

function logLine(kind, text) {
  const arrow = kind === 'out' ? '→' : kind === 'err' ? '!' : '←';
  LOG.lines.push({ kind, text: `${fmtTime(elapsed())} ${arrow} ${text}` });
  if (LOG.lines.length > 400) LOG.lines.splice(0, LOG.lines.length - 400);
  scheduleLog();
}

function scheduleLog() {
  if (LOG.pending) return;
  LOG.pending = true;
  setTimeout(() => { LOG.pending = false; renderLog(); }, 250);
}

function renderLog() {
  const audio = LOG.audioIn || LOG.audioOut ? t('log.audio', { sent: LOG.audioIn, received: LOG.audioOut }) : '';
  els.logCount.textContent = t('log.count', { n: LOG.lines.length }) + audio;
  if (!els.log.closest('details').open) return;
  const atBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 40;
  els.log.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const l of LOG.lines) {
    const span = document.createElement('span');
    span.className = l.kind;
    span.textContent = `${l.text}\n`;
    frag.append(span);
  }
  els.log.append(frag);
  if (atBottom) els.log.scrollTop = els.log.scrollHeight;
}

function showNotice(message, info = false) {
  els.notice.textContent = message;
  els.notice.classList.toggle('info', info);
  els.notice.hidden = false;
}
function hideNotice() { els.notice.hidden = true; S.lastError = null; }

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
