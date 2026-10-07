/**
 * 端到端复核：用**用户真机那条提问**跑一轮，看模型还会不会说「只检索到标题」。
 *
 * 复刻卡片场景：段落 P-11-12，引用「建立健全组织部门、统战部门协作配合机制。」，
 * 提问「一般有什么协作配合机制」。
 *
 * 会临时打开联网（讲透档），跑完恢复原来的设置。
 *
 * 跑法：node wb/probe-e2e-followup.mjs
 */
const BASE = `http://localhost:${process.env.PORT || 5178}`;

const ask = async (path, init) => {
  const r = await fetch(BASE + path, init);
  return r.json();
};

// 1) 记住原设置，临时开联网 + 讲透档
const original = await ask('/api/settings');
console.log('原设置：profile=%s searchEnabled=%s', original.profile, original.searchEnabled);
await ask('/api/settings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ profile: 'explain', searchEnabled: true }),
});

const body = {
  text: '建立健全组织部门、统战部门协作配合机制。',
  paragraphText:
    '建立健全组织部门、统战部门协作配合机制。在动议和讨论决定党外干部的任免、调动、交流前，应当征求统战部门的意见。',
  paragraphId: 'P-11-12',
  question: '一般有什么协作配合机制',
  maxDepth: 0,
};

const t0 = Date.now();
const resp = await fetch(`${BASE}/api/ai/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
console.log('HTTP', resp.status);

const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = '';
let text = '';
let done = null;
const steps = new Map();
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
      if (evt.step) steps.set(evt.step.key, evt.step);
      else if (evt.t) text += evt.t;
      else if (evt.reset) text = '';
      else if (evt.done) done = evt;
    }
  }
}

console.log('\n── 步骤 ──');
for (const s of steps.values()) {
  console.log(`  ${String(s.status).padEnd(8)} ${s.label}${s.detail ? '  「' + s.detail + '」' : ''}${s.items ? `  (${s.items.length} 条)` : ''}`);
}
console.log(
  `\n轮次=${done?.rounds} 检索=${done?.searched} 来源=${done?.sources?.length} 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s profile=${done?.profile}`,
);

console.log('\n── 模型是否还在抱怨只有标题？ ──');
const complaints = ['只返回了标题', '只有标题', '没有正文内容', '只返回标题', '无法获取正文', '取不到正文'];
const hits = complaints.filter((c) => text.includes(c));
console.log(hits.length ? `⚠ 仍出现：${hits.join(' / ')}` : '✓ 未出现「只有标题/没有正文」类表述');

console.log('\n── 答案正文 ──\n');
console.log(text);

// 2) 恢复原设置
await ask('/api/settings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ profile: original.profile, searchEnabled: original.searchEnabled === true }),
});
console.log('\n（已恢复原设置）');
