/**
 * 「AI 过程展示」UI 测试：把服务端推来的 SSE 帧喂给前端，验证
 *   ① 过程时间线（思考 / 检索 / 作答）能按 key 增量合并、边跑边显示；
 *   ② 流式结束后自动折叠成一行摘要，点开可回看每一步与检索命中；
 *   ③ 过渡轮那句「我先查一下…」被 reset 丢掉，不污染答案；
 *   ④ done 事件里的 sources 渲染成可点击的来源清单，且默认折叠为 6 条、可展开/收起；
 *   ⑤ 答案里的引用编号仍能被识别成可点击的「依据」。
 *
 * fetch 全部打桩，不依赖后端与真实模型。走的链路是真实的：
 * 选区 → 浮动条「问 AI」→ 提问框 → store 建评论 → sse.js 解析 → 卡片渲染。
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
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  AbortController: globalThis.AbortController,
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

// ---------- 假服务端推的 SSE 帧 ----------
// 与 server/agent-loop.js 实际推的事件序列一致：思考 → 作答 →（过渡轮正文）→ reset
// → 检索 → 第 2 轮思考 → 最终答案 → done（带 steps / sources 权威快照）
const SEARCH_ITEMS = [
  { title: '中共中央印发《中国共产党统一战线工作条例》', url: 'https://www.gov.cn/zhengce/2020-12/21/content_5570077.htm', site: '中国政府网' },
  { title: '中国人民政治协商会议章程', url: 'http://www.cppcc.gov.cn/zxww/2023/03/13/ARTI1678681834993124.shtml', site: '中国政协网' },
];

/**
 * done.sources 的 fixture：真机（SEARCH_PROVIDER=deepseek）一次解释最多能带回 26 条去重来源，
 * 这里用 21 条（URL 各自唯一）验证「默认只露 6 条 + 展开其余 15 条 / 收起」这条链路。
 */
const SOURCE_ITEMS = Array.from({ length: 21 }, (_, i) => ({
  title: `权威来源 ${i + 1}`,
  url: `https://www.gov.cn/src/${i + 1}`,
  site: i % 2 === 0 ? '中国政府网' : '中国政协网',
}));
const FINAL_TEXT =
  '**核心解释**：本条界定的统一战线，是指中国共产党领导的广泛爱国统一战线 [P-1-2]。\n\n' +
  '- 关键在「领导者」与「基础」两处限定。\n' +
  '- 补充：※ 补充，非原文 —— 相关背景可参考官方口径。\n\n' +
  '> 依据：[P-1-2]';

const SERVER_STEPS = [
  { key: 'think:1', kind: 'think', status: 'done', label: '正在思考如何作答', elapsedMs: 1046, detail: '我先查一下权威口径。' },
  { key: 'answer:1', kind: 'answer', status: 'skipped', label: '过渡说明（已丢弃，不计入答案）', elapsedMs: 372 },
  {
    key: 'search:1:1', kind: 'search', status: 'done', label: '检索到 2 条权威来源',
    detail: '统一战线 定义 官方口径', elapsedMs: 820, items: SEARCH_ITEMS,
  },
  { key: 'think:2', kind: 'think', status: 'done', label: '正在梳理检索到的资料', elapsedMs: 613 },
  { key: 'answer:2', kind: 'answer', status: 'done', label: '已生成答案', elapsedMs: 1520 },
];

