// UI strings. Static markup uses data-i18n / data-i18n-html / data-i18n-aria / data-i18n-title;
// app.js calls t(key, vars) for everything it builds at runtime. Server error messages stay in English.

const STRINGS = {
  en: {
    'doc.title': 'Web IQ',
    'brand.tagline': 'Web grounding for AI: Microsoft Web IQ against the leading search APIs',
    'home.title': 'Back to all demos',
    'lang.label': 'Interface language',
    'header.model': 'Relevance judge: <b>{model}</b> · {host}',
    'header.noModel': 'Relevance judge off',

    'editor.title': 'Question',
    'preset.label': 'Load a scenario',
    'query.label': 'Question or search query',
    'topic.label': 'Search',
    'topic.web': 'Web',
    'topic.news': 'News',
    'market.label': 'Market',
    'market.en-US': 'English · US',
    'market.en-GB': 'English · UK',
    'market.zh-CN': '中文 · China',
    'market.ja-JP': '日本語 · Japan',
    'market.de-DE': 'Deutsch · Germany',
    'count.label': 'Results',
    'chars.label': 'Content per result',
    'settings.hint': 'Every service gets the same query, result count, and content budget (characters per result, where the API has one).',
    'lanes.label': 'Compare',
    'judge.label': 'Relevance judge',
    'judge.hint': 'Grades every result 0–3 without being told which service returned it.',
    'judge.off': 'Off: no relevance grading',
    'judge.llm': '{label} (LLM)',
    'judge.decision': '{label} · {model} (decision model)',
    'btn.run': 'Search all',
    'btn.running': 'Searching…',
    'btn.speed': 'Speed test',
    'btn.speedRunning': 'Testing…',

    'pick.getKey': 'Set {prefix}_API_KEY in webiq/.env',
    'pick.noKey': 'get a key',
    'pick.notConfigured': 'not configured',

    'results.title': 'Results',
    'results.legend': 'Times are measured on this server. <b>Relevance</b> is graded per result by a judge model that isn\'t told which service returned it. Click a column to sort.',
    'results.empty': 'Pick a question and press <b>Search all</b>. Every service gets the same query in parallel; a judge model that isn\'t told the source then grades every result.',

    'col.lane': 'Service',
    'col.search': 'Search',
    'col.searchSub': 'API time',
    'col.relevant': 'Relevance',
    'col.relevantSub': 'results, judge 0–10',
    'col.fresh': 'Freshest',
    'col.freshSub': 'newest useful source',
    'fresh.noUseful': 'no useful results',
    'fresh.noDates': 'no dates',
    'fresh.datedUseful': '{n}/{k} useful dated',
    'fresh.dated': '{n}/{k} dated',
    'fresh.newerCrawl': 'newest crawl {age}, no publish date',
    'fresh.future': '{n} future date ignored',
    'date.future': '(future date, ignored)',
    'fresh.ranked': 'ranked',
    'fresh.unranked': 'not ranked',
    'fresh.whyRanked': 'Ranked: {n} of {k} results have a publish, update, or URL date',
    'fresh.whyFew': 'Not ranked: only {n} of {k} results have a publish or update date, too few to compare',
    'fresh.whyCrawled': 'Not ranked: only crawl dates, which say when the service fetched the page, not when it was written',
    'col.content': 'Content',
    'col.contentSub': 'characters returned',
    'col.cost': 'Cost',
    'col.costSub': 'per 1k searches',
    'date.crawled': 'crawled',
    'date.updated': 'updated',
    'date.url': 'from URL',

    'status.searching': 'searching',
    'status.judging': 'grading relevance…',
    'status.failed': 'failed',

    'card.off': 'Not configured. Set {prefix}_API_KEY in webiq/.env',
    'card.searchTime': 'search {ms}',
    'card.freshIntentYes': 'freshness query: yes',
    'card.freshIntentNo': 'freshness query: no',
    'card.freshIntentTitle': 'Web IQ\'s own signal (querySignals.freshness): whether it decided this query needs fresh documents and ranked them first. The API has no parameter to request it.',
    'card.results': '{n} results',
    'card.context': '{chars} chars of content',
    'card.cost': '{cost} / 1k',
    'card.sources': 'Sources ({n})',
    'card.chars': 'chars',
    'group.news': 'News',
    'group.facts': 'Facts that change',
    'group.compare': 'Several things at once',
    'group.policy': 'Policy and guidance',
    'group.research': 'Research',
    'group.intl': 'Other languages',
    'card.trimmed': 'trimmed from {n}',
    'card.trimmedTitle': 'The service returned more than the content budget per result; it is cut to the budget so every service is compared on the same amount of text.',
    'card.expand': 'Click to show or hide the full text the service returned',
    'card.noResults': 'No results.',
    'rel.g3': 'Judge: states the answer (3)',
    'rel.g2': 'Judge: partly answers (2); counts a third',
    'rel.g1': 'Judge: on topic, but doesn\'t answer or is out of date (1); adds nothing to the score',
    'rel.g0': 'Judge: off topic (0)',
    'rel.dup': 'dup',
    'rel.dupTitle': 'Repeats an earlier result from this service; scores 0',
    'rel.answers': '{n} answering',
    'rel.returned': '{n}/{k} returned',
    'rel.gradedBy': 'Relevance graded by {judge}: {n} results in {s}.',
    'card.relevance': '{n} of {k} results state the answer · each result graded 0–3 by a judge that isn\'t told the service',
    'card.relevanceFailed': 'Relevance grading failed',

    'speed.title': 'Speed test',
    'speed.legend': '{n} sequential searches per service after one warm-up call, all on open connections, for "{query}". Services run in parallel.',
    'speed.aria': 'p50 {p50} ms, p95 {p95} ms',
    'speed.rtt': 'network round trip ~{ms} ms',
    'speed.slower': '{x}× the fastest',
    'speed.key': 'Bar: p50. Tick: p95. Band: fastest to slowest call. Times include the network path from this machine; the round trip is shown so service time can be told apart from distance.',

    'protocol.title': 'On the wire',
    'protocol.empty': 'The exact requests and responses appear here after a run.',
    'wire.search': 'search',
    'wire.request': 'Request',
    'wire.response': 'Response (long text shortened)',

    'age.min': '{n} min ago',
    'age.h': '{n} h ago',
    'age.d': '{n} d ago',

    'notice.unreachable': 'The demo server is not reachable. Start it with npm start in webiq/.',
    'notice.noProvider': 'No search service is configured yet. Fill in WEBIQ_API_KEY (and any competitor keys) in webiq/.env, then restart the server.',
    'notice.noQuery': 'Write a question first.',
    'notice.noLanes': 'Pick at least one service to compare.',
    'notice.serverError': 'Demo server error: {msg}',
  },

  zh: {
    'doc.title': 'Web IQ',
    'brand.tagline': 'AI 联网检索：Microsoft Web IQ 对比主流搜索 API',
    'home.title': '返回所有演示',
    'lang.label': '界面语言',
    'header.model': '相关度评审：<b>{model}</b> · {host}',
    'header.noModel': '相关度评审已关闭',

    'editor.title': '问题',
    'preset.label': '载入场景',
    'query.label': '问题或搜索词',
    'topic.label': '检索',
    'topic.web': '网页',
    'topic.news': '新闻',
    'market.label': '市场',
    'market.en-US': 'English · 美国',
    'market.en-GB': 'English · 英国',
    'market.zh-CN': '中文 · 中国',
    'market.ja-JP': '日本語 · 日本',
    'market.de-DE': 'Deutsch · 德国',
    'count.label': '结果数',
    'chars.label': '每条内容长度',
    'settings.hint': '所有服务收到相同的查询、结果数和内容长度（每条结果的字符上限，API 支持时）。',
    'lanes.label': '参与对比',
    'judge.label': '相关度评审',
    'judge.hint': '给每条结果打 0–3 分，评审不知道结果来自哪个服务。',
    'judge.off': '关闭：不评相关度',
    'judge.llm': '{label}（大模型）',
    'judge.decision': '{label} · {model}（决策模型）',
    'btn.run': '全部检索',
    'btn.running': '检索中…',
    'btn.speed': '速度测试',
    'btn.speedRunning': '测试中…',

    'pick.getKey': '在 webiq/.env 中设置 {prefix}_API_KEY',
    'pick.noKey': '申请 key',
    'pick.notConfigured': '未配置',

    'results.title': '结果',
    'results.legend': '耗时在本机服务器上测量。<b>相关度</b>由评审模型逐条打分，评审不知道结果来自哪个服务。点击列名可排序。',
    'results.empty': '选一个问题，点击<b>全部检索</b>。所有服务并行收到相同的查询，再由不知道来源的评审模型给每条结果打分。',

    'col.lane': '服务',
    'col.search': '检索',
    'col.searchSub': 'API 耗时',
    'col.relevant': '相关度',
    'col.relevantSub': '检索结果，评审 0–10',
    'col.fresh': '最新',
    'col.freshSub': '最新的有用来源',
    'fresh.noUseful': '没有有用结果',
    'fresh.noDates': '没有日期',
    'fresh.datedUseful': '有用结果 {n}/{k} 带日期',
    'fresh.dated': '{n}/{k} 带日期',
    'fresh.newerCrawl': '最新抓取 {age}，无发布日期',
    'fresh.future': '{n} 个未来日期已忽略',
    'date.future': '（未来日期，已忽略）',
    'fresh.ranked': '参与排名',
    'fresh.unranked': '不参与排名',
    'fresh.whyRanked': '参与排名：{k} 条结果中 {n} 条有发布、更新或网址中的日期',
    'fresh.whyFew': '不参与排名：{k} 条结果中只有 {n} 条有发布或更新日期，不足以比较',
    'fresh.whyCrawled': '不参与排名：只有抓取日期，表示服务抓取页面的时间，而不是内容的发布时间',
    'col.content': '内容',
    'col.contentSub': '返回的字符数',
    'col.cost': '成本',
    'col.costSub': '每千次检索',
    'date.crawled': '抓取',
    'date.updated': '更新',
    'date.url': '取自网址',

    'status.searching': '检索中',
    'status.judging': '相关度评审中…',
    'status.failed': '失败',

    'card.off': '未配置。请在 webiq/.env 中设置 {prefix}_API_KEY',
    'card.searchTime': '检索 {ms}',
    'card.freshIntentYes': '时效性查询：是',
    'card.freshIntentNo': '时效性查询：否',
    'card.freshIntentTitle': 'Web IQ 自己的判断（querySignals.freshness）：是否认为这个查询需要最新内容并优先排序。API 没有参数可以指定。',
    'card.results': '{n} 条结果',
    'card.context': '内容 {chars} 字符',
    'card.cost': '{cost} / 千次',
    'card.sources': '来源（{n}）',
    'card.chars': '字符',
    'group.news': '新闻',
    'group.facts': '经常变化的事实',
    'group.compare': '一次问多项',
    'group.policy': '政策与指引',
    'group.research': '研究',
    'group.intl': '其他语言',
    'card.trimmed': '原 {n}，已截断',
    'card.trimmedTitle': '服务返回的内容超过了每条结果的长度上限，已截到上限，让各服务在相同的文本量上比较。',
    'card.expand': '点击展开或收起服务返回的全文',
    'card.noResults': '没有结果。',
    'rel.g3': '评审：直接给出答案（3）',
    'rel.g2': '评审：部分回答（2），按三分之一计分',
    'rel.g1': '评审：切题，但没有回答或内容过时（1），不计分',
    'rel.g0': '评审：不相关（0）',
    'rel.dup': '重复',
    'rel.dupTitle': '与该服务前面的某条结果重复，计 0 分',
    'rel.answers': '{n} 条命中',
    'rel.returned': '仅返回 {n}/{k} 条',
    'rel.gradedBy': '相关度由 {judge} 评审：{n} 条结果，用时 {s}。',
    'card.relevance': '{k} 条结果中 {n} 条直接给出答案 · 每条结果由评审打 0–3 分，评审不知道来自哪个服务',
    'card.relevanceFailed': '相关度评审失败',

    'speed.title': '速度测试',
    'speed.legend': '每个服务先预热一次，再连续检索 {n} 次，均复用已建立的连接；查询为「{query}」。各服务并行测试。',
    'speed.aria': 'p50 {p50} ms，p95 {p95} ms',
    'speed.rtt': '网络往返 ~{ms} ms',
    'speed.slower': '是最快的 {x} 倍',
    'speed.key': '实心条：p50。竖线：p95。浅色带：最快到最慢。耗时包含本机到服务的网络路径；同时给出网络往返时间，以区分服务本身的耗时和距离带来的耗时。',

    'protocol.title': '线上报文',
    'protocol.empty': '运行后，这里会显示原始请求和响应。',
    'wire.search': '检索',
    'wire.request': '请求',
    'wire.response': '响应（长文本已截断）',

    'age.min': '{n} 分钟前',
    'age.h': '{n} 小时前',
    'age.d': '{n} 天前',

    'notice.unreachable': '无法连接演示服务器。请在 webiq/ 中运行 npm start。',
    'notice.noProvider': '还没有配置任何检索服务。请在 webiq/.env 中填写 WEBIQ_API_KEY（以及竞品的 key），然后重启服务器。',
    'notice.noQuery': '请先填写问题。',
    'notice.noLanes': '请至少选择一个参与对比的服务。',
    'notice.serverError': '演示服务器出错：{msg}',

    'scenario.ai_week': '本周 AI 动态（新闻）',
    'scenario.node': '最新软件版本',
    'scenario.f1': '最近一场比赛结果',
    'scenario.phones': '多产品对比',
    'scenario.markets': '股市：最近一个交易日（新闻）',
    'scenario.fed': '利率（官方数据）',
    'scenario.earnings': '财报数字',
    'scenario.wage': '同一事实，多个地区',
    'scenario.eu_ai_act': '法规：欧盟 AI 法案',
    'scenario.visa': '出行规定',
    'scenario.flu': '健康指引',
    'scenario.uk_energy': '英国：能源价格上限',
    'scenario.rag': '研究主题',
    'scenario.zh_ev': '中文：新能源汽车新闻',
    'scenario.zh_tax': '中文：个税政策',
    'scenario.ja_boj': '日语：日本央行利率',
    'scenario.de_wage': '德语：最低工资',
  },
};

export const LANGS = { zh: '中文', en: 'English' };
const KEY = 'webiq-demo.lang';

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
