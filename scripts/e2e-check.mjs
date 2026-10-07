/**
 * 端到端验证：不需要真实浏览器，用 Node 直接打后端接口。
 * 覆盖 README「接口」一节承诺的全部契约。
 *
 *   node scripts/e2e-check.mjs            # 只跑不需要 API Key 的用例
 *   node scripts/e2e-check.mjs --with-ai  # 连通模型（需 .env 中已配置 Key）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSystemPrompt,
  EXPLAIN_SYSTEM_PROMPT,
  EXPLAIN_STYLE_PROMPT,
  STRICT_SYSTEM_PROMPT,
} from '../server/policy-prompt.js';
import { TOOL_USAGE_PROMPT } from '../server/search/tool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// 复用后端 .env，让 e2e 与 dev:server 读同一份配置
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const PORT = process.env.PORT || 5178;
const BASE = `http://127.0.0.1:${PORT}`;
const WITH_AI = process.argv.includes('--with-ai');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function getJson(p) {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json() };
}

/**
 * 前置：确保库里存在一个「公开」文档。
 *
 * 密级闸门要求 AI 请求必须带 docId（否则客户端不带 docId 就能绕过策略），
 * 所以 AI 用例都要引用一个真实存在的公开档。
 */
async function ensurePublicDoc() {
  const tree = await getJson('/api/files/tree');
  const existing = tree.body?.docs?.find((d) => d.level === 'public' && d.supported !== false);
  if (existing) return existing.id;

  const fd = new FormData();
  fd.append('files', new Blob([Buffer.from('第一条 本文件仅供测试。\n第二条 第二段。', 'utf8')]), 'e2e-public.txt');
  fd.append('level', 'public');
  const r = await fetch(`${BASE}/api/files/upload`, { method: 'POST', body: fd });
  const j = await r.json();
  return j?.results?.[0]?.docId ?? '';
}