const SSE_FRAMES = [
  { phase: 'start', depth: 0 },
  { step: { key: 'think:1', kind: 'think', status: 'running', label: '正在思考如何作答' } },
  { r: '用户只选了一句话，先判断要不要联网。' },
  { step: { key: 'think:1', kind: 'think', status: 'done', label: '正在思考如何作答', elapsedMs: 1046 } },
  { step: { key: 'answer:1', kind: 'answer', status: 'running', label: '正在组织答案' } },
  { t: '我先查一下权威口径。' },
  // 这一轮带 tool_calls，正文会被 reset 丢掉，作答步骤收尾为 skipped（不是「已生成答案」）
  { step: { key: 'answer:1', kind: 'answer', status: 'skipped', label: '过渡说明（已丢弃，不计入答案）', elapsedMs: 372 } },
  // 有 tool_calls 的那轮：正文降级成步骤说明，前端收到 reset 后清空正文缓冲
  { step: { key: 'think:1', kind: 'think', status: 'done', label: '正在思考如何作答', detail: '我先查一下权威口径。', elapsedMs: 1046 } },
  { step: { key: 'search:1:1', kind: 'search', status: 'running', label: '正在检索权威来源', detail: '统一战线 定义 官方口径' } },
  { step: { key: 'search:1:1', kind: 'search', status: 'done', label: '检索到 2 条权威来源', detail: '统一战线 定义 官方口径', elapsedMs: 820, items: SEARCH_ITEMS } },
  { reset: true },
  { step: { key: 'think:2', kind: 'think', status: 'running', label: '正在梳理检索到的资料' } },
  { step: { key: 'think:2', kind: 'think', status: 'done', label: '正在梳理检索到的资料', elapsedMs: 613 } },
  { step: { key: 'answer:2', kind: 'answer', status: 'running', label: '正在组织答案' } },
  { t: FINAL_TEXT },
  { step: { key: 'answer:2', kind: 'answer', status: 'done', label: '已生成答案', elapsedMs: 1520 } },
  {
    done: true,
    reasoningChars: 123,
    profile: 'explain',
    disclaimer: '供理解参考，不作办事依据',
    steps: SERVER_STEPS,
    sources: SOURCE_ITEMS,
    rounds: 2,
    searched: 1,
    elapsedMs: 8637,
  },
];

