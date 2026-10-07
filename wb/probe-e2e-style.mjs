/**
 * 讲透档「回答规范」验收探针：用真机那段原文（P-12-1「两个维护」）跑一轮，量化"废话"。
 *
 * 输出六项：①字数（含去空白）②「※ 补充」次数 ③末尾是否还有单独免责段
 *          ④元讨论小节 ⑤没人问的章节 ⑥四个意识/四个自信是否保留
 * 并打印答案末尾 400 字，便于人眼核对。
 *
 * 跑法：node wb/probe-e2e-style.mjs [问题]
 */
import 'dotenv/config';

const BASE = `http://localhost:${process.env.PORT || 5178}`;
const QUESTION = process.argv[2] || '两个维护是什么';

const TEXT = "增强'四个意识'、坚定'四个自信'、做到'两个维护'";
const PARAGRAPH =
  "坚持党的全面领导，增强'四个意识'、坚定'四个自信'、做到'两个维护'，把党的意志和主张贯彻到统一战线工作各方面和全过程。";

const settings = await (await fetch(`${BASE}/api/settings`)).json();
// 讲透档 + 关联网，单独观察"回答规范"的效果
await fetch(`${BASE}/api/settings`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ profile: 'explain', searchEnabled: false }),
});

const resp = await fetch(`${BASE}/api/ai/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: TEXT, paragraphText: PARAGRAPH, paragraphId: 'P-12-1', question: QUESTION, maxDepth: 0 }),
});

const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = '';
let text = '';
let done = null;
while (true) {
  const { done: fin, value } = await reader.read();
  if (fin) break;
  buf += dec.decode(value, { stream: true });
  const frames = buf.split('\n\n');
  buf = frames.pop() ?? '';
  for (const f of frames) {
    for (const line of f.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (!p) continue;
      const evt = JSON.parse(p);
      if (evt.t) text += evt.t;
      else if (evt.reset) text = '';
      else if (evt.done) done = evt;
    }
  }
}

// 恢复设置
await fetch(`${BASE}/api/settings`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ profile: settings.profile, searchEnabled: settings.searchEnabled === true }),
});

const noSpace = text.replace(/\s/g, '');
const supplementCount = (text.match(/※\s*补充/g) || []).length;
const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
const last = paragraphs.at(-1) ?? '';
const trailingDisclaimer = /^[>\s]*(※|注|提醒|说明)[：:]?/.test(last) || /无法联网|可能已过时|以现行/.test(last);
const META = ['为什么原文', '为什么只点', '点到为止', '固定用语', '不展开', '为什么这么写', '因此没有展开'];
const metaSections = META.filter((k) => text.includes(k));
const UNASKED = ['什么情况下用得上', '什么情况下会用到', '什么时候用得上'];
const unaskedSections = UNASKED.filter((k) => text.includes(k));
const keepsSiblings =
  /四个意识/.test(text) && /政治意识|大局意识|核心意识|看齐意识/.test(text) &&
  /四个自信/.test(text) && /道路自信|理论自信|制度自信|文化自信/.test(text);

console.log(`\n问题：${QUESTION}`);
console.log(`档位：explain（讲透）· 联网：关 · 轮次=${done?.rounds} 耗时≈${done?.elapsedMs}ms\n`);
console.log('──── 六项指标 ────');
console.log(`① 字数：${text.length}（去空白 ${noSpace.length}）`);
console.log(`② 「※ 补充」次数：${supplementCount}   ${supplementCount <= 1 ? '✓' : '✗ 应 ≤1'}`);
console.log(`③ 末尾单独免责/时效段：${trailingDisclaimer ? '✗ 仍有' : '✓ 无'}`);
console.log(`④ 元讨论小节：${metaSections.length ? '✗ ' + metaSections.join('/') : '✓ 0'}`);
console.log(`⑤ 没人问的章节：${unaskedSections.length ? '✗ ' + unaskedSections.join('/') : '✓ 0'}`);
console.log(`⑥ 四个意识/四个自信 保留：${keepsSiblings ? '✓ 有简短说明' : '✗ 没讲'}`);
console.log(`\n──── 末尾 400 字 ────\n${text.slice(-400)}\n`);
console.log('──── 全文 ────\n' + text);
