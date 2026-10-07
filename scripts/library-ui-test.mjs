/**
 * 文档库面板 UI 测试：渲染、涉密提示、收起/展开。
 * fetch 打桩，不依赖后端。
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
globalThis.localStorage = dom.window.localStorage;

const zeroRect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
for (const Cls of [dom.window.Element, dom.window.Range]) {
  Cls.prototype.getClientRects = function () {
    return Object.assign([zeroRect], { item: () => zeroRect });
  };
  Cls.prototype.getBoundingClientRect = function () {
    return { ...zeroRect, toJSON: () => zeroRect };
  };
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---------- fetch 打桩 ----------
const FOLDER = { id: 'f1', name: '党内法规', parentId: null, createdAt: 1 };
const DOCS = [
  {
    id: 'd1', name: '中国共产党统一战线工作条例.wps', ext: 'wps', size: 75264,
    folderId: 'f1', level: 'public', format: 'ole-word', formatLabel: 'Word 文档（97-2003 二进制）',
    supported: true, title: '中国共产党统一战线工作条例', stats: { chapters: 14, articles: 61 },
  },
  {
    id: 'd2', name: '内部文件.txt', ext: 'txt', size: 100,
    folderId: null, level: 'internal', format: 'text', formatLabel: '纯文本',
    supported: true, title: '内部文件',
  },
  {
    id: 'd3', name: '坏文件.bin', ext: 'bin', size: 8,
    folderId: null, level: 'public', format: 'unknown', formatLabel: '未知格式',
    supported: false, reason: '未能识别文件内容，请确认文件未损坏、未加密', title: '坏文件.bin',
  },
];
const POLICY = {
  title: '中国共产党统一战线工作条例',
  meta: '2015年4月30日中共中央政治局会议审议批准',
  sections: [
    {
      id: 'P-1',
      heading: '第一章　总则',
      clauses: [
        { id: 'P-1-1', text: '第一条　为了加强党对统一战线工作的集中统一领导。' },
        { id: 'P-1-2', text: '第二条　本条例所称统一战线，是指中国共产党领导的、以工农联盟为基础的广泛的爱国统一战线。' },
      ],
    },
  ],
};

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push(`${opts.method ?? 'GET'} ${u}`);
  const json = (o) => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => o, text: async () => JSON.stringify(o),
  });
  if (u.includes('/api/settings')) {
    // 这里用「严格依据」档：本用例会载入文档并断言提示条，正好覆盖 strict 那一支文案；
    // 顶栏 chip 的 explain 分支由 smoke-render/settings-ui-test 覆盖
    return json({
      enabled: true, profile: 'strict', model: 'deepseek-flash', effort: 'low',
      effortLevels: ['off', 'low'], limits: { maxTextChars: 4000, maxDepth: 6 },
      profileOptions: [
        { value: 'explain', label: '讲透', desc: '把话讲透，术语当场讲清、可补背景，补充会标注为补充。' },
        { value: 'strict', label: '严格依据', desc: '只用原文作答，逐条标出依据段落，要写材料、要经得起对照时用。' },
      ],
    });
  }
  if (u.includes('/api/files/tree')) return json({ folders: [FOLDER], docs: DOCS });
  if (u.match(/\/api\/files\/[^/]+$/)) {
    const id = u.split('/').pop();
    return json({ doc: DOCS.find((d) => d.id === id), policy: POLICY, warnings: [] });
  }
  return json({});
};

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

console.log('\n文档库面板 UI 测试\n');

const { createRoot } = await import('react-dom/client');
const React = await import('react');
const { default: App } = await import('../web/src/App.jsx');

const container = dom.window.document.getElementById('root');
const root = createRoot(container);
root.render(React.createElement(App));
await tick(1200);

console.log('▸ 面板渲染');
{
  const pane = container.querySelector('.lib-pane');
  check('文档库面板已渲染', Boolean(pane));

  const text = pane?.textContent ?? '';
  check('显示文件夹', text.includes('党内法规'));
  check('存在文档数徽标', Boolean(container.querySelector('.lib-count-total')));

  // 文件夹默认收起，只显示根目录下的文档
  check('根目录文档直接可见', text.includes('坏文件.bin'));
  check('收起时文件夹内文档不渲染', !text.includes('统一战线工作条例'));

  // 展开文件夹
  const folderRow = container.querySelector('.lib-folder');
  folderRow?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);

  check('展开后显示文件夹内文档', container.querySelector('.lib-pane').textContent.includes('统一战线工作条例'));
  const docRows = container.querySelectorAll('.lib-doc');
  check('列出全部 3 个文档', docRows.length === 3, `实际 ${docRows.length}`);
  // 密级已整体取消（上传不再选密级、列表不再打「内部」标记）
  check('不再显示「内部」密级标记', !container.querySelector('.lib-tags .tag.internal'));
  check('上传区不再有密级选择', !container.querySelector('.lib-upload-opts')?.textContent.includes('密级'));
  check('不可解析文档带标记', container.querySelector('.lib-pane').textContent.includes('不可解析'));
}

console.log('\n▸ 涉密提示');
{
  const notice = container.querySelector('.lib-secret-notice');
  check('存在涉密提示条', Boolean(notice));
  check('文案为「禁止上传涉密文档」', notice?.textContent.trim() === '禁止上传涉密文档', notice?.textContent);
}

console.log('\n▸ 收起 / 展开');
{
  const collapseBtn = container.querySelector('.lib-collapse');
  check('存在收起按钮', Boolean(collapseBtn));

  collapseBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);

  check('收起后面板消失', !container.querySelector('.lib-pane'));
  const rail = container.querySelector('.lib-rail');
  check('出现窄边条', Boolean(rail));
  check('边条上有入口文字', rail?.textContent.includes('文档库'), rail?.textContent);
  check('layout 带上收起类名', Boolean(container.querySelector('.layout.lib-collapsed')));
  check('收起状态已写入 localStorage', dom.window.localStorage.getItem('freadtool.libCollapsed') === '1');

  rail?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);

  check('点边条可重新展开', Boolean(container.querySelector('.lib-pane')));
  check('展开后窄边条消失', !container.querySelector('.lib-rail'));
  check('localStorage 状态已更新', dom.window.localStorage.getItem('freadtool.libCollapsed') === '0');
}

console.log('\n▸ 右侧批注栏收起 / 展开');
{
  check('默认展开批注栏', Boolean(container.querySelector('.side-pane')));
  check('无右侧窄边条', !container.querySelector('.side-rail'));

  const collapseBtn = container.querySelector('.side-collapse');
  check('存在收起按钮', Boolean(collapseBtn));

  collapseBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);

  check('收起后批注栏消失', !container.querySelector('.side-pane'));
  const rail = container.querySelector('.side-rail');
  check('出现右侧窄边条', Boolean(rail));
  check('边条上有入口文字', rail?.textContent.includes('批注'), rail?.textContent);
  check('layout 带上 side-collapsed', Boolean(container.querySelector('.layout.side-collapsed')));
  check('状态已写入 localStorage', dom.window.localStorage.getItem('freadtool.sideCollapsed') === '1');

  rail?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);

  check('点边条可重新展开', Boolean(container.querySelector('.side-pane')));
  check('展开后边条消失', !container.querySelector('.side-rail'));

  // 两侧同时收起应互不影响
  container.querySelector('.lib-collapse')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  container.querySelector('.side-collapse')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);
  check('两侧可同时收起', Boolean(container.querySelector('.layout.lib-collapsed.side-collapsed')),
    container.querySelector('.layout')?.className);
  check('两侧边条同时存在', Boolean(container.querySelector('.lib-rail') && container.querySelector('.side-rail')));

  // 还原，避免影响后续断言
  container.querySelector('.lib-rail')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  container.querySelector('.side-rail')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);
  check('可全部还原为展开', !container.querySelector('.lib-rail') && !container.querySelector('.side-rail'));
}

console.log('\n▸ 点击文档载入');
{
  // 收起/展开会让 LibraryPane 卸载重建，文件夹展开状态随之重置，这里重新展开
  const folderRow = container.querySelector('.lib-folder');
  folderRow?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);

  const docRow = [...container.querySelectorAll('.lib-doc')].find((el) =>
    el.textContent.includes('统一战线工作条例'),
  );
  check('找到目标文档行', Boolean(docRow));

  docRow?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(400);

  check('发出了文档详情请求', calls.some((c) => c.includes('/api/files/d1')), calls.filter((c) => c.includes('/api/files/')).join(' | '));
  const heading = container.querySelector('.doc-head h2')?.textContent ?? '';
  check('标题切换为文档标题', heading.includes('统一战线工作条例'), heading);
  const meta = container.querySelector('.doc-meta');
  check('不再渲染副标题', !meta, meta?.textContent ?? '');
}

// 开屏为空态（不预置内置示例），标题区与操作提示条都要等文档载入后才出现，
// 因此这一组断言必须放在「点击文档载入」之后。
console.log('\n▸ 操作提示条可关闭');
{
  const hint = container.querySelector('.doc-hint');
  check('载入文档后默认显示操作提示', Boolean(hint));
  // 本用例的 mock 是严格依据档（strict）：提示条必须走「只依原文、逐条标依据」那一套文案，
  // 且不能带讲透档的暖色类名
  check('提示条按严格依据档给文案', (hint?.textContent ?? '').includes('严格依据') && (hint?.textContent ?? '').includes('逐条标出依据段落'), hint?.textContent?.slice(0, 60));
  check('提示条不带讲透档的 explain 类名', !hint?.classList.contains('explain'), hint?.className);
  check('严格依据档提示条不提联网', !(hint?.textContent ?? '').includes('联网'), hint?.textContent?.slice(0, 60));

  const closeBtn = hint?.querySelector('.hint-close');
  check('存在关闭按钮', Boolean(closeBtn));
  check('关闭按钮文案为 ×', closeBtn?.textContent.trim() === '×', closeBtn?.textContent);

  closeBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);

  check('点击后提示条消失', !container.querySelector('.doc-hint'));
  check('关闭状态已写入 localStorage', dom.window.localStorage.getItem('freadtool.hintClosed') === '1');
}

console.log('\n▸ 引用编号识别（中文条号）');
{
  // 真实条例测试暴露的问题：模型常引用「第二条」而非 [P-1-2]，
  // 只认 [P-x] 会导致引用标签不显示、点击回查失效
  const debug = dom.window.__policyDebug ?? globalThis.window.__policyDebug;
  check('调试钩子可用', Boolean(debug?.store), Object.keys(debug ?? {}).join(','));

  if (debug?.store) {
    const id = debug.store.addComment({
      content: '本条界定的统一战线包含四类爱国者 [第二条]。另见 [P-1-2]。',
      type: 'ai-explanation',
      paragraphId: 'P-1-2',
      anchorText: '第二条',
    });
    await tick(400);

    // 已完成的卡片默认收起（CommentCard 的 collapsed 初值：isAI && !streaming），
    // 收起态不渲染 .cites，所以断言 .cite 之前必须先点「展开解答」。
    // 注意：不要把默认改回展开来迁就测试——收起正是本次需求。
    check('挂载时已完成的 AI 卡片默认收起', Boolean(container.querySelector('.card.is-collapsed')));
    container
      .querySelector('.card.is-collapsed .card-collapse')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick(250);
    check('点「展开解答」后卡片不再收起', !container.querySelector('.card.is-collapsed'));

    const cites = [...container.querySelectorAll('.cite')].map((el) => el.textContent.trim());
    check('中文条号被识别为引用', cites.includes('第二条'), cites.join(' / '));
    check('段落 ID 同样被识别', cites.includes('P-1-2'), cites.join(' / '));
    check('两种引用去重后共 2 个', cites.length === 2, `实际 ${cites.length}`);

    // 点击引用应能定位而不报错
    const citeBtn = [...container.querySelectorAll('.cite')].find((el) => el.textContent.trim() === '第二条');
    let threw = null;
    try {
      citeBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await tick(200);
    } catch (e) {
      threw = e;
    }
    check('点击中文条号引用不报错', threw === null, String(threw?.message ?? ''));

    debug.store.comments.delete(id);
    await tick(200);
  }
}

root.unmount();
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