/** 造一个逐帧吐 SSE 的 reader；每帧之间留出时间，便于观察「流式中」状态 */
function sseBody(frames, gapMs = 18) {
  const chunks = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`);
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = new globalThis.TextEncoder().encode(chunks[i++]);
          await new Promise((r) => setTimeout(r, gapMs));
          return { done: false, value };
        },
      };
    },
  };
}

// ---------- fetch 打桩 ----------
const FOLDER = { id: 'f1', name: '党内法规', parentId: null, createdAt: 1 };
const DOCS = [
  {
    id: 'd1', name: '中国共产党统一战线工作条例.wps', ext: 'wps', size: 75264,
    folderId: 'f1', level: 'public', format: 'ole-word', formatLabel: 'Word 文档（97-2003 二进制）',
    supported: true, title: '中国共产党统一战线工作条例', stats: { chapters: 14, articles: 61 },
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
let streamRequested = null;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push(`${opts.method ?? 'GET'} ${u}`);
  const json = (o) => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => o, text: async () => JSON.stringify(o),
  });

  if (u.includes('/api/settings')) {
    // 讲透档（默认）+ 已开启联网：本用例要验证「联网生效 → 顶栏 net-chip + 提示条联网」
    return json({
      enabled: true, profile: 'explain', model: 'deepseek-flash', effort: 'low',
      effortLevels: ['off', 'low'], limits: { maxTextChars: 4000, maxDepth: 6 },
      profileOptions: [
        { value: 'explain', label: '讲透', desc: '把话讲透，术语当场讲清、可补背景，补充会标注为补充。' },
        { value: 'strict', label: '严格依据', desc: '只用原文作答，逐条标出依据段落，要写材料、要经得起对照时用。' },
      ],
      searchEnabled: true, searchAvailable: true,
      searchInfo: { provider: 'mock', configured: true, open: false, allowedDomains: ['gov.cn'] },
    });
  }
  if (u.includes('/api/ai/stream')) {
    streamRequested = JSON.parse(opts.body || '{}');
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: sseBody(SSE_FRAMES, 40),
    };
  }
  if (u.includes('/api/files/tree')) return json({ folders: [FOLDER], docs: DOCS });
  if (u.includes('/comments')) return json({ ok: true, empty: true });
  if (u.match(/\/api\/files\/[^/]+$/)) {
    const id = u.split('/').pop();
    return json({ doc: DOCS.find((d) => d.id === id), policy: POLICY, warnings: [] });
  }
  return json({});
};

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

console.log('\nAI 过程展示（时间线 / 来源 / 流式）UI 测试\n');

const { createRoot } = await import('react-dom/client');
const React = await import('react');
const { default: App } = await import('../web/src/App.jsx');

const container = dom.window.document.getElementById('root');
const root = createRoot(container);
root.render(React.createElement(App));
await tick(1200);

// ---------- 载入文档并划词 ----------
// 注意：App 的调试钩子 effect 依赖 [editor, store]，**点开文档会换 store 并重建 editor**，
// window.__policyDebug 会被整体替换。因此每次用到前都要重新读一次，
// 不能在挂载后抓一个 debug 常量留到最后（那样拿到的是打开文档前的空内容 editor）。
const dbg = () => dom.window.__policyDebug ?? globalThis.window.__policyDebug;
check('调试钩子可用', Boolean(dbg()?.editor && dbg()?.store));

{
  const folderRow = container.querySelector('.lib-folder');
  folderRow?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);
  const docRow = [...container.querySelectorAll('.lib-doc')].find((el) => el.textContent.includes('统一战线工作条例'));
  docRow?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(400);
  check('文档已载入', (container.querySelector('.doc-head h2')?.textContent ?? '').includes('统一战线工作条例'));
}

{
  // 选中第二条正文的一小段：等价于用户拖选。
  // 这里必须重新取钩子：载入文档换过 store/editor，旧的 editor 里没有 P-1-2。
  const editor = dbg()?.editor;
  check('载入文档后调试钩子指向新 editor', Boolean(editor), Object.keys(dbg() ?? {}).join(','));

  let found = null;
  editor?.state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.type.name === 'paragraph' && node.attrs?.pid === 'P-1-2') { found = pos; return false; }
    return true;
  });
  check('定位到目标段落', found != null, String(found));

  if (found == null) {
    // 诊断：区分「文档是空的」还是「pid 没映射进来」，下次一眼能看出
    const pids = [];
    editor?.state.doc.descendants((node) => {
      if (node.attrs?.pid) pids.push(node.attrs.pid);
      return true;
    });
    console.log(`    诊断：editor=${editor ? 'ok' : 'null'}，doc.content.size=${editor?.state.doc.content.size ?? 'n/a'}，pid=[${pids.join(', ')}]`);
    console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
    process.exit(1);
  }

  editor.commands.setTextSelection({ from: found + 1, to: found + 12 });
  await tick(250);

  const popbar = container.querySelector('.popover');
  check('划词后出现浮动条', Boolean(popbar));
  const netChip = container.querySelector('.net-chip');
  check('联网生效时顶栏有「联网检索」标签', Boolean(netChip), container.querySelector('.topbar-meta')?.textContent);
  check('提示条说明已联网', (container.querySelector('.doc-hint')?.textContent ?? '').includes('联网'));
}

{
  const aiBtn = [...container.querySelectorAll('.popover-btn')].find((b) => b.textContent.includes('问 AI'));
  aiBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(200);
  const dialog = container.querySelector('.modal');
  check('弹出提问框', Boolean(dialog), dialog?.textContent?.slice(0, 20));
  const submit = dialog?.querySelector('.modal-foot .mini.primary');
  check('提问框可留空直接解释', submit?.textContent.includes('直接解释'), submit?.textContent);
  submit?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(120);
}

console.log('\n▸ 流式中：过程实时可见');
{
  check('已向 /api/ai/stream 发起请求', Boolean(streamRequested), calls.filter((c) => c.includes('ai/stream')).join(' | '));
  check('请求体带选中内容与段落号', Boolean(streamRequested?.text) && streamRequested?.paragraphId === 'P-1-2', JSON.stringify(streamRequested)?.slice(0, 120));

  // SSE 帧每 18ms 一帧，整条流约 300ms。要在「流还没结束」的前提下等到
  // 检索命中出现、且此刻确有进行中的步骤，只能等条件成立，不能靠固定 sleep：
  // 等太早看不到检索，等太晚时间线已经自动折叠。
  for (let i = 0; i < 50; i++) {
    const ready =
      container.querySelector('.activity.live') &&
      container.querySelector('.act-docs a') &&
      container.querySelector('.act-item.running');
    if (ready) break;
    await tick(10);
  }

  const live = container.querySelector('.activity.live');
  check('出现流式中的过程时间线', Boolean(live), container.querySelector('.comment-list')?.textContent?.slice(0, 60));
  check('时间线显示「正在处理」', live?.textContent.includes('正在处理'), live?.textContent);
  check('有进行中的步骤在呼吸', Boolean(container.querySelector('.act-item.running')));
  const liveSteps = [...container.querySelectorAll('.act-item')].map((el) => el.textContent);
  check('已出现「检索」步骤', liveSteps.some((t) => t.includes('检索')), liveSteps.join(' | '));
  check('检索命中已内联展示', Boolean(container.querySelector('.act-docs a')), '');
}

console.log('\n▸ 流式结束：自动折叠成摘要');
await tick(1200);
{
  check('请求已结束（时间线不再 live）', !container.querySelector('.activity.live'));
  const head = container.querySelector('.act-head');
  check('折叠成一行摘要', Boolean(head) && !container.querySelector('.act-list'), head?.textContent);

  const meta = container.querySelector('.act-meta')?.textContent ?? '';
  check('摘要含步数', /5 步/.test(meta), meta);
  check('摘要含检索次数', meta.includes('检索 1 次'), meta);
  check('摘要含耗时', /\d+\.\ds/.test(meta), meta);

  const cardText = container.querySelector('.card .md')?.textContent ?? '';
  check('答案已渲染', cardText.includes('本条界定的统一战线'), cardText.slice(0, 40));
  check('过渡轮正文被 reset 丢掉（不残留「我先查一下」）', !cardText.includes('我先查一下权威口径'), cardText.slice(0, 60));

  const cites = [...container.querySelectorAll('.cite')].map((el) => el.textContent.trim());
  check('答案里的引用编号可点击回查', cites.includes('P-1-2'), cites.join(' / '));

  check('done 后不再显示推理区占位', !container.querySelector('.thinking'));
}

console.log('\n▸ 引用块：卡片显示被解释的那段原文');
{
  const card = container.querySelector('.card');
  const quote = card?.querySelector('.card-quote');
  check('卡片显示引用块', Boolean(quote), card?.textContent?.slice(0, 40));
  check(
    '引用块文本等于本次选中内容',
    (quote?.querySelector('.quote-text')?.textContent ?? '') === streamRequested?.text,
    JSON.stringify({ got: quote?.querySelector('.quote-text')?.textContent, want: streamRequested?.text }),
  );
  check('引用块带「引用」标签', (quote?.querySelector('.quote-tag')?.textContent ?? '').trim() === '引用', quote?.querySelector('.quote-tag')?.textContent);
  check('被截断前的完整引用挂在 title 上', (quote?.getAttribute('title') ?? '') === streamRequested?.text, quote?.getAttribute('title'));
}

console.log('\n▸ 权威 done 快照没有被兜底事件覆盖');
{
  // 回归 sse.js 的一个真实缺陷：读取循环走完后无条件再调一次 onDone({truncated:true})，
  // 会把服务端刚发来的权威 done 快照（sources / searched / elapsedMs / steps）清空，
  // 真机症状就是「来源清单不显示、检索次数与耗时永远是 0」。
  // 这里直接查 store 里的数据，DOM 侧的三项断言（摘要/来源清单）另有覆盖。
  const store = dbg()?.store;
  const list = store?.commentsList ?? [];
  // 本用例只有这一条 AI 注释；type 兜底取第一条，避免因为字段形状差异误报
  const ai = list.find((c) => c?.data?.type === 'ai-explanation') ?? list[0];
  check('能从 store 取到这条 AI 注释', Boolean(ai), list.map((c) => c?.data?.type).join(',') || '(空)');

  const d = ai?.data ?? {};
  check('done.sources 保留 21 条（未被兜底清空）', d.sources?.length === 21, String(d.sources?.length));
  check('done.searched 保留 1（未被兜底清零）', d.searched === 1, String(d.searched));
  check('done.elapsedMs 保留 8637（未被兜底清零）', d.elapsedMs === 8637, String(d.elapsedMs));
  check('权威 done 的 steps 快照保留 5 步', d.steps?.length === 5, String(d.steps?.length));
}

console.log('\n▸ 展开过程：每一步都能回看');
{
  container.querySelector('.act-head')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);
  const list = container.querySelector('.act-list');
  check('点击摘要可展开', Boolean(list));
  const items = [...container.querySelectorAll('.act-item')];
  check('展开后步骤数与服务端一致（5 步）', items.length === 5, `实际 ${items.length}`);

  const kinds = items.map((el) => el.getAttribute('data-kind'));
  check('步骤含思考 / 检索 / 作答三类', kinds.includes('think') && kinds.includes('search') && kinds.includes('answer'), kinds.join(','));
  check('检索步骤带查询词', (list?.textContent ?? '').includes('统一战线 定义 官方口径'), list?.textContent?.slice(0, 60));
  const docsLinks = [...container.querySelectorAll('.act-docs a')].map((a) => a.getAttribute('href'));
  check('检索步骤里的来源可点击', docsLinks.includes(SEARCH_ITEMS[0].url), docsLinks.join(' | '));
  check('来源链接新窗口打开且带 noopener', [...container.querySelectorAll('.act-docs a')].every((a) => a.getAttribute('target') === '_blank' && (a.getAttribute('rel') ?? '').includes('noopener')));
}

console.log('\n▸ 来源清单（done.sources：默认折叠 6 条 + 展开/收起）');
{
  const srcs = container.querySelector('.srcs');
  check('渲染出来源清单', Boolean(srcs), container.querySelector('.card')?.textContent?.slice(-60));
  check('来源与「依据」在视觉上分开', Boolean(container.querySelector('.cites')) && Boolean(srcs));

  const links = () => [...container.querySelectorAll('.srcs-list a')];
  const count = () => (container.querySelector('.srcs-count')?.textContent ?? '').trim();

  check('头部计数显示总数 21', count() === '21', count());
  check('默认只渲染前 6 条链接', links().length === 6, `实际 ${links().length}`);
  check('前 6 条就是 fixture 的前 6 条（顺序未变）', links()[0]?.getAttribute('href') === SOURCE_ITEMS[0].url && links()[5]?.getAttribute('href') === SOURCE_ITEMS[5].url, links().map((a) => a.getAttribute('href')).join(' | '));

  const more = container.querySelector('.srcs-more');
  check('出现「展开其余 15 条」按钮（button 而非 a）', more?.tagName === 'BUTTON' && more?.textContent.includes('展开其余 15 条'), more?.textContent);

  more?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);

  check('点开后渲染全部 21 条', links().length === 21, `实际 ${links().length}`);
  check('展开态头部计数仍是总数 21', count() === '21', count());
  check('来源链接指向原文出处', links().map((a) => a.getAttribute('href')).includes(SOURCE_ITEMS[0].url));
  check('来源标注站点名', (container.querySelector('.srcs-list')?.textContent ?? '').includes('中国政府网'));
  check('来源链接新窗口打开且带 noopener', links().every((a) => a.getAttribute('target') === '_blank' && (a.getAttribute('rel') ?? '').includes('noopener')));
  check('展开态按钮文案变为「收起」', (container.querySelector('.srcs-more')?.textContent ?? '').includes('收起'), container.querySelector('.srcs-more')?.textContent);

  container.querySelector('.srcs-more')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);
  check('再点「收起」回到 6 条', links().length === 6, `实际 ${links().length}`);
}

console.log('\n▸ AI 解答可折叠：收起只留「引用 + 问题」');
{
  // 本用例的卡片是流式中挂载的，所以默认展开（初始 collapsed=false），既有断言都建立在展开态上
  const card = () => container.querySelector('.card');
  check('流式中挂载的卡片默认展开', !card()?.classList.contains('is-collapsed'));
  check('展开态能看到答案', Boolean(card()?.querySelector('.md')));

  card()?.querySelector('.card-collapse')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);

  check('收起后卡片带 is-collapsed 类', Boolean(card()?.classList.contains('is-collapsed')));
  check('收起后答案 .md 不可见', !card()?.querySelector('.md'));
  check('收起后来源清单 .srcs 不可见', !card()?.querySelector('.srcs'));
  check('收起后依据 .cites 不可见', !card()?.querySelector('.cites'));
  check('收起后反问区 .card-foot 不可见', !card()?.querySelector('.card-foot'));
  check('收起后引用块仍然可见', Boolean(card()?.querySelector('.card-quote .quote-text')));
  // 注意：本用例这条卡片是「留空直接解释」，没有提问，所以这里不断言 .q；
  // 「收起后问题仍可见」由下一节那条带 question 的已完成卡片覆盖
  check('收起态按钮文案为「展开解答」', (card()?.querySelector('.card-collapse')?.textContent ?? '') === '展开解答', card()?.querySelector('.card-collapse')?.textContent);

  card()?.querySelector('.card-collapse')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);

  check('再展开后答案回来', Boolean(card()?.querySelector('.md')));
  check('再展开后来源清单回来', Boolean(card()?.querySelector('.srcs')));
  check('再展开后依据回来', Boolean(card()?.querySelector('.cites')));
  check('再展开后不再是收起态', !card()?.classList.contains('is-collapsed'));
}

console.log('\n▸ 挂载时已完成的卡片默认收起');
{
  // 「刷新后加载到的已完成卡片」用 store 直接挂一条非 streaming 的 AI 注释来模拟
  const store = dbg()?.store;
  const id = store?.addComment({
    content: '已完成的解释：本条界定的统一战线包含四类爱国者 [P-1-2]。',
    type: 'ai-explanation',
    paragraphId: 'P-1-2',
    anchorText: '第二条　本条例所称统一战线',
    question: '这条已完成，默认应该是收起还是展开？',
  });
  await tick(400);

  const pick = () => [...container.querySelectorAll('.card')].find((el) => el.textContent.includes('这条已完成，默认应该是收起还是展开？'));
  const card = pick();
  check('取到新挂载的已完成卡片', Boolean(card), container.querySelector('.comment-list')?.textContent?.slice(0, 60));
  check('挂载时已完成的 AI 卡片默认收起', Boolean(card?.classList.contains('is-collapsed')));
  check('收起态仍能看到引用块', Boolean(card?.querySelector('.card-quote .quote-text')));
  check('收起态仍能看到问题', (card?.querySelector('.q')?.textContent ?? '').includes('这条已完成，默认应该是收起还是展开？'));
  check('收起态答案不可见', !card?.querySelector('.md'));
  check('收起态按钮文案为「展开解答」', (card?.querySelector('.card-collapse')?.textContent ?? '') === '展开解答', card?.querySelector('.card-collapse')?.textContent);

  card?.querySelector('.card-collapse')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await tick(250);
  check('点「展开解答」后答案可见', Boolean(pick()?.querySelector('.md')));
  check('展开后不再带 is-collapsed', !pick()?.classList.contains('is-collapsed'));

  store?.comments.delete(id);
  await tick(200);
}

root.unmount();
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