/** 读一条 SSE 流，返回聚合结果 */
async function readSse(body) {
  const resp = await fetch(`${BASE}/api/ai/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    return { status: resp.status, error: await resp.json().catch(() => ({})) };
  }
  let text = '';
  let reasoning = '';
  let started = null;
  let done = null;
  let streamError = null;
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
        if (e.phase) started = e;
        if (e.t) text += e.t;
        if (e.r) reasoning += e.r;
        if (e.error) streamError = e;
        if (e.done) done = e;
      }
    }
  }
  return { status: resp.status, text, reasoning, started, done, streamError };
}

// ── 离线段：system prompt 组装不依赖服务端是否在跑，放最前面先跑
console.log('[0] system prompt 组装（离线）');
{
  const explain = buildSystemPrompt({ profile: 'explain', searchActive: false });
  check('explain 恰好是「档位正文 + 回答规范」', explain === `${EXPLAIN_SYSTEM_PROMPT}\n\n${EXPLAIN_STYLE_PROMPT}`);
  check('explain 以档位正文开头', explain.startsWith(EXPLAIN_SYSTEM_PROMPT));
  check('explain 以回答规范结尾', explain.endsWith(EXPLAIN_STYLE_PROMPT));
  check('explain 不含 strict 的回避话术', !explain.includes('该问题需要参考其他条款'));
  check('explain 不含 strict 档正文', !explain.includes(STRICT_SYSTEM_PROMPT));
  check('explain 未联网时不带检索规范', !explain.includes(TOOL_USAGE_PROMPT));

  const strict = buildSystemPrompt({ profile: 'strict', searchActive: false });
  check('strict 逐字节等于 STRICT_SYSTEM_PROMPT', strict === STRICT_SYSTEM_PROMPT, `${strict.length} vs ${STRICT_SYSTEM_PROMPT.length}`);
  check('strict 不含回答规范', !strict.includes(EXPLAIN_STYLE_PROMPT));
  check('strict 不含讲透档正文', !strict.includes(EXPLAIN_SYSTEM_PROMPT));

  const explainSearch = buildSystemPrompt({ profile: 'explain', searchActive: true });
  check(
    'explain+联网 同时含检索规范与回答规范',
    explainSearch.includes(TOOL_USAGE_PROMPT) && explainSearch.includes(EXPLAIN_STYLE_PROMPT),
  );
  check('explain+联网 回答规范仍在最后', explainSearch.endsWith(EXPLAIN_STYLE_PROMPT));
  check(
    'explain+联网 顺序为 正文 → 检索规范 → 回答规范',
    explainSearch.startsWith(EXPLAIN_SYSTEM_PROMPT) &&
      explainSearch.indexOf(TOOL_USAGE_PROMPT) > EXPLAIN_SYSTEM_PROMPT.length &&
      explainSearch.indexOf(EXPLAIN_STYLE_PROMPT) > explainSearch.indexOf(TOOL_USAGE_PROMPT),
  );

  const strictSearch = buildSystemPrompt({ profile: 'strict', searchActive: true });
  check('strict+联网 仍不带检索规范（严格依据档绝不联网）', !strictSearch.includes(TOOL_USAGE_PROMPT));
  check('strict+联网 仍逐字节等于 STRICT_SYSTEM_PROMPT', strictSearch === STRICT_SYSTEM_PROMPT);

  const dflt = buildSystemPrompt();
  check('不传参数按 explain 处理', dflt === explain && dflt.endsWith(EXPLAIN_STYLE_PROMPT));
}

console.log(`\n目标服务：${BASE}\n`);

console.log('[1] 健康检查');
{
  const { status, body } = await getJson('/api/health');
  check('GET /api/health 返回 200', status === 200, `实际 ${status}`);
  check('健康检查含 ok=true', body?.ok === true);
  check('健康检查回显模型名', typeof body?.model === 'string' && body.model.length > 0, body?.model);
  check(
    '健康检查暴露限额配置',
    body?.limits?.maxTextChars === 4000 && body?.limits?.maxDepth === 6,
    JSON.stringify(body?.limits),
  );
  check(
    body?.keyConfigured ? 'API Key 已配置' : 'API Key 未配置（跳过 AI 用例）',
    typeof body?.keyConfigured === 'boolean',
  );
  check(
    '健康检查暴露解释档位 profile',
    body?.profile === 'explain' || body?.profile === 'strict',
    JSON.stringify(body?.profile),
  );
  check('健康检查不再下发旧字段 constraints', !('constraints' in (body || {})), Object.keys(body || {}).join(','));
  if (!body?.keyConfigured) {
    console.log('      \x1b[33m→ 未配置 DEEPSEEK_API_KEY，AI 相关用例将只校验错误分支\x1b[0m');
  }
}

console.log('\n[2] 设置读写');
{
  const { body: before } = await getJson('/api/settings');
  const originalEnabled = before?.enabled;
  const originalModel = before?.model;
  const originalProfile = before?.profile;

  check(
    'GET /api/settings 返回两档之一',
    originalProfile === 'explain' || originalProfile === 'strict',
    JSON.stringify(originalProfile),
  );
  check('GET /api/settings 不再下发旧字段 constraints', !('constraints' in (before || {})));
  check(
    'profileOptions 两档齐全且顺序为 讲透 → 严格依据',
    JSON.stringify(before?.profileOptions?.map((o) => o.value)) === JSON.stringify(['explain', 'strict']),
    JSON.stringify(before?.profileOptions),
  );
  check(
    'profileOptions[0] 文案为讲透',
    before?.profileOptions?.[0]?.label === '讲透' &&
      before?.profileOptions?.[0]?.desc === '把话讲透，术语当场讲清、可补背景，补充会标注为补充。',
    JSON.stringify(before?.profileOptions?.[0]),
  );
  check(
    'profileOptions[1] 文案为严格依据',
    before?.profileOptions?.[1]?.label === '严格依据' &&
      before?.profileOptions?.[1]?.desc === '只用原文作答，逐条标出依据段落，要写材料、要经得起对照时用。',
    JSON.stringify(before?.profileOptions?.[1]),
  );

  const r = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  const off = await r.json();
  check('POST /api/settings 可关闭开关', off?.enabled === false);

  const { body: afterOff } = await getJson('/api/settings');
  check('关闭状态已持久到运行时', afterOff?.enabled === false);

  // 档位写入：只接受两档枚举，非法值静默忽略并回落（不返回 400）
  const setProfile = async (profile) => {
    const resp = await fetch(`${BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    return { status: resp.status, body: await resp.json() };
  };

  const toStrict = await setProfile('strict');
  check('POST /api/settings 可切到严格依据档', toStrict.body?.profile === 'strict', JSON.stringify(toStrict.body?.profile));
  const { body: strictNow } = await getJson('/api/settings');
  check('严格依据档已持久到运行时', strictNow?.profile === 'strict');

  const toExplain = await setProfile('explain');
  check('POST /api/settings 可切回讲透档', toExplain.body?.profile === 'explain', JSON.stringify(toExplain.body?.profile));

  const bad = await setProfile('brief');
  check('非法档位不返回 4xx', bad.status === 200, `实际 ${bad.status}`);
  check('非法档位被忽略并回落讲透档', bad.body?.profile === 'explain', JSON.stringify(bad.body?.profile));

  const r2 = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: originalEnabled, model: originalModel, profile: originalProfile }),
  });
  await r2.json();
  const { body: restored } = await getJson('/api/settings');
  check('设置可恢复原值', restored?.enabled === originalEnabled && restored?.model === originalModel);
  check('档位恢复原值', restored?.profile === originalProfile, `${restored?.profile} vs ${originalProfile}`);
}

