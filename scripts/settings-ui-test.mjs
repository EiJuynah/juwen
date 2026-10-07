/**
 * 设置页 UI 测试：验证「设置」按钮能打开设置页、两档「解读口径」能切、切换会打到服务端、
 * 联网开关的可用性受档位与服务端能力约束。
 *
 * 这里把 fetch 打桩，不依赖后端在跑。
 *
 *   node --experimental-vm-modules node_modules/.bin/vite-node --config web/vite.config.js scripts/settings-ui-test.mjs
 * （实际由 npm run test:web 调用，已带好 --config）
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5179/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const [k, v] of Object.entries({
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Range: dom.window.Range,
  MutationObserver: dom.window.MutationObserver,
  DOMParser: dom.window.DOMParser,
})) {
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}
globalThis.getSelection = dom.window.getSelection.bind(dom.window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const zeroRect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
dom.window.Element.prototype.getClientRects = function () {
  return Object.assign([zeroRect], { item: () => zeroRect });
};
dom.window.Element.prototype.getBoundingClientRect = function () {
  return { ...zeroRect, toJSON: () => zeroRect };
};
dom.window.Range.prototype.getClientRects = function () {
  return Object.assign([zeroRect], { item: () => zeroRect });
};
dom.window.Range.prototype.getBoundingClientRect = function () {
  return { ...zeroRect, toJSON: () => zeroRect };
};

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---------- fetch 打桩 ----------
// 契约 §2：GET /api/settings 必须给 profile 与 profileOptions，档位文案由服务端下发
const OPT_EXPLAIN = { value: 'explain', label: '讲透', desc: '把话讲透，术语当场讲清、可补背景，补充会标注为补充。' };
const OPT_STRICT = { value: 'strict', label: '严格依据', desc: '只用原文作答，逐条标出依据段落，要写材料、要经得起对照时用。' };

const serverState = {
  enabled: true,
  profile: 'explain', // 默认档：讲透
  model: 'deepseek-flash',
  effort: 'low',
  effortLevels: ['off', 'low', 'medium', 'high'],
  limits: { maxTextChars: 4000, maxParagraphChars: 8000, maxDepth: 6, temperature: 0.3 },
  profileOptions: [OPT_EXPLAIN, OPT_STRICT],
  // 联网检索：能力已具备，但默认没打开；且严格依据档强制不可用
  searchEnabled: false,
  searchAvailable: true,
  searchInfo: {
    provider: 'bocha',
    configured: true,
    open: false,
    allowedDomains: ['gov.cn', 'npc.gov.cn', 'news.cn'],
    limits: { maxResults: 5 },
  },
};
const posted = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/api/settings')) {
    if (opts.method === 'POST') {
      const patch = JSON.parse(opts.body || '{}');
      posted.push(patch);
      Object.assign(serverState, patch);
      return jsonResp(serverState);
    }
    return jsonResp(serverState);
  }
  return jsonResp({});
};

function jsonResp(obj) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const openSettings = async () => {
  const btn = [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent.includes('设置'));
  btn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick();
};

console.log('\n设置页 UI 测试\n');

const { createRoot } = await import('react-dom/client');
const React = await import('react');
const { default: App } = await import('../web/src/App.jsx');

const container = dom.window.document.getElementById('root');
const root = createRoot(container);
root.render(React.createElement(App));
await tick(1200);

console.log('▸ 入口');
{
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('设置'));
  check('顶栏存在「设置」按钮', Boolean(btn), container.querySelector('.topbar-meta')?.textContent);

  const modeChip = container.querySelector('.mode-chip');
  check('顶栏显示当前档位', Boolean(modeChip), modeChip?.textContent);
  check('初始档位为「讲透」（默认）', modeChip?.textContent.trim() === '讲透', modeChip?.textContent);
  check('顶栏 chip 用 explain 类名（旧 on/off 已删）', Boolean(container.querySelector('.mode-chip.explain')), modeChip?.className);
  check('顶栏不再有旧类名 .mode-chip.on/.off', !container.querySelector('.mode-chip.on') && !container.querySelector('.mode-chip.off'));
  check('档位说明按档给出', (modeChip?.getAttribute('title') ?? '').includes('讲透'), modeChip?.getAttribute('title'));

  check('设置页初始未展开', !container.querySelector('.modal-settings'), '');

  await openSettings();
}

console.log('\n▸ 设置页内容');
{
  const dialog = container.querySelector('.modal-settings');
  check('点击后弹出设置页', Boolean(dialog));

  if (dialog) {
    const text = dialog.textContent;
    check('含「启用 AI 解释」', text.includes('启用 AI 解释'));
    check('含两档档位名（来自 profileOptions）', text.includes(OPT_EXPLAIN.label) && text.includes(OPT_STRICT.label));
    check('含模型名输入', Boolean(dialog.querySelector('input.set-input')));
    check('含推理强度下拉', Boolean(dialog.querySelector('select.set-input')));
    check('推理强度提示指向严格依据档', text.includes('严格依据档建议低或以上'), text.match(/[^。]*严格依据档[^。]*/)?.[0]);
    check('展示服务端限额', text.includes('4000') && text.includes('6 层'), text.match(/[^。]*限额[^。]*/)?.[0]?.slice(0, 60));

    const switches = dialog.querySelectorAll('input.switch');
    // 设置页现在有两个开关：AI 总开关 + 联网检索（两者语义完全不同）
    check('设置页有 AI 总开关与联网检索两个开关', switches.length === 2, `实际 ${switches.length}`);
    check('AI 总开关可精确定位', Boolean(dialog.querySelector('input.switch[data-field="enabled"]')));
    check('联网检索开关可精确定位', Boolean(dialog.querySelector('input.switch[data-field="searchEnabled"]')));

    const modeOpts = dialog.querySelectorAll('.mode-opt');
    check('解读口径有两档可点选', modeOpts.length === 2, `实际 ${modeOpts.length}`);
  }
}

