/**
 * 运行时冒烟测试：在 jsdom 里真实挂载 React 应用。
 * 目的不是替代 e2e，而是抓 curl 看不见的运行期错误 ——
 * 尤其是 hooks 顺序违规、TDZ 引用、未捕获异常导致的白屏。
 *
 *   node scripts/smoke-render.mjs
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5179/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 22 起 navigator 是 getter-only 全局，必须 defineProperty 覆盖
for (const [key, value] of Object.entries({
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Range: dom.window.Range,
  MutationObserver: dom.window.MutationObserver,
  DOMParser: dom.window.DOMParser,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
globalThis.getSelection = dom.window.getSelection.bind(dom.window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

// 只拦截 /api/settings，把服务端设置固定成默认档「讲透」，
// 免得冒烟结果受运行中的后端影响；其余请求维持原样（相对 URL 在 Node 下会失败，
// 应用内部已 catch，沿用默认状态即可）。
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/api/settings')) {
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        enabled: true, profile: 'explain', model: '', effort: 'low',
        effortLevels: ['off', 'low', 'medium', 'high'], limits: null,
        profileOptions: [
          { value: 'explain', label: '讲透', desc: '把话讲透，术语当场讲清、可补背景，补充会标注为补充。' },
          { value: 'strict', label: '严格依据', desc: '只用原文作答，逐条标出依据段落，要写材料、要经得起对照时用。' },
        ],
        searchEnabled: false, searchAvailable: false, searchInfo: null,
      }),
      text: async () => '',
    };
  }
  return realFetch(url, opts);
};

// 收集页面级错误：白屏往往就是这里被吞掉的异常
const pageErrors = [];
dom.window.addEventListener('error', (e) => pageErrors.push(String(e.error || e.message)));
process.on('unhandledRejection', (e) => pageErrors.push('unhandledRejection: ' + String(e)));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n前端运行时冒烟测试（jsdom）\n');

const { createRoot } = await import('react-dom/client');
const React = await import('react');
const { default: App } = await import('../web/src/App.jsx');

const container = dom.window.document.getElementById('root');
const root = createRoot(container);

// 捕获 console.error：React 会把渲染错误打到这里
const origError = console.error;
const reactErrors = [];
console.error = (...args) => {
  reactErrors.push(args.map(String).join(' '));
  origError(...args);
};

let threw = null;
try {
  root.render(React.createElement(App));
} catch (e) {
  threw = e;
}

check('挂载过程未同步抛错', threw === null, threw ? String(threw.message) : '');

// 等待 effects 与编辑器初始化
await new Promise((r) => setTimeout(r, 1200));

console.error = origError;

const html = container.innerHTML;
check('根节点已渲染内容', html.length > 0, `innerHTML 长度 ${html.length}`);
check('不是 boot 占位（编辑器已就绪）', !html.includes('正在载入文稿'), html.slice(0, 120));
check('标题已渲染', html.includes('智能解读工作台'));
// 服务端给的是默认档 explain，顶栏 chip 必须按两档类名渲染成「讲透」
check('顶栏档位 chip 按 explain 档渲染', Boolean(container.querySelector('.mode-chip.explain')) && html.includes('讲透'), container.querySelector('.topbar-meta')?.textContent);
check('开屏为空态，不预置内置示例', !html.includes('青年人才') && !html.includes('人才公寓'));
check('空态提示已渲染', html.includes('还没有打开文档'));
check('侧边栏空态已渲染', html.includes('还没有批注') || html.includes('批注与解读'));

const hasReactError = reactErrors.some((m) =>
  /Rendered fewer hooks|Rendered more hooks|Cannot access '.*' before initialization|is not a function|Invalid hook call/i.test(m),
);
check('无 hooks/TDZ 类致命错误', !hasReactError,
  hasReactError ? reactErrors.find((m) => /hooks|TDZ|before initialization|not a function/i.test(m))?.slice(0, 200) : '');

check('无未捕获页面错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ').slice(0, 300));

// 开屏不再预置内置示例，正文应当是空的（data-pid 只在载入文档后才会出现）
const pids = [...container.querySelectorAll('[data-pid]')].map((el) => el.getAttribute('data-pid'));
check('开屏正文为空（无 data-pid）', pids.length === 0, `实际 ${pids.length} 个`);

root.unmount();
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
