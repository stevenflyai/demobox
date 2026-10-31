// UI strings. Static markup uses data-i18n / data-i18n-html / data-i18n-placeholder / data-i18n-aria / data-i18n-title;
// app.js calls t(key, vars) for everything it builds at runtime. Server error messages stay in English.

const STRINGS = {
  en: {
    'doc.title': 'Decision models',
    'brand.tagline': 'Same input, same questions, three typed answers',
    'home.title': 'Back to all demos',
    'lang.label': 'Interface language',
    'providers.label': 'Providers',

    'editor.title': 'Scenario',
    'preset.label': 'Load a scenario',
    'state.label': 'State',
    'state.hint': 'text, or a JSON object',
    'questions.title': 'Questions',
    'btn.addQuestion': 'Add question',
    'btn.run': 'Run on all providers',
    'btn.running': 'Running…',
    'runs.label': 'Runs',

    'q.name': 'Question name',
    'q.type': 'Question type',
    'q.remove': 'Remove question',
    'q.instructions': 'Instructions',
    'q.instructionsPlaceholder': 'What should the model decide?',
    'q.optionsChoice': 'Options, one per line · value: description',
    'q.optionsScore': 'Levels, lowest first · label: description',
    'type.yesno': 'Yes / no',
    'type.choice': 'Choice',
    'type.score': 'Score',
    'kind.yesno': 'yes / no',
    'kind.choice': 'choice',
    'kind.score': 'score',

    'results.title': 'Answers',
    'results.legend': 'Latency is measured on this server, from request to full response. <span class="seg-key connect"></span> connect is DNS, TCP and TLS on a new connection; <span class="seg-key response"></span> response includes one network round trip.',
    'results.empty': 'Pick a scenario and press <b>Run on all providers</b>. Each provider gets the same state and questions in its own wire format, and the answers line up here row by row.',
    'warm.label': 'Keep connections warm',
    'warm.title': 'Ping each endpoint without a key every 20 seconds so runs reuse an open connection. Nothing is billed.',
    'warm.status': 'round trip {list}',

    'protocol.title': 'On the wire',
    'protocol.empty': 'The exact request and response for each provider appear here after a run.',
    'wire.request': 'Request',
    'wire.response': 'Response',
    'wire.warm': 'warm connection',
    'wire.connect': 'connect {ms} ms',
    'wire.noResponse': 'no response',

    'corner.question': 'Question',
    'head.notConfigured': 'not configured',
    'head.waiting': 'waiting…',
    'head.failed': 'failed',
    'head.median': 'median of {n} · {min}–{max}',
    'head.tokens': '{in} in · {out} out tokens',
    'timing.warm': 'warm · response {ms} ms',
    'timing.cold': 'connect {connect} + response {response} ms',
    'timing.rtt': 'round trip ~{ms} ms',

    'price.title': 'List price',
    'price.unit': 'USD per 1M tokens',
    'price.rates': '{input} in · {output} out',
    'price.free': 'free',
    'price.perRuns': '≈ {cost} per 1M runs like this one',
    'price.lowest': 'lowest',
    'price.notSet': 'Set {prefix}_PRICE_INPUT_PER_1M in .env',

    'tokens.compare': 'Same request, different input token counts: {list}. Cost is input tokens × list price, so the same price per token can still mean a different cost per run.',
    'tokens.why': 'Why do the counts differ?',
    'tokens.fixed': '<b>Jev adds about 250 input tokens to every request</b>, whatever the content. With a one-character input and one question, Jev reports 273 tokens and Microsoft-Decision-1 reports 23. Adding more text raises both by the same amount, so the gap stays at about 250. Most likely Jev wraps each request in its own prompt template and counts it.',
    'tokens.language': '<b>English text counts the same; Chinese does not.</b> Both count about 16 tokens per English sentence. For Chinese text Jev counts about 1.5× as many tokens as Microsoft-Decision-1.',
    'tokens.short': '<b>The shorter the input, the bigger the gap.</b> For short classification or routing calls the fixed overhead is most of the bill: 250 tokens × $0.042 is about $10.50 extra per 1M calls.',
    'tokens.gpt': '<b>GPT Decisions uses a different wire format</b> (questions as an array, each choice with a description), so its request is longer before any counting differences.',
    'tokens.source': 'Measured in October 2026 by sending identical payloads and comparing the usage each API returns. Your invoice is the final word.',

    'cell.off': 'Set {prefix}_BASE_URL and _API_KEY in .env',
    'cell.failed': 'Request failed',
    'cell.waiting': 'waiting',
    'cell.refused': 'Refused to answer',
    'cell.missing': 'No answer returned',
    'cell.noProbability': 'No probability returned',
    'cell.yes': 'Yes',
    'cell.no': 'No',
    'cell.pctYes': '{p} yes',
    'cell.pctYesAria': '{p} probability yes',
    'cell.confidence': 'confidence {p}',

    'verdict.agree': 'Agree',
    'verdict.agreeSpread': 'Agree · spread {spread}',
    'verdict.disagree': 'Disagree',
    'verdict.apart': 'Apart · spread {spread}',

    'provider.notConfigured': 'not configured',
    'provider.setHint': 'Set {vars} in decision/.env',

    'notice.unreachable': 'The demo server is not reachable. Start it with uv run server.py in decision/.',
    'notice.noProvider': 'No provider is configured yet. Fill in URLs and keys in decision/.env, then restart the server.',
    'notice.noState': 'Add some state for the models to judge.',
    'notice.noQuestions': 'Add at least one question.',
    'notice.serverError': 'Demo server error: {msg}',

    'scenario.zh': 'Chinese: return request',
    'scenario.zh_moderation': 'Chinese: comment moderation',
    'scenario.zh_fraud': 'Chinese: suspicious transfer',
    'scenario.zh_ops': 'Chinese: alert triage',
    'scenario.zh_contract': 'Chinese: contract review',
  },

  zh: {
    'doc.title': '决策模型',
    'brand.tagline': '同样的输入、同样的问题，三个模型给出带类型的答案',
    'home.title': '返回所有演示',
    'lang.label': '界面语言',
    'providers.label': '服务商',

    'editor.title': '场景',
    'preset.label': '载入场景',
    'state.label': '输入',
    'state.hint': '文本或 JSON 对象',
    'questions.title': '问题',
    'btn.addQuestion': '添加问题',
    'btn.run': '在所有模型上运行',
    'btn.running': '运行中…',
    'runs.label': '次数',

    'q.name': '问题名称',
    'q.type': '问题类型',
    'q.remove': '删除问题',
    'q.instructions': '说明',
    'q.instructionsPlaceholder': '模型要判断什么？',
    'q.optionsChoice': '选项，每行一个 · 值: 描述',
    'q.optionsScore': '等级，从低到高 · 标签: 描述',
    'type.yesno': '是 / 否',
    'type.choice': '选择',
    'type.score': '评分',
    'kind.yesno': '是 / 否',
    'kind.choice': '选择',
    'kind.score': '评分',

    'results.title': '答案',
    'results.legend': '延迟在本机服务器上测量，从发出请求到收完响应。<span class="seg-key connect"></span> 建连 = 新连接的 DNS、TCP 和 TLS；<span class="seg-key response"></span> 响应 = 含一次网络往返。',
    'results.empty': '选一个场景，点击<b>在所有模型上运行</b>。每个模型以各自的协议格式收到相同的输入和问题，答案在这里逐行对齐。',
    'warm.label': '保持连接预热',
    'warm.title': '每 20 秒向各个地址发一个不带 key 的请求，让运行复用已打开的连接。不会计费。',
    'warm.status': '网络往返 {list}',

    'protocol.title': '线上报文',
    'protocol.empty': '运行后，这里会显示每个模型的原始请求和响应。',
    'wire.request': '请求',
    'wire.response': '响应',
    'wire.warm': '复用连接',
    'wire.connect': '建连 {ms} ms',
    'wire.noResponse': '无响应',

    'corner.question': '问题',
    'head.notConfigured': '未配置',
    'head.waiting': '等待中…',
    'head.failed': '失败',
    'head.median': '{n} 次中位数 · {min}–{max}',
    'head.tokens': '输入 {in} · 输出 {out} tokens',
    'timing.warm': '复用连接 · 响应 {ms} ms',
    'timing.cold': '建连 {connect} + 响应 {response} ms',
    'timing.rtt': '网络往返 ~{ms} ms',

    'price.title': '标价',
    'price.unit': '美元 / 百万 tokens',
    'price.rates': '输入 {input} · 输出 {output}',
    'price.free': '免费',
    'price.perRuns': '同样的请求跑 100 万次 ≈ {cost}',
    'price.lowest': '最低',
    'price.notSet': '在 .env 中设置 {prefix}_PRICE_INPUT_PER_1M',

    'tokens.compare': '同一个请求，各家报告的输入 token 数不同：{list}。成本 = 输入 token × 单价，所以单价相同，每次调用的成本也可能不同。',
    'tokens.why': '为什么 token 数不一样？',
    'tokens.fixed': '<b>Jev 每次请求固定多计约 250 个输入 token</b>，与内容无关。只输入一个字、问一个问题时，Jev 报 273 个，Microsoft-Decision-1 报 23 个。输入加长时两家增加的一样多，差值始终约 250。最可能的原因是 Jev 在服务端给每个请求套了自己的提示模板，并计入了 token。',
    'tokens.language': '<b>英文计数相同，中文不同。</b>每句英文两家都算约 16 个 token；同样的中文，Jev 计的 token 约是 Microsoft-Decision-1 的 1.5 倍。',
    'tokens.short': '<b>输入越短，差距越大。</b>分类、路由这类短文本调用里，固定开销占了大头：250 个 token × $0.042，每 100 万次调用约多花 $10.50。',
    'tokens.gpt': '<b>GPT Decisions 用的是另一种协议格式</b>（问题以数组发送，每个选项都带描述），请求本身就更长，还没算计数方式的差别。',
    'tokens.source': '2026 年 10 月实测：向各家发送相同的请求，比较 API 返回的 usage。实际费用以账单为准。',

    'cell.off': '在 .env 中设置 {prefix}_BASE_URL 和 _API_KEY',
    'cell.failed': '请求失败',
    'cell.waiting': '等待中',
    'cell.refused': '拒绝回答',
    'cell.missing': '没有返回答案',
    'cell.noProbability': '没有返回概率',
    'cell.yes': '是',
    'cell.no': '否',
    'cell.pctYes': '{p} 为是',
    'cell.pctYesAria': '为是的概率 {p}',
    'cell.confidence': '置信度 {p}',

    'verdict.agree': '一致',
    'verdict.agreeSpread': '一致 · 差距 {spread}',
    'verdict.disagree': '不一致',
    'verdict.apart': '有分歧 · 差距 {spread}',

    'provider.notConfigured': '未配置',
    'provider.setHint': '在 decision/.env 中设置 {vars}',

    'notice.unreachable': '无法连接演示服务器。请在 decision/ 中运行 uv run server.py。',
    'notice.noProvider': '还没有配置任何模型。请在 decision/.env 中填写地址和 key，然后重启服务器。',
    'notice.noState': '请填写要让模型判断的输入。',
    'notice.noQuestions': '请至少添加一个问题。',
    'notice.serverError': '演示服务器出错：{msg}',

    'scenario.triage': '客服工单分流',
    'scenario.tools': 'Agent 工具选择',
    'scenario.injection': '提示注入拦截',
    'scenario.grading': 'AI 回答评分',
    'scenario.zh': '中文客服：退换货',
    'scenario.zh_moderation': '中文内容审核：社区评论',
    'scenario.zh_fraud': '中文风控：可疑转账',
    'scenario.zh_ops': '中文运维：告警分级',
    'scenario.zh_contract': '中文法务：合同条款审查',
  },
};

export const LANGS = { zh: '中文', en: 'English' };
const KEY = 'decision-demo.lang';

export let lang = detect();

function detect() {
  const fromHub = new URLSearchParams(location.search).get('lang'); // the hub passes its language
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

// Missing keys fall back to English, then to the given fallback (used for scenario titles).
export function t(key, vars, fallback = key) {
  const s = STRINGS[lang][key] ?? STRINGS.en[key] ?? fallback;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
}

export function applyStatic(root = document) {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('doc.title');
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}
