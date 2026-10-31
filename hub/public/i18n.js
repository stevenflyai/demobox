// UI strings. Static markup uses data-i18n / data-i18n-html / data-i18n-aria;
// app.js calls t(key, vars) for everything it builds at runtime.

const STRINGS = {
  en: {
    'doc.title': 'DemoBox',
    'brand.tagline': 'Live demos of AI services',
    'lang.label': 'Interface language',
    'nav.label': 'Microsoft Foundry Demos',

    'add.title': 'Add a demo',
    'add.body': 'Create a folder with a <code>package.json</code> whose <code>npm start</code> serves a page and <code>GET /api/config</code> returning <code>{ "ready": true }</code>, then add an entry to <code>demos.json</code>. See <code>AGENTS.md</code> for the full checklist.',

    'btn.reload': 'Reload demo',
    'btn.newTab': 'Open in a new tab',
    'btn.start': 'Start',
    'btn.starting': 'Starting…',
    'btn.stop': 'Stop',
    'log.title': 'Output',
    'empty.stopped': 'Start it to use it here.',
    'empty.starting': 'Starting. The demo appears here when it is ready.',
    'empty.foreign': 'Another app is using port {port}. Stop it, or change PORT in this demo\'s .env.',
    'empty.none': 'No demos found in demos.json.',
    'hint.env': 'Edit <code>{file}</code>, then restart the demo.',

    'status.working': 'Working…',
    'status.installing': 'Installing packages',
    'status.foreign': 'Port {port} is used by another app',
    'status.running': 'Running',
    'status.setup': 'Running · needs setup',
    'status.starting': 'Starting',
    'status.exited': 'Exited with code {code}',
    'status.stopped': 'Stopped',

    'notice.unreachable': 'The hub server is not reachable. Start it with npm start in the demobox folder.',
  },

  zh: {
    'doc.title': 'DemoBox',
    'brand.tagline': 'AI 服务现场演示',
    'lang.label': '界面语言',
    'nav.label': 'Microsoft Foundry 演示',

    'add.title': '添加演示',
    'add.body': '新建一个文件夹，其中 <code>package.json</code> 的 <code>npm start</code> 提供一个页面，并实现返回 <code>{ "ready": true }</code> 的 <code>GET /api/config</code>，然后在 <code>demos.json</code> 中添加一项。完整清单见 <code>AGENTS.md</code>。',

    'btn.reload': '重新加载演示',
    'btn.newTab': '在新标签页中打开',
    'btn.start': '启动',
    'btn.starting': '正在启动…',
    'btn.stop': '停止',
    'log.title': '输出',
    'empty.stopped': '启动后即可在这里使用。',
    'empty.starting': '正在启动，就绪后会显示在这里。',
    'empty.foreign': '端口 {port} 已被其他应用占用。请停止该应用，或修改此演示 .env 中的 PORT。',
    'empty.none': 'demos.json 中没有演示。',
    'hint.env': '编辑 <code>{file}</code>，然后重启该演示。',

    'status.working': '处理中…',
    'status.installing': '正在安装依赖',
    'status.foreign': '端口 {port} 已被其他应用占用',
    'status.running': '运行中',
    'status.setup': '运行中 · 需要配置',
    'status.starting': '正在启动',
    'status.exited': '已退出，代码 {code}',
    'status.stopped': '已停止',

    'notice.unreachable': '无法连接 Hub 服务器。请在 demobox 文件夹中运行 npm start。',
  },
};

export const LANGS = { zh: '中文', en: 'English' };
const KEY = 'demobox.lang';

export let lang = detect();

function detect() {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (fromUrl && STRINGS[fromUrl]) return fromUrl;
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
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}