console.log('\n▸ 切换解读口径（讲透 ↔ 严格依据）');
{
  const dialog = container.querySelector('.modal-settings');
  const opts = () => [...dialog.querySelectorAll('.mode-opt')];
  const profilePosts = () => posted.filter((p) => 'profile' in p);

  check('第一张卡是「讲透」', opts()[0]?.querySelector('b')?.textContent === OPT_EXPLAIN.label, opts()[0]?.textContent);
  check('第二张卡是「严格依据」', opts()[1]?.querySelector('b')?.textContent === OPT_STRICT.label, opts()[1]?.textContent);
  check('卡片描述逐字取自 profileOptions[0].desc', opts()[0]?.querySelector('span')?.textContent === OPT_EXPLAIN.desc, opts()[0]?.querySelector('span')?.textContent);
  check('卡片描述逐字取自 profileOptions[1].desc', opts()[1]?.querySelector('span')?.textContent === OPT_STRICT.desc, opts()[1]?.querySelector('span')?.textContent);

  check('第一张卡默认选中', opts()[0]?.classList.contains('on') && opts()[0]?.getAttribute('aria-checked') === 'true', opts()[0]?.className);
  check('第二张卡未选中', opts()[1]?.getAttribute('aria-checked') === 'false', opts()[1]?.getAttribute('aria-checked'));

  opts()[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(200);

  const post = profilePosts().at(-1);
  check('切换后发出设置请求', Boolean(post), JSON.stringify(posted));
  check('请求体只带 profile，且值为 strict', post ? post.profile === 'strict' && !('constraints' in post) : false, JSON.stringify(post));
  check('请求体不再发送旧的 constraints 字段', !posted.some((p) => 'constraints' in p), JSON.stringify(posted));
  check('「严格依据」变为选中态', opts()[1]?.classList.contains('on') && opts()[1]?.getAttribute('aria-checked') === 'true', opts()[1]?.className);

  const modeChip = container.querySelector('.mode-chip');
  check('顶栏档位跟着变为「严格依据」', modeChip?.textContent.trim() === '严格依据', modeChip?.textContent);
  check('顶栏 chip 换成 strict 类名', Boolean(container.querySelector('.mode-chip.strict')), modeChip?.className);
  check('严格依据档的 chip 说明另有一套', (modeChip?.getAttribute('title') ?? '').includes('只引用本文件原文'), modeChip?.getAttribute('title'));

  // 再切回来
  opts()[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(200);
  check('可切回「讲透」', opts()[0]?.classList.contains('on'));
  check('回切请求为 profile=explain', profilePosts().at(-1)?.profile === 'explain', JSON.stringify(profilePosts().at(-1)));
}

console.log('\n▸ AI 总开关影响口径选择可用性');
{
  const dialog = container.querySelector('.modal-settings');
  const aiSwitch = dialog.querySelector('input.switch[data-field="enabled"]');
  const opts = () => [...dialog.querySelectorAll('.mode-opt')];

  aiSwitch.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(200);
  check('关闭 AI 后请求已发出', posted.some((p) => p.enabled === false), JSON.stringify(posted.at(-1)));
  check('档位选项随之被禁用（避免无意义操作）', opts().every((o) => o.disabled === true));

  aiSwitch.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(200);
  check('恢复 AI 后档位选项可用', opts().every((o) => o.disabled === false));
}

console.log('\n▸ 联网检索开关');
{
  const dialog = container.querySelector('.modal-settings');
  const searchSwitch = () => dialog.querySelector('input.switch[data-field="searchEnabled"]');
  const modeOpts = () => [...dialog.querySelectorAll('.mode-opt')];
  const optFor = (label) => modeOpts().find((o) => o.textContent.includes(label));

  check('联网开关存在', Boolean(searchSwitch()));

  // 当前是讲透档：能力具备时开关应当可点
  check('讲透档下联网开关可用', searchSwitch()?.disabled === false, String(searchSwitch()?.disabled));

  // 切到严格依据 → 必须禁用并说明原因：该档靠「只依据原文 + 逐条标依据」立身
  optFor(OPT_STRICT.label)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);
  check('严格依据档下联网开关被禁用', searchSwitch()?.disabled === true, String(searchSwitch()?.disabled));
  check('并说明原因（严格依据档不联网）', dialog.textContent.includes('严格依据档不联网'), dialog.textContent.match(/[^。]*不联网[^。]*/)?.[0]);
  check('顶栏不显示联网标签', !container.querySelector('.net-chip'));

  // 切回讲透 → 开关恢复可用
  optFor(OPT_EXPLAIN.label)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);
  check('切回讲透后联网开关可用', searchSwitch()?.disabled === false, String(searchSwitch()?.disabled));

  // 打开联网
  searchSwitch()?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);
  const netPost = posted.filter((p) => 'searchEnabled' in p).at(-1);
  check('打开联网后发出设置请求', Boolean(netPost), JSON.stringify(posted));
  check('请求内容为 searchEnabled=true', netPost?.searchEnabled === true, JSON.stringify(netPost));
  check('顶栏出现「联网检索」标签', Boolean(container.querySelector('.net-chip')), container.querySelector('.topbar-meta')?.textContent);

  // 切回严格依据 → 标签消失（searchEnabled 仍为 true，只是本轮档位不生效）
  optFor(OPT_STRICT.label)?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);
  check('切回严格依据后联网标签消失（档位优先）', !container.querySelector('.net-chip'), container.querySelector('.topbar-meta')?.textContent);
  check('但用户的选择没被悄悄改掉', serverState.searchEnabled === true, String(serverState.searchEnabled));
}

