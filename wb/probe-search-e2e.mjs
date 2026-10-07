/**
 * 端到端探针：跑一轮「带检索工具」的真实模型调用，逐帧打印 SSE 事件。
 *
 * 用途：验证 agent-loop 的 function calling 链路 + 前端要消费的 step/sources/done 字段。
 * 前提：另一个进程已用 SEARCH_PROVIDER=mock SEARCH_ENABLED=1 启动桥接层。
 *
 *   node wb/probe-search-e2e.mjs [port] [question]
 */

const port = process.argv[2] || '5188';
const question =
  process.argv[3] || '这段话里提到的机构，全称和职能是什么？请查一下官方口径。';

const body = {
  text: '建立健全非公有制经济人士综合评价体系，完善统战工作格局。',
  question,
  paragraphText:
    '第十五条 建立健全非公有制经济人士综合评价体系，发挥工商联、行业协会商会在政治引导、政策解读、权益维护等方面的作用，完善统战工作格局。',
  paragraphId: 'P-3-2',
  depth: 0,
};

const resp = await fetch(`http://localhost:${port}/api/ai/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

console.log('HTTP', resp.status, resp.headers.get('content-type'));
if (!resp.ok) {
  console.log(await resp.text());
  process.exit(1);
}

const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = '';
let text = '';
const seen = new Map();
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
      const payload = line.slice(5).trim();
      if (!payload) continue;
      const evt = JSON.parse(payload);
      if (evt.step) {
        seen.set(evt.step.key, evt.step);
        const s = evt.step;
        console.log(
          `  [step] ${s.key.padEnd(14)} ${String(s.kind).padEnd(7)} ${String(s.status).padEnd(8)} ${s.label}` +
            (s.detail ? `   detail=「${s.detail}」` : '') +
            (s.items ? `   items=${s.items.length}` : '') +
            (s.elapsedMs ? `   ${s.elapsedMs}ms` : ''),
        );
      } else if (evt.reset) {
        console.log('  [reset] 清空正文缓冲');
        text = '';
      } else if (evt.r) {
        /* 推理增量不逐条打印 */
      } else if (evt.t) {
        text += evt.t;
      } else if (evt.done) {
        done = evt;
      } else if (evt.error) {
        console.log('  [error]', evt.error, evt.detail || '');
      }
    }
  }
}

console.log('\n--- done ---');
console.log(
  JSON.stringify(
    {
      steps: done?.steps?.length,
      rounds: done?.rounds,
      searched: done?.searched,
      elapsedMs: done?.elapsedMs,
      reasoningChars: done?.reasoningChars,
      constraints: done?.constraints,
      disclaimer: done?.disclaimer,
      sources: (done?.sources || []).map((s) => s.url),
    },
    null,
    2,
  ),
);
console.log('\n--- 正文 ---\n' + text);
console.log('\n正文长度:', text.length);
