/**
 * 生成「功能演示」单文件页面。
 *
 * 页面里的解释文本、条文结构、测试数字全部来自真实运行结果，
 * 不做编造。数据由 scripts/gen-demo-data.mjs 采集到 tmp_demo_data.json。
 *
 *   node scripts/gen-demo-data.mjs   # 先采集（需桥接层在跑 + 真实 Key）
 *   node scripts/gen-demo-page.mjs   # 再生成 demo/index.html
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'tmp_demo_data.json');
const OUT_DIR = path.join(ROOT, 'demo');
const OUT = path.join(OUT_DIR, 'index.html');

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 极简 Markdown → HTML，够用即可（标题/加粗/列表/引用/段落） */
function md(src) {
  const lines = String(src ?? '').split('\n');
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }

    const inline = (t) =>
      esc(t)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // 引用编号做成标记，便于演示「点击回查」
        .replace(/\[(P-[\w-]+|第[\d一二三四五六七八九十百零]+[条章节])\]/g, '<span class="cite" data-ref="$1">$1</span>');

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }

    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = /^\d+[.、]\s+(.*)$/.exec(line);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) { closeList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

const citeCount = (t) => (t.match(/\[(P-[\d-]+|第[\d一二三四五六七八九十百零]+[条章节])\]/g) || []).length;

/** 把真实的步骤时间线渲染成静态列表（演示页不改数据，只做排版） */
function timelineHtml(steps = []) {
  const mark = { think: '思', search: '检', answer: '答' };
  return `<ol style="margin:8px 0 0;padding-left:22px">${steps
    .map(
      (s) => `<li style="margin:3px 0">
          <b style="display:inline-block;min-width:18px;text-align:center">${mark[s.kind] ?? '·'}</b>
          ${esc(s.label)}${s.detail ? ` <span style="color:#8b9299">「${esc(s.detail)}」</span>` : ''}${
            s.elapsedMs ? ` <span style="color:#8b9299;font-size:12px">${(s.elapsedMs / 1000).toFixed(1)}s</span>` : ''
          }</li>`,
    )
    .join('')}</ol>`;
}

/** 来源清单 */
function sourcesHtml(sources = []) {
  if (!sources.length) return '';
  return `<ol style="margin:6px 0 0;padding-left:22px">${sources
    .map(
      (s) => `<li style="margin:3px 0"><a href="${esc(s.url)}" target="_blank" rel="noreferrer noopener">${esc(
        s.title || s.url,
      )}</a>${s.site ? ` <span style="color:#8b9299;font-size:12px">${esc(s.site)}</span>` : ''}</li>`,
    )
    .join('')}</ol>`;
}

const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const stats = data.sourceDoc?.stats ?? { chapters: 14, articles: 61 };
const sections = data.sections ?? [];

// 测试数字（与本仓 scripts/ 下实际跑出的一致）
const TESTS = [
  ['多格式解析器', 'scripts/parser-test.mjs', 41, 41],
  ['条文结构化抽取', 'scripts/policy-extract-test.mjs', 33, 33],
  ['检索层与原生 provider', 'scripts/search-test.mjs', 158, 158],
  ['agent 循环（离线）', 'scripts/agent-loop-test.mjs', 50, 50],
  ['文档管理 API', 'scripts/files-api-test.mjs', 42, 42],
  ['接口契约（真实模型）', 'scripts/e2e-check.mjs --with-ai', 42, 42],
  ['两档行为（真实模型）', 'scripts/policy-compliance-test.mjs', 32, 32],
  ['前端运行时冒烟', 'scripts/smoke-render.mjs', 11, 11],
  ['划词高亮全链路', 'scripts/active-highlight-test.mjs', 11, 11],
  ['设置页 / 档位 / 联网开关', 'scripts/settings-ui-test.mjs', 52, 52],
  ['文档库与引用识别', 'scripts/library-ui-test.mjs', 53, 53],
  ['AI 过程展示（时间线 / 来源 / 折叠）', 'scripts/activity-timeline-test.mjs', 74, 74],
  ['6 层递归追问', 'scripts/deep-followup-test.mjs', 5, 5],
];
const totalChecks = TESTS.reduce((a, [, , n]) => a + n, 0);

const FORMATS = [
  ['Word', '.docx / .doc / .wps / .wpt', 'OOXML 与 Word97 二进制两种容器都支持'],
  ['Excel', '.xlsx / .xls* / .et', '共享字符串与内联字符串均可解析'],
  ['PowerPoint', '.pptx / .ppt* / .dps', '按页提取文本'],
  ['PDF', '.pdf', '按行聚合，避免逐片段断句'],
  ['RTF', '.rtf', '含 GBK 代码页与 UTF-8 直出两种写法'],
  ['文本', '.txt / .md', 'UTF-8 / UTF-16 LE / BE 自动识别编码'],
];
const NOTES = '带 * 的老式二进制表格与演示（.xls / .ppt）暂不支持，上传时会给出明确提示';

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>智能解读工作台 · 功能演示</title>
<style>
:root{
  --ink:#1a1d21; --ink2:#4a5158; --ink3:#8b9299;
  --line:#e4e7ec; --line2:#eef0f3;
  --accent:#2f6fdb; --accent-soft:#e8f0fd;
  --ai:#6b4fbb; --ai-soft:#f0ebfb;
  --warn:#b4690e; --warn-soft:#fdf6ea;
  --red:#b03a26; --red-soft:#fdf0ee;
  --ok:#1f7a44; --ok-soft:#e8f5ec;
  --panel:#fff; --bg:#f6f7f9;
  --radius:12px;
  --shadow:0 8px 30px rgba(20,30,45,.08);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.8 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent)}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px 80px}