console.log('\n▸ 档位文案必须来自服务端（不得硬编码）');
{
  // 把服务端下发的档位文案换成哨兵值：如果界面还显示「讲透 / 严格依据」，
  // 说明前端写死了档位名，契约 §3 被违反。
  serverState.profileOptions = [
    { value: 'explain', label: '档位甲', desc: '甲档说明文字。' },
    { value: 'strict', label: '档位乙', desc: '乙档说明文字。' },
  ];
  root.unmount();
  const rootSentinel = createRoot(container);
  rootSentinel.render(React.createElement(App));
  await tick(1200);
  await openSettings();

  const dialog = container.querySelector('.modal-settings');
  const picker = dialog?.querySelector('.mode-picker');
  const opts = [...(picker?.querySelectorAll('.mode-opt') ?? [])];
  check('渲染出哨兵档位名', opts.map((o) => o.querySelector('b')?.textContent).join(',') === '档位甲,档位乙', opts.map((o) => o.textContent).join(' | '));
  check('渲染出哨兵档位描述', opts[0]?.querySelector('span')?.textContent === '甲档说明文字。', opts[0]?.querySelector('span')?.textContent);
  check('档位卡片未写死「讲透 / 严格依据」', !(picker?.textContent ?? '').includes('讲透') && !(picker?.textContent ?? '').includes('严格依据'), (picker?.textContent ?? '').slice(0, 60));
  rootSentinel.unmount();

  // 恢复契约文案，供最后一节复用
  serverState.profileOptions = [OPT_EXPLAIN, OPT_STRICT];
}

console.log('\n▸ 服务端未配置检索服务');
{
  // 换一个「能力不具备」的服务端：开关必须禁用并说明原因，而不是让用户点了没反应
  serverState.searchAvailable = false;
  serverState.searchInfo = null;
  const root2 = createRoot(container);
  root2.render(React.createElement(App));
  await tick(1200);
  await openSettings();

  const dialog = container.querySelector('.modal-settings');
  const searchSwitch = dialog?.querySelector('input.switch[data-field="searchEnabled"]');
  check('未配置时联网开关禁用', searchSwitch?.disabled === true, String(searchSwitch?.disabled));
  check('并提示服务端未配置', (dialog?.textContent ?? '').includes('SEARCH_PROVIDER'), dialog?.textContent?.slice(0, 40));
  root2.unmount();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