// 密级闸门要求带 docId，AI 与校验用例都引用这个公开档
const PUBLIC_DOC_ID = await ensurePublicDoc();
console.log(`\n前置：公开档 docId = ${PUBLIC_DOC_ID || '(无)'}`);

console.log('\n[3] 请求校验（错误分支）');
{
  const post = (body) =>
    fetch(`${BASE}/api/ai/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId: PUBLIC_DOC_ID, ...body }),
    });

  const noText = await post({ question: '无选中内容' });
  check('缺 text 返回 4xx', noText.status >= 400 && noText.status < 500, `实际 ${noText.status}`);

  const tooLong = await post({ text: '啊'.repeat(5000) });
  check('text 超 4000 字返回 413', tooLong.status === 413, `实际 ${tooLong.status}`);

  const tooDeep = await post({ text: '测试', maxDepth: 9, parentAnswer: '上文' });
  check('maxDepth 超 6 被拒', tooDeep.status === 400, `实际 ${tooDeep.status}`);

  const deepNoParent = await post({ text: '测试', maxDepth: 2 });
  check('追问缺 parentAnswer 被拒', deepNoParent.status === 400, `实际 ${deepNoParent.status}`);

  const badOrigin = await fetch(`${BASE}/api/ai/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ docId: PUBLIC_DOC_ID, text: '测试' }),
  });
  check('跨源请求返回 403', badOrigin.status === 403, `实际 ${badOrigin.status}`);

  const getInstead = await fetch(`${BASE}/api/ai/stream`);
  check('GET /api/ai/stream 不被接受（非 POST 落到静态托管）', getInstead.status === 404, `实际 ${getInstead.status}`);
}

console.log('\n[4] 静态资源与 SPA 回退');
{
  const favicon = await fetch(`${BASE}/favicon.svg`);
  check('桥接层可托管 favicon.svg', favicon.status === 200, `实际 ${favicon.status}`);

  const spa = await fetch(`${BASE}/some/spa/route`);
  check('SPA 路由回退到 index.html', spa.status === 200, `实际 ${spa.status}`);

  // 回归：回退正则曾把 index.html 返回给缺失的 .js 请求，
  // 浏览器只能报 MIME 错误，排查成本极高。这里锁定 JSON 404。
  const missingJs = await fetch(`${BASE}/assets/definitely-missing.js`);
  check('缺失的 .js 返回 404 而非 HTML', missingJs.status === 404, `实际 ${missingJs.status}`);
  const ct = missingJs.headers.get('content-type') || '';
  check('缺失的 .js 返回 JSON 404', ct.includes('application/json'), ct);

  const missingApi = await fetch(`${BASE}/api/nope`);
  check('未知 API 返回 404 JSON', missingApi.status === 404, `实际 ${missingApi.status}`);
}

if (WITH_AI) {
  console.log('\n[5] 流式解释（需要 API Key）');
  const health = await getJson('/api/health');
  if (!health.body?.keyConfigured) {
    console.log('  \x1b[33m→ 未配置 Key，跳过\x1b[0m');
  } else {
    const r = await readSse({
      docId: PUBLIC_DOC_ID,
      text: '补贴标准为本科 2 万元、硕士研究生 5 万元、博士研究生 10 万元',
      paragraphText:
        '新引进的青年人才可一次性享受生活补贴。补贴标准为本科 2 万元、硕士研究生 5 万元、博士研究生 10 万元，分两期发放，首期在签订劳动合同并缴纳社保满 6 个月后发放。',
      paragraphId: 'P-3-1',
      question: '我硕士毕业，能拿多少？',
      maxDepth: 0,
    });

    check('流式请求未返回 HTTP 错误', r.status === 200, JSON.stringify(r.error || ''));
    check('收到 phase:start 事件', r.started?.phase === 'start', JSON.stringify(r.started));
    check('收到可见答案增量', (r.text || '').length > 0);
    check('收到 done 事件', r.done?.done === true);
    check('done 携带免责声明', typeof r.done?.disclaimer === 'string' && r.done.disclaimer.length > 0, r.done?.disclaimer);
    check(
      'done 携带档位 profile',
      r.done?.profile === 'explain' || r.done?.profile === 'strict',
      JSON.stringify(r.done?.profile),
    );
    check('done 不再下发旧字段 constraints', !('constraints' in (r.done || {})));
    check('未透传内部错误', !r.streamError, JSON.stringify(r.streamError));

    // 追问链路
    const r2 = await readSse({
      docId: PUBLIC_DOC_ID,
      text: '',
      paragraphText: '',
      paragraphId: 'P-3-1',
      question: '第二期什么时候发？',
      maxDepth: 1,
      parentAnswer: r.text || '上文回答',
    });
    check('追问链路返回 200', r2.status === 200, JSON.stringify(r2.error || ''));
    check('追问有回答内容', (r2.text || '').length > 0);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  console.log('');
  process.exit(1);
}