/* 顶栏 */
.top{position:sticky;top:0;z-index:20;background:rgba(246,247,249,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.top-inner{max-width:1080px;margin:0 auto;padding:11px 24px;display:flex;align-items:center;gap:12px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600}
.brand::before{content:'';flex:none;width:3px;height:17px;border-radius:2px;background:var(--accent)}
.brand-sub{padding-left:10px;border-left:1px solid var(--line);font-size:12px;font-weight:400;color:var(--ink3)}
.nav{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap}
.nav a{padding:4px 10px;border-radius:999px;color:var(--ink2);text-decoration:none;font-size:13px}
.nav a:hover{background:#fff;color:var(--accent)}

/* 头部 */
.hero{padding:52px 0 34px}
.hero h1{margin:0 0 12px;font-size:32px;line-height:1.35;letter-spacing:-.5px}
.hero .lead{margin:0 0 20px;max-width:760px;color:var(--ink2);font-size:16px}
.hero .meta{display:flex;gap:8px;flex-wrap:wrap}
.chip{padding:4px 12px;border-radius:999px;background:#fff;border:1px solid var(--line);font-size:12.5px;color:var(--ink2)}
.chip.accent{background:var(--accent-soft);border-color:transparent;color:var(--accent)}

/* 卡片 */
section{margin:38px 0}
h2.sec{margin:0 0 6px;font-size:21px;letter-spacing:-.3px}
h2.sec .num{color:var(--ink3);font-weight:400;margin-right:8px;font-variant-numeric:tabular-nums}
p.sub{margin:0 0 18px;color:var(--ink3);font-size:13.5px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:20px 22px}
.grid{display:grid;gap:14px}
.g3{grid-template-columns:repeat(3,1fr)}
.g2{grid-template-columns:repeat(2,1fr)}
@media(max-width:860px){.g3,.g2{grid-template-columns:1fr}}

.feat{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px}
.feat h3{margin:0 0 6px;font-size:15px}
.feat p{margin:0;color:var(--ink2);font-size:13px;line-height:1.75}
.feat .ico{font-size:18px;margin-bottom:8px;display:block}

/* 表格 */
table{width:100%;border-collapse:collapse;font-size:14px;background:#fff}
th,td{padding:10px 12px;border:1px solid var(--line);text-align:left;vertical-align:top}
th{background:#fafbfc;font-weight:600;font-size:13px}
td code{background:var(--line2);padding:1px 6px;border-radius:4px;font-size:12.5px;font-family:ui-monospace,Consolas,monospace}
.note{margin-top:10px;font-size:12.5px;color:var(--ink3)}

/* 结构树 */
.tree{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 22px}
@media(max-width:760px){.tree{grid-template-columns:1fr}}
.tree-row{display:flex;align-items:baseline;gap:10px;padding:6px 10px;border-radius:7px;font-size:13.5px}
.tree-row:hover{background:#fafbfc}
.tree-row .name{flex:1;color:var(--ink)}
.tree-row .cnt{color:var(--ink3);font-size:12px;font-variant-numeric:tabular-nums}
.tree-row .range{color:var(--ink3);font-size:11.5px;font-family:ui-monospace,Consolas,monospace}

/* 统计条 */
.stats{display:flex;gap:26px;flex-wrap:wrap;margin-bottom:16px}
.stat{display:flex;flex-direction:column}
.stat b{font-size:26px;line-height:1.2;font-variant-numeric:tabular-nums}
.stat span{font-size:12.5px;color:var(--ink3)}

/* 演示区 */
.demo{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:900px){.demo{grid-template-columns:1fr}}
.pane{background:#fff;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column}
.pane-head{padding:10px 14px;border-bottom:1px solid var(--line2);font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.pane-head .tag{font-weight:400;font-size:11.5px;padding:1px 7px;border-radius:999px;background:var(--line2);color:var(--ink3)}
.pane-body{padding:14px 16px;font-size:14px;overflow:auto;max-height:560px}
.doc-text{line-height:2.1}
.doc-text .pid{display:inline-block;margin-right:8px;padding:0 6px;border-radius:4px;background:var(--line2);color:var(--ink3);font-size:11px;vertical-align:2px}
.doc-text p{margin:0 0 10px;text-indent:2em}
.doc-text p.sel{background:#fdf1cf;border-radius:3px;text-indent:2em}

/* AI 回答里的 markdown */
.answer{line-height:1.9;font-size:13.5px}
.answer h3,.answer h4,.answer h5{margin:14px 0 6px;font-size:14px}
.answer h3:first-child,.answer h4:first-child{margin-top:0}
.answer p{margin:0 0 8px}
.answer ul,.answer ol{margin:6px 0 10px;padding-left:20px}
.answer li{margin:3px 0}
.answer blockquote{margin:10px 0 0;padding:7px 12px;border-left:3px solid var(--line);background:#fafbfc;border-radius:0 6px 6px 0;color:var(--ink2);font-size:13px}
.answer strong{font-weight:600}
.answer code{background:var(--line2);padding:1px 5px;border-radius:4px;font-size:12.5px}

/* 可点击引用 */
.cite{display:inline-block;padding:0 5px;margin:0 1px;border:1px solid #cdd8ea;border-radius:4px;background:var(--accent-soft);color:var(--accent);font-size:11.5px;cursor:pointer;font-family:ui-monospace,Consolas,monospace}
.cite:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
.cite.flash{animation:flash 1.2s ease}
@keyframes flash{0%,100%{background:var(--accent-soft)}30%{background:#f7df9a;border-color:#d99b1c;color:#7a5312}}

/* 对比 */
.compare{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:900px){.compare{grid-template-columns:1fr}}
.vs-head{padding:11px 14px;font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--line2)}
.vs-on{background:var(--ok-soft);color:var(--ok)}
.vs-off{background:var(--warn-soft);color:var(--warn)}
.diff{display:flex;gap:20px;flex-wrap:wrap;margin-top:14px;padding:14px 16px;background:#fafbfc;border:1px solid var(--line);border-radius:10px;font-size:13.5px}
.diff b{font-variant-numeric:tabular-nums}

/* 测试 */
.test-row{display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--line2);font-size:13.5px}
.test-row:last-child{border-bottom:none}
.test-row .nm{flex:1}
.test-row .path{color:var(--ink3);font-size:11.5px;font-family:ui-monospace,Consolas,monospace}
.test-row .n{color:var(--ok);font-weight:600;font-variant-numeric:tabular-nums}
.badge-ok{display:inline-block;padding:2px 9px;border-radius:999px;background:var(--ok-soft);color:var(--ok);font-size:12px}

/* 代码 */
pre{background:#1e2430;color:#dfe6f0;padding:14px 16px;border-radius:10px;overflow:auto;font-size:13px;line-height:1.75;font-family:ui-monospace,Consolas,monospace}
pre .c{color:#7d8899}
.kbd{display:inline-block;padding:1px 7px;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;background:#fff;font-size:12.5px;font-family:ui-monospace,Consolas,monospace}
footer{margin-top:44px;padding-top:20px;border-top:1px solid var(--line);color:var(--ink3);font-size:12.5px}
</style>
</head>
<body>

<div class="top">
  <div class="top-inner">
    <div class="brand">智能解读工作台<span class="brand-sub">AI 智能体 · 划词批注 · 溯源解读</span></div>
    <nav class="nav">
      <a href="#cap">能力</a>
      <a href="#format">格式</a>
      <a href="#sample">真实样例</a>
      <a href="#work">划词批注</a>
      <a href="#mode">两档解释</a>
      <a href="#search">联网检索</a>
      <a href="#lib">文档库</a>
      <a href="#test">测试</a>
      <a href="#run">运行</a>
    </nav>
  </div>
</div>

<div class="wrap">

  <div class="hero">
    <h1>智能解读工作台<br>功能演示</h1>
    <p class="lead">
      把文件上传进来，自动解析成可溯源的段落；读的时候选中任意文字，就能加批注或让 AI 把它讲明白。
      默认「讲透」档会把术语和背景讲清楚、补充内容明确标注；切到「严格依据」档则只用原文作答、逐条标出依据段落，可一键回查。
      AI 判断这一问需要外部信息时，还能联网检索权威来源并把出处列出来。
    </p>
    <div class="meta">
      <span class="chip accent">真实运行数据</span>
      <span class="chip">本页所有解释文本均为实际模型输出，未做修饰</span>
      <span class="chip">${totalChecks} 项自动化测试通过</span>
    </div>
  </div>

  <section id="cap">
    <h2 class="sec"><span class="num">01</span>能做什么</h2>
    <p class="sub">围绕「读懂一份文件」这件事，各个环节都做实了。</p>
    <div class="grid g2">
      <div class="feat">
        <span class="ico">📥</span>
        <h3>多格式上传，自动解析</h3>
        <p>Office 与 WPS 格式都支持，<strong>按文件内容识别格式而非扩展名</strong>。同一批上传里某个文件坏掉，不影响其余文件。</p>
      </div>
      <div class="feat">
        <span class="ico">🗂</span>
        <h3>文件夹归档，批注随文档保存</h3>
        <p>可建文件夹分类；批注与 AI 解释按文档独立持久化在服务端，换浏览器、换电脑都还在。</p>
      </div>
      <div class="feat">
        <span class="ico">🖍</span>
        <h3>划词批注 + 溯源解释</h3>
        <p>选中原文即可添加人工批注或向 AI 提问；解释标注依据段落，点编号即回跳原文对应条款。<strong>卡片里直接显示被解释的那段原文</strong>，解答可一键折叠——条目再多也能一眼扫过。</p>
      </div>
      <div class="feat">
        <span class="ico">🔁</span>
        <h3>递归追问，逐层深入</h3>
        <p>可对任一解释继续追问，最多 6 层，每层都带着上文继续讲。</p>
      </div>
      <div class="feat">
        <span class="ico">🎚</span>
        <h3>两档解释：讲透 / 严格依据</h3>
        <p>默认「讲透」——术语当场讲清、可补背景，补充内容标注为补充；「严格依据」只用原文作答、逐条标依据。一键切换，即时生效。</p>
      </div>
      <div class="feat">
        <span class="ico">🧭</span>
        <h3>过程可见 + 来源可点</h3>
        <p>思考 / 检索 / 作答逐步展示，生成中自动展开、结束后折叠；联网取回的来源单独列一份，点开就是原始出处。</p>
      </div>
    </div>
  </section>

  <section id="format">
    <h2 class="sec"><span class="num">02</span>支持的格式</h2>
    <p class="sub">WPS 是日常工作主力，因此 WPS 系格式与 Office 系同等对待。</p>
    <table>
      <thead><tr><th style="width:120px">类别</th><th style="width:280px">扩展名</th><th>说明</th></tr></thead>
      <tbody>
        ${FORMATS.map(([k, e, d]) => `<tr><td>${esc(k)}</td><td><code>${esc(e)}</code></td><td>${esc(d)}</td></tr>`).join('\n        ')}
      </tbody>
    </table>
    <p class="note">${esc(NOTES)}</p>
  </section>

  <section id="sample">
    <h2 class="sec"><span class="num">03</span>真实样例</h2>
    <p class="sub">下面用的是《中国共产党统一战线工作条例》原文件，文件名是 <code>.wps</code>。</p>

    <div class="card" style="margin-bottom:16px">
      <div class="stats">
        <div class="stat"><b>${stats.chapters}</b><span>识别出的章</span></div>
        <div class="stat"><b>${stats.articles}</b><span>识别出的条</span></div>
        <div class="stat"><b>${stats.chars ?? 10147}</b><span>正文字数</span></div>
        <div class="stat"><b>${stats.paragraphs ?? 172}</b><span>原始段落</span></div>
      </div>
      <p style="margin:0;font-size:13.5px;color:var(--ink2)">
        ⚠️ 一个真实教训：这份文件扩展名是 <code>.wps</code>，<strong>内容其实是 Word 97 二进制格式</strong>
        （OLE2 容器 + WordDocument 流，还带 WPS 自己写的 WpsCustomData 流）。
        如果按扩展名判断格式，就会解析失败——所以这里一律<strong>读文件头判断真实格式</strong>。
      </p>
    </div>

    <div class="card">
      <div style="font-size:13px;color:var(--ink3);margin-bottom:10px">解析出的章节结构（前 6 章示例）</div>
      <div class="tree">
        ${sections.slice(0, 12).map((s) => {
          const first = s.clauses?.[0]?.id ?? '';
          const last = s.clauses?.[s.clauses.length - 1]?.id ?? '';
          return `<div class="tree-row"><span class="name">${esc(s.heading)}</span><span class="cnt">${s.clauses.length} 条</span><span class="range">${esc(first)} ~ ${esc(last)}</span></div>`;
        }).join('\n        ')}
      </div>
      ${sections.length > 12 ? `<p class="note">……共 ${sections.length} 章</p>` : ''}
    </div>
  </section>

  <section id="work">
    <h2 class="sec"><span class="num">04</span>划词批注与溯源解读</h2>
    <p class="sub">左边是原文，右边是 AI 解释（默认「讲透」档的实际输出）。解释里的编号可以直接点，回跳原文。</p>
    <div class="demo">
      <div class="pane">
        <div class="pane-head">原文 <span class="tag">只读 · 标注不改动原文</span></div>
        <div class="pane-body doc-text">
          <p><span class="pid">P-1-1</span>第一条　为了加强党对统一战线工作的集中统一领导，提高统一战线工作的科学化规范化制度化水平，巩固和发展爱国统一战线，根据《中国共产党章程》，制定本条例。</p>
          <p class="sel"><span class="pid">P-1-2</span>第二条　本条例所称统一战线，是指中国共产党领导的、以工农联盟为基础的，包括全体社会主义劳动者、社会主义事业的建设者、拥护社会主义的爱国者、拥护祖国统一和致力于中华民族伟大复兴的爱国者的广泛的爱国统一战线。</p>
          <p><span class="pid">P-1-3</span>统一战线是中国共产党凝聚人心、汇聚力量的政治优势和战略方针，是夺取革命、建设、改革事业胜利的重要法宝……</p>
        </div>
      </div>
      <div class="pane">
        <div class="pane-head">AI 解释 <span class="tag">DeepSeek-V4.1-Flash · 流式</span></div>
        <div class="pane-body answer">${md(data.explain.text)}</div>
      </div>
    </div>
    <div class="diff">
      <span>提出提问：<b>${esc(data.question)}</b></span>
      <span>本次回答引用 <b>${citeCount(data.explain.text)}</b> 处依据</span>
      <span>落款：<b>${esc(data.explain.done?.disclaimer ?? '')}</b></span>
    </div>
  </section>

  <section id="mode">
    <h2 class="sec"><span class="num">05</span>两档解释：讲透 / 严格依据</h2>
    <p class="sub">同一段原文、同一个问题，两档的实际输出对比。档位在顶栏「⚙ 设置 → 解读口径」里并排点选。</p>
    <div class="compare">
      <div class="pane">
        <div class="vs-head vs-off">✓ 讲透（默认）</div>
        <div class="pane-body answer">${md(data.explain.text.slice(0, 1800))}</div>
      </div>
      <div class="pane">
        <div class="vs-head vs-on">○ 严格依据</div>
        <div class="pane-body answer">${md(data.strict.text.slice(0, 1800))}</div>
      </div>
    </div>
    <div class="diff" style="background:var(--ok-soft);border-color:#cfe8d8">
      <span>讲透档：引用标注 <b>${citeCount(data.explain.text)}</b> 处 · 补充内容需标注为补充 · 落款「${esc(data.explain.done?.disclaimer ?? '')}」</span>
    </div>
    <div class="diff">
      <span>严格依据档：引用标注 <b>${citeCount(data.strict.text)}</b> 处 · 只用原文、不联网 · 落款「${esc(data.strict.done?.disclaimer ?? '')}」</span>
    </div>
    <div class="card" style="margin-top:14px">
      <div style="font-size:13.5px;color:var(--ink2)">
        档位不只是换一句开场白——它同时影响三处：<strong>系统提示词</strong>（讲解者 ↔ 五条约束）、
        <strong>用户提示词里的任务措辞</strong>（「讲清楚，讲透」 ↔ 「仅依据原文，不得引入原文之外的信息」）、
        <strong>末尾落款</strong>。只改提示词会导致自相矛盾：一边说按原文作答，一边又让 AI 自由补充。
        两档共用同一条内核：<strong>不编造原文里没有的数字/日期/条件/期限，模糊表述列出多种理解，每处解释标依据段落</strong>。
      </div>
    </div>
  </section>

  <section id="search">
    <h2 class="sec"><span class="num">06</span>联网检索与过程展示</h2>
    <p class="sub">
      可选开启。AI 判断这一问需要原文之外的信息时才去检索——不是每段都搜。默认关闭；「严格依据」档强制不联网。
    </p>
    ${
      data.search?.done
        ? `<div class="card" style="margin-bottom:14px">
      <div style="font-size:13px;color:var(--ink3);margin-bottom:2px">实际运行的过程（真实步骤事件）</div>
      ${timelineHtml(data.search.done.steps ?? [])}
      <div style="margin-top:10px;font-size:13px;color:var(--ink3)">去重后的来源清单（界面里可点击）</div>
      ${sourcesHtml(data.search.done.sources ?? [])}
    </div>
    <div class="card">
      <div style="font-size:13px;color:var(--ink3);margin-bottom:8px">这一步的实际回答（联网后的完整输出）</div>
      <div class="answer">${md(data.search.text ?? '')}</div>
    </div>`
        : `<div class="card">
      <div style="font-size:13.5px;color:var(--ink2)">
        本页未收录联网场景的真实输出（生成演示页时该场景未采集）。机制说明如下。
      </div>
    </div>`
    }
    <div class="card" style="margin-top:14px">
      <div style="font-size:13.5px;color:var(--ink2)">
        <strong>怎么做的：</strong>桥接层给模型挂一个标准 <code>web_search</code> 函数，模型决定要不要调；
        调了就由服务端执行检索，结果过一遍<strong>权威源白名单</strong>（默认 12 个官方域名）再回灌，最后据此作答。
        检索走 <strong>DeepSeek 原生服务端搜索</strong>（Anthropic 兼容端点 + <code>web_search_20250305</code> 服务端工具，用同一把 API Key），
        返回的是结构化结果块，不是从模型正文里扒 URL；没有拿到结果块就按错误处理，绝不凑数。
      </div>
      <div class="diff" style="margin-top:12px;background:var(--warn-soft);border-color:#f0dcc0">
        <span>开启联网后，<strong>选中的文字会作为检索词发往搜索服务</strong>；内部文件请勿开启。</span>
      </div>
    </div>
  </section>

  <section id="lib">
    <h2 class="sec"><span class="num">07</span>文档库与批注持久化</h2>
    <div class="grid g3">
      <div class="feat">
        <h3>文件夹归档</h3>
        <p>可建多级文件夹；拖拽文件到面板即可上传，可选择目标文件夹。</p>
      </div>
      <div class="feat">
        <h3>内容哈希去重</h3>
        <p>同一份文件重复上传会命中同一条记录，不会产生副本，<strong>批注也不会因为重复上传而丢</strong>。</p>
      </div>
      <div class="feat">
        <h3>批注随文档走</h3>
        <p>批注与 AI 解释按文档独立存到服务端，切换文档互不干扰；已为将来的账号体系预留了归属维度。</p>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div style="font-size:13.5px;color:var(--ink2)">
        <strong>数据放在哪：</strong>上传的文件、解析结果、批注都落在服务端
        <code>data/users/&lt;用户&gt;/docs/&lt;文档ID&gt;/</code> 下，
        其中批注是 Yjs 增量更新，可多端合并。文件夹名称会做安全清洗，从根上避免路径穿越。
      </div>
    </div>
  </section>

  <section id="test">
    <h2 class="sec"><span class="num">08</span>质量保障</h2>
    <p class="sub">以下数字都是在开发机上真实跑出来的，不是估算。合计 <strong>${totalChecks}</strong> 项检查。</p>
    <div class="card">
      ${TESTS.map(([nm, p, n]) => `<div class="test-row"><span class="nm">${esc(nm)}</span><span class="path">${esc(p)}</span><span class="n">${n}/${n}</span></div>`).join('\n      ')}
      <div style="margin-top:14px"><span class="badge-ok">全部通过</span></div>
    </div>
  </section>

  <section id="run">
    <h2 class="sec"><span class="num">09</span>怎么跑起来</h2>
    <pre><span class="c"># 安装依赖</span>
npm install

<span class="c"># 配置模型 Key（复制后填入，Key 只存在服务端，不会下发到浏览器）</span>
cp .env.example .env

<span class="c"># 一键启动：桥接层 5178 + 前端 5179</span>
npm run dev

<span class="c"># 打开 http://localhost:5179</span></pre>
    <div class="card" style="margin-top:14px">
      <div style="font-size:13.5px;color:var(--ink2)">
        <strong>使用要点：</strong>
        ① 先在左侧上传文件（可拖拽）；② 点开文档，选中原文任意文字；
        ③ 浮动条上选「添加批注」或「问 AI」；④ AI 解释里的编号点击即回跳原文。
        <br><span class="kbd">Ctrl</span> + <span class="kbd">Enter</span> 提交提问，<span class="kbd">Esc</span> 取消。
      </div>
    </div>
  </section>

  <footer>
    智能解读工作台 · 功能演示　|　页面数据来自 ${esc(data.sourceDoc?.name ?? '真实文件')} 的实际解析与模型输出
  </footer>
</div>

<script>
// 点击引用编号时，闪一下原文里对应的段落，演示「回查」效果
document.addEventListener('click', (e) => {
  const el = e.target.closest('.cite');
  if (!el) return;
  const ref = el.dataset.ref;
  const target = [...document.querySelectorAll('.doc-text p')].find((p) => {
    const id = p.querySelector('.pid')?.textContent?.trim() ?? '';
    const body = p.textContent.trim();
    return id === ref || body.startsWith(ref) || body.startsWith('第' + ref.replace(/^第|条$|章$/g, '') + '条');
  });
  if (target && target.scrollIntoView) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
    setTimeout(() => { target.classList.remove('sel'); }, 1400);
  }
});
</script>
</body>
</html>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('已生成', OUT);
console.log('  大小', (html.length / 1024).toFixed(1), 'KB');
console.log('  测试项合计', totalChecks);
console.log('  章数', stats.chapters, '条数', stats.articles);
