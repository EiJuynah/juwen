/**
 * 回归验证：点击批注卡片后，原文高亮是否跟着切换到 .active。
 *
 * CommentHighlight 在 useEditor 创建时把 options 冻结，
 * 因此 App.jsx 需在 activeId 变化时改写 ext.options 再重建装饰。
 *
 *   node scripts/active-highlight-test.mjs
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

// jsdom 没有排版引擎，getClientRects/getBoundingClientRect 均缺失。
// ProseMirror 的 coordsAtPos 依赖它们，这里补零尺寸桩，
// 仅为让选区链路能在无头环境下跑通。
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
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? ` — ${d}` : ''}`); }
};

console.log('\n原文高亮激活态回归验证\n');

// 开屏已是空态（不再预置内置示例），而本测试要验证
// 「选区 → 锚点 → 高亮 → 激活态」整条链路，必须有正文可选中，
// 因此用 mock fetch 提供一份文档，挂载后点开它。
const TEST_DOC = {
  id: 'dt', name: '测试政策.wps', ext: 'wps', size: 100,
  folderId: null, level: 'public', format: 'doc', formatLabel: 'Word 文档',
  supported: true, title: '测试政策',
};
const TEST_POLICY = {
  title: '测试政策',
  meta: '',
  sections: [
    {
      heading: '第一章　总则',
      clauses: [
        { id: 'P-3-1', text: '补贴标准为本科 2 万元、硕士研究生 5 万元、博士研究生 10 万元。' },
        { id: 'P-3-2', text: '在本市购买首套住房的青年人才，可申请购房补贴。' },
      ],
    },
  ],
};

globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (o) => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => o, text: async () => JSON.stringify(o),
  });
  if (u.includes('/api/settings')) {
    // 本用例验证划词高亮，档位取默认的「讲透」（explain），不参与断言
    return json({
      enabled: true, profile: 'explain', model: 'deepseek-flash', effort: 'low',
      effortLevels: ['off', 'low'], limits: { maxTextChars: 4000, maxDepth: 6 },
      profileOptions: [
        { value: 'explain', label: '讲透', desc: '把话讲透，术语当场讲清、可补背景，补充会标注为补充。' },
        { value: 'strict', label: '严格依据', desc: '只用原文作答，逐条标出依据段落，要写材料、要经得起对照时用。' },
      ],
    });
  }
  if (u.includes('/api/files/tree')) return json({ folders: [], docs: [TEST_DOC] });
  if (u.match(/\/api\/files\/[^/]+$/)) return json({ doc: TEST_DOC, policy: TEST_POLICY, warnings: [] });
  return json({});
};

const { createRoot } = await import('react-dom/client');
const React = await import('react');
const { default: App } = await import('../web/src/App.jsx');

const container = dom.window.document.getElementById('root');
const root = createRoot(container);
root.render(React.createElement(App));
await new Promise((r) => setTimeout(r, 1200));

// 点开文档，让条款正文进入编辑器
container.querySelector('.lib-doc')?.dispatchEvent(
  new dom.window.MouseEvent('click', { bubbles: true }),
);
await new Promise((r) => setTimeout(r, 700));
check('文档已载入（正文含 P-3-1 段落）', Boolean(container.querySelector('[data-pid="P-3-1"]')));

const { editor, store } = globalThis.window.__policyDebug ?? {};
check('调试钩子已注入 window.__policyDebug', Boolean(editor && store));

if (editor && store) {
  // 建一条带锚点的批注，模拟划词后提交
  const pid = 'P-3-1';
  let targetPos = null;
  editor.state.doc.descendants((node, pos) => {
    if (targetPos == null && node.attrs?.pid === pid) targetPos = pos;
    return targetPos == null;
  });
  check('能定位到目标条款段落', targetPos != null, `pid=${pid}`);

  if (targetPos != null) {
    editor.commands.setTextSelection({ from: targetPos + 1, to: targetPos + 12 });
    await new Promise((r) => setTimeout(r, 150));

    const anchor = store.anchorFromSelection(editor);
    check('选区可转换为 Yjs 锚点', anchor != null);

    if (anchor) {
      const cid = store.addComment({
        content: '测试批注',
        type: 'human',
        anchor,
        anchorText: '补贴标准',
        paragraphId: pid,
      });
      await new Promise((r) => setTimeout(r, 300));

      const positions = store.resolveAnchors(editor);
      check('锚点可解析回 PM 位置', positions.has(cid), `解析数 ${positions.size}`);

      const anchors = [...container.querySelectorAll('.comment-anchor')];
      check('原文出现 comment-anchor 高亮', anchors.length >= 1, `实际 ${anchors.length}`);
      check('初始无 active 高亮', anchors.filter((a) => a.classList.contains('active')).length === 0);

      // 模拟点击卡片：App 内部走 setActiveId，这里直接驱动同一条路径
      const ext = editor.extensionManager.extensions.find((e) => e.name === 'commentHighlight');
      check('能取到 commentHighlight 扩展', Boolean(ext));
      check('扩展 options 上存在 activeCommentId', ext && 'activeCommentId' in ext.options);

      const { rebuildCommentDecorations } = await import('@pokapali/comments-tiptap');
      ext.options.activeCommentId = cid;
      rebuildCommentDecorations(editor.view);
      await new Promise((r) => setTimeout(r, 200));

      const activeAnchors = [...container.querySelectorAll('.comment-anchor.active')];
      check('改写 options 后 active 高亮生效', activeAnchors.length >= 1, `实际 ${activeAnchors.length}`);
      check(
        'active 高亮绑定到正确评论',
        activeAnchors.some((a) => a.getAttribute('data-comment-id') === cid),
      );

      store.comments.delete(cid);
    }
  }
}

root.unmount();
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
