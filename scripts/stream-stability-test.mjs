/**
 * 流式解释稳定性测试：同一请求连跑 N 次，确认答案不为空。
 *
 * 背景：V4.1-Flash 的 reasoning_content 与答案共用 max_tokens 配额，
 * 且 reasoning 长度波动很大（实测 0～1500+ 字）。若预算算小了，
 * 模型会把配额全花在推理上、可见答案为空 —— 前端表现为一直空白。
 * 此脚本用于回归这类「偶发空答案」。
 *
 *   node scripts/stream-stability-test.mjs [次数]
 */
const PORT = process.env.PORT || 5178;
const BASE = `http://127.0.0.1:${PORT}`;
const ROUNDS = Number(process.argv[2]) || 5;

/** 密级闸门要求带 docId：取一个已存在的公开档 */
async function ensurePublicDocId() {
  const r = await fetch(`${BASE}/api/files/tree`);
  const tree = await r.json();
  const found = tree.docs?.find((d) => d.level === 'public' && d.supported !== false);
  if (found) return found.id;
  const fd = new FormData();
  fd.append('files', new Blob([Buffer.from('第一条 稳定性测试用文档。', 'utf8')]), 'stability-public.txt');
  fd.append('level', 'public');
  const up = await fetch(`${BASE}/api/files/upload`, { method: 'POST', body: fd });
  const j = await up.json();
  return j?.results?.[0]?.docId ?? '';
}

const PUBLIC_DOC_ID = await ensurePublicDocId();

const CASES = [
  {
    name: '小段落 + 具体提问',
    body: {
      text: '补贴标准为本科 2 万元、硕士研究生 5 万元、博士研究生 10 万元',
      paragraphText:
        '新引进的青年人才可一次性享受生活补贴。补贴标准为本科 2 万元、硕士研究生 5 万元、博士研究生 10 万元，分两期发放，首期在签订劳动合同并缴纳社保满 6 个月后发放。',
      paragraphId: 'P-3-1',
      question: '我硕士毕业，能拿多少？',
      maxDepth: 0,
    },
  },
  {
    name: '短选区 + 无提问',
    body: {
      text: '租金标准原则上不超过该地段同品质市场租金的 60%',
      paragraphText:
        '符合条件的青年人才可申请入住人才公寓。人才公寓房源由市住房保障部门统一筹集和分配，租金标准原则上不超过该地段同品质市场租金的 60%。',
      paragraphId: 'P-2-1',
      maxDepth: 0,
      question: '',
    },
  },
  {
    name: '模糊表述（触发不确定处理）',
    body: {
      text: '优惠的具体标准由市相关部门另行制定并公布',
      paragraphText:
        '青年人才在本市乘坐公共交通、购买高铁动车票、市内公立医院就诊时，可享受优惠便利服务。优惠的具体标准由市相关部门另行制定并公布。',
      paragraphId: 'P-3-3',
      question: '我能享受什么优惠？',
      maxDepth: 0,
    },
  },
];

async function readSse(body) {
  const resp = await fetch(`${BASE}/api/ai/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId: PUBLIC_DOC_ID, ...body }),
  });
  if (!resp.ok) {
    return { ok: false, error: (await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}` };
  }
  let text = '';
  let reasoning = '';
  let done = null;
  let err = null;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let e;
        try { e = JSON.parse(payload); } catch { continue; }
        if (e.t) text += e.t;
        if (e.r) reasoning += e.r;
        if (e.error) err = e;
        if (e.done) done = e;
      }
    }
  }
  return { ok: true, text, reasoning, done, err };
}

console.log(`\n流式解释稳定性测试：每种场景连跑 ${ROUNDS} 次\n目标：${BASE}\n`);

let pass = 0;
let fail = 0;
const failures = [];

for (const { name, body } of CASES) {
  console.log(`▸ ${name}`);
  const lens = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const t0 = Date.now();
    const r = await readSse(body);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!r.ok) {
      fail++; failures.push(`${name} #${i}: ${r.error}`);
      console.log(`    \x1b[31m✗\x1b[0m #${i} 请求失败 ${r.error}`);
      continue;
    }
    const answerLen = (r.text || '').length;
    const reasonLen = (r.reasoning || '').length;
    lens.push(answerLen);
    const good =
      answerLen > 0 &&
      r.done?.done === true &&
      (r.done?.profile === 'explain' || r.done?.profile === 'strict') &&
      !r.err;
    if (good) pass++; else { fail++; failures.push(`${name} #${i}: 答案 ${answerLen} 字`); }
    console.log(
      `    ${good ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} #${i}  答案 ${String(answerLen).padStart(4)} 字 · 推理 ${String(reasonLen).padStart(4)} 字 · ${secs}s · 档位 ${r.done?.profile ?? '(缺失)'}`,
    );
  }
  if (lens.length) {
    const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
    console.log(`    → 平均答案 ${avg} 字，最短 ${Math.min(...lens)} 字${Math.min(...lens) === 0 ? ' \x1b[31m(出现空答案！)\x1b[0m' : ''}`);
  }
  console.log('');
}

console.log(`结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  console.log('');
  process.exit(1);
}
