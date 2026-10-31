// UI strings. Static markup uses data-i18n / data-i18n-placeholder / data-i18n-aria;
// app.js calls t(key, vars) for everything it builds at runtime.

const STRINGS = {
  en: {
    'doc.title': 'GPT-Live demo',
    'brand.tagline': 'Full-duplex voice on Azure OpenAI',
    'lang.label': 'Interface language',
    'cfg.endpoint': 'Endpoint',
    'cfg.model': 'Voice model',
    'cfg.backend': 'Backend',
    'cfg.notSet': 'not set',
    'cfg.none': 'none',
    'cfg.notConfigured': 'not configured',

    'status.checking': 'Checking setup',
    'status.idle': 'Ready',
    'status.connecting': 'Connecting',
    'status.live': 'Live',
    'status.closing': 'Ending',
    'status.closed': 'Ended',
    'status.error': 'Error',
    'status.needsSetup': 'Needs setup',
    'status.unreachable': 'Server not reachable',

    'stage.title': 'Live timeline',
    'lane.you': 'You',
    'lane.mic': 'microphone',
    'lane.live': 'GPT-Live',
    'lane.voice': 'voice',
    'lane.backend': 'Backend',
    'lane.delegated': 'delegated work',
    'stage.canvas': "Scrolling timeline of your voice, GPT-Live's voice and backend work",
    'stage.hint': 'Start a conversation, then talk over it. Both voices land on this timeline, so you can see GPT-Live keep listening while it speaks.',

    'btn.start': 'Start conversation',
    'btn.startAgain': 'Start again',
    'btn.cancel': 'Cancel',
    'btn.end': 'End conversation',
    'btn.mute': 'Mute mic',
    'btn.unmute': 'Unmute mic',
    'clock.label': 'Session time',

    'conv.title': 'Conversation',
    'conv.empty': 'What you say and what GPT-Live says appear here as the session runs.',
    'conv.you': 'You',

    'setup.title': 'Session',
    'setup.voice': 'Voice',
    'setup.voiceDefault': '(default)',
    'setup.connection': 'Connection',
    'setup.webrtc': 'WebRTC (recommended)',
    'setup.websocket': 'WebSocket relay',
    'setup.instructions': 'Instructions for GPT-Live',
    'setup.reset': 'Restore default instructions',

    'backend.title': 'Backend activity',
    'backend.empty': 'When GPT-Live hands a question to the backend model, the reasoning and tool calls show up here. Try asking for the weather in Shanghai.',

    'inject.title': 'Add context mid-call',
    'inject.placeholder': 'The caller is a Gold member flying to Singapore tomorrow.',
    'inject.kindLabel': 'How GPT-Live should use it',
    'inject.thinking': 'Know it quietly',
    'inject.commentary': 'Say it aloud',
    'inject.instructions': 'Follow it as an instruction',
    'inject.send': 'Send to GPT-Live',
    'inject.sending': 'Sending…',
    'inject.received': 'GPT-Live has the new context.',

    'log.title': 'Event log',
    'log.count': '{n} events',
    'log.audio': ', audio chunks {sent} sent / {received} received',

    'notice.unreachable': 'Could not reach the demo server. Is "uv run server.py" running?',
    'notice.fixEnv': '{problems}. Edit gpt-live/.env, then restart the server.',
    'notice.micBlocked': 'Microphone access was blocked. Allow the microphone for this page and try again.',
    'notice.cancelled': 'Cancelled before the session started.',
    'notice.noFinalUsage': 'The session ended without a final usage report.',
    'notice.mediaFailed': 'The media connection failed. Try the WebSocket connection instead.',
    'notice.connClosed': 'The session connection closed.',
    'notice.closedBeforeStart': 'The connection closed before the session started.',
    'notice.upstreamClosed': 'The service closed the connection ({detail}).',
    'notice.sessionFailed': 'Session request failed (HTTP {status})',
    'notice.unknownError': 'Unknown error',
    'hint.deploy': ' Check GPT_LIVE_MODEL and DELEGATION_MODEL in .env match deployment names in your resource.',
    'hint.voice': ' Pick another voice; marin is the documented default.',

    'sys.started': 'Session started{id}. Say hello.',
    'sys.ended': 'Session ended ({reason}). Billed voice time {time}.',
    'sys.context': 'Context added ({kind}): {content}',
    'reason.close_requested': 'you ended it',
    'reason.expired': 'session expired',
    'reason.content': 'content policy',
    'reason.remote_hangup': 'remote hang-up',
    'reason.connection_lost': 'connection lost',
    'reason.closed': 'closed',

    'usage.billed': 'Billed {time}',
    'usage.context': 'context {pct}% used',

    'task.delegated': '<b>Delegated</b> at <span class="t"></span>',
    'task.thinking': 'Thinking',
    'task.answering': 'Answering',
    'task.runningTools': 'Running tools',
    'task.callingTools': 'Calling tools',
    'task.done': 'Done',
    'task.doneTokens': 'Done, {n} tokens',
    'task.failed': 'Failed',
    'task.noBackend': 'No backend configured',
    'task.backendError': 'Backend error',
    'tool.searching': 'Searching the web…',
    'tool.searched': 'searched "{q}"',
    'tool.doneShort': 'done',
    'tool.running': 'running…',
    'tool.error': 'error: {msg}',
  },

  zh: {
    'doc.title': 'GPT-Live 演示',
    'brand.tagline': 'Azure OpenAI 全双工语音',
    'lang.label': '界面语言',
    'cfg.endpoint': '终结点',
    'cfg.model': '语音模型',
    'cfg.backend': '后端',
    'cfg.notSet': '未设置',
    'cfg.none': '无',
    'cfg.notConfigured': '未配置',

    'status.checking': '正在检查配置',
    'status.idle': '就绪',
    'status.connecting': '连接中',
    'status.live': '通话中',
    'status.closing': '正在结束',
    'status.closed': '已结束',
    'status.error': '出错',
    'status.needsSetup': '需要配置',
    'status.unreachable': '无法连接服务器',

    'stage.title': '实时时间线',
    'lane.you': '你',
    'lane.mic': '麦克风',
    'lane.live': 'GPT-Live',
    'lane.voice': '音色',
    'lane.backend': '后端',
    'lane.delegated': '委派任务',
    'stage.canvas': '滚动时间线：你的语音、GPT-Live 的语音和后端任务',
    'stage.hint': '开始对话后可以随时插话。双方的声音都会显示在这条时间线上，你能看到 GPT-Live 一边说话一边继续聆听。',

    'btn.start': '开始对话',
    'btn.startAgain': '重新开始',
    'btn.cancel': '取消',
    'btn.end': '结束对话',
    'btn.mute': '静音麦克风',
    'btn.unmute': '取消静音',
    'clock.label': '会话时长',

    'conv.title': '对话',
    'conv.empty': '会话进行时，你和 GPT-Live 说的话会显示在这里。',
    'conv.you': '你',

    'setup.title': '会话设置',
    'setup.voice': '音色',
    'setup.voiceDefault': '（默认）',
    'setup.connection': '连接方式',
    'setup.webrtc': 'WebRTC（推荐）',
    'setup.websocket': 'WebSocket 中继',
    'setup.instructions': 'GPT-Live 指令',
    'setup.reset': '恢复默认指令',

    'backend.title': '后端活动',
    'backend.empty': 'GPT-Live 把问题交给后端模型时，推理过程和工具调用会显示在这里。试着问问上海的天气。',

    'inject.title': '通话中补充上下文',
    'inject.placeholder': '来电者是金卡会员，明天飞往新加坡。',
    'inject.kindLabel': 'GPT-Live 如何使用这条信息',
    'inject.thinking': '默默知晓',
    'inject.commentary': '直接说出来',
    'inject.instructions': '作为指令执行',
    'inject.send': '发送给 GPT-Live',
    'inject.sending': '发送中…',
    'inject.received': 'GPT-Live 已收到新的上下文。',

    'log.title': '事件日志',
    'log.count': '{n} 个事件',
    'log.audio': '，音频块 已发送 {sent} / 已接收 {received}',

    'notice.unreachable': '无法连接演示服务器。请确认 "uv run server.py" 正在运行。',
    'notice.fixEnv': '{problems}。请编辑 gpt-live/.env，然后重启服务器。',
    'notice.micBlocked': '麦克风权限被阻止。请允许此页面使用麦克风后重试。',
    'notice.cancelled': '会话开始前已取消。',
    'notice.noFinalUsage': '会话已结束，但未收到最终用量报告。',
    'notice.mediaFailed': '媒体连接失败。请改用 WebSocket 连接。',
    'notice.connClosed': '会话连接已关闭。',
    'notice.closedBeforeStart': '会话开始前连接已关闭。',
    'notice.upstreamClosed': '服务端关闭了连接（{detail}）。',
    'notice.sessionFailed': '创建会话失败（HTTP {status}）',
    'notice.unknownError': '未知错误',
    'hint.deploy': ' 请确认 .env 中的 GPT_LIVE_MODEL 和 DELEGATION_MODEL 与资源中的部署名称一致。',
    'hint.voice': ' 请换一个音色，marin 是官方默认音色。',

    'sys.started': '会话已开始{id}。打个招呼吧。',
    'sys.ended': '会话已结束（{reason}）。计费语音时长 {time}。',
    'sys.context': '已补充上下文（{kind}）：{content}',
    'reason.close_requested': '你主动结束',
    'reason.expired': '会话已过期',
    'reason.content': '内容策略',
    'reason.remote_hangup': '对方挂断',
    'reason.connection_lost': '连接中断',
    'reason.closed': '已关闭',

    'usage.billed': '计费 {time}',
    'usage.context': '上下文已用 {pct}%',

    'task.delegated': '<b>委派</b>于 <span class="t"></span>',
    'task.thinking': '思考中',
    'task.answering': '回答中',
    'task.runningTools': '执行工具',
    'task.callingTools': '调用工具',
    'task.done': '完成',
    'task.doneTokens': '完成，{n} tokens',
    'task.failed': '失败',
    'task.noBackend': '未配置后端',
    'task.backendError': '后端错误',
    'tool.searching': '正在联网搜索…',
    'tool.searched': '已搜索 "{q}"',
    'tool.doneShort': '完成',
    'tool.running': '运行中…',
    'tool.error': '错误：{msg}',
  },
};

export const LANGS = { zh: '中文', en: 'English' };
const KEY = 'gptlive.lang';

export let lang = detect();

function detect() {
  const fromHub = new URLSearchParams(location.search).get('lang'); // the hub's Open link passes its language
  if (fromHub && STRINGS[fromHub]) return fromHub;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && STRINGS[saved]) return saved;
  } catch { /* storage unavailable */ }
  return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
}

export function setLang(next) {
  if (!STRINGS[next]) return;
  lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
  applyStatic();
}

export function t(key, vars) {
  const s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
}

export function applyStatic(root = document) {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('doc.title');
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}
