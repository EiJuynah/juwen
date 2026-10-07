/**
 * 探针：DeepSeek 在 stream:true 下对 tools / function calling 的真实行为。
 *
 * 要回答的问题（文档没说清楚，必须实测）：
 *   1. 加了 tools 之后，模型会不会返回 tool_calls？
 *   2. 流式下 tool_calls 怎么分片？arguments 是一次给全还是增量拼接？
 *   3. tool_calls 那一轮还带不带 reasoning_content？能否共存？
 *   4. 第二轮回灌 role:'tool' 之后能不能出可见答案？
 *   5. 循环要不要设轮次上限？最后一轮摘掉 tools 有没有用？
 *
 * 跑法：node wb/probe-deepseek-tools.mjs
 */
import 'dotenv/config';

const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';

const MAX_ROUNDS = 3;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '在权威政务网站上检索公开资料。当需要确认最新规定、机构名称、政策原文出处等你自己无法确定的信息时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词，简洁，不超过 30 字' },
        },
        required: ['query'],
      },
    },
  },
];

/** 流式请求 + tool_calls 分片拼接 */
async function callStream(messages, { withTools, label }) {
  const t0 = Date.now();
  const body = {
    model: MODEL,
    messages,
    stream: true,
    temperature: 0.3,
    max_tokens: 8000,
    ...(process.env.DEEPSEEK_EFFORT ? { effort: process.env.DEEPSEEK_EFFORT } : {}),
  };
  if (withTools) body.tools = TOOLS;

  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    console.log(`\n[${label}] HTTP ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
    return null;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let reasoning = 0;
  let content = '';
  let finish = null;
  const toolCalls = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const frame of parts) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        let j;
        try {
          j = JSON.parse(p);
        } catch {
          continue;
        }
        const ch = j.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finish = ch.finish_reason;
        const d = ch.delta || {};
        if (d.reasoning_content) reasoning += d.reasoning_content.length;
        if (d.content) content += d.content;
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls.has(idx)) toolCalls.set(idx, { id: '', name: '', argChunks: [] });
            const slot = toolCalls.get(idx);
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.argChunks.push(tc.function.arguments);
          }
        }
      }
    }
  }

  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n═══ [${label}] ${cost}s  finish=${finish}  reasoning=${reasoning}字  content=${content.length}字  tool_calls=${toolCalls.size}个${withTools ? '' : '（未挂 tools）'} ═══`,
  );
  return { finish, toolCalls, content, reasoning };
}

// ── 检索：用真实检索层，但 provider 换成「与问题相关」的假数据，
//    以便观察模型拿到**有用资料**时是否就收敛作答
const { createSearchService } = await import('../server/search/index.js');

const RELEVANT = [
  {
    title: '中华人民共和国民营经济促进法',
    url: 'https://www.gov.cn/yaowen/liebiao/202504/content_7020000.htm',
    snippet:
      '2025年4月30日，十四届全国人大常委会第十五次会议表决通过《中华人民共和国民营经济促进法》，自2025年5月20日起施行。该法是我国第一部专门关于民营经济发展的基础性法律。',
    site: '中国政府网',
    publishedAt: '2025-04-30',
  },
  {
    title: '民营经济促进法立法过程',
    url: 'https://www.npc.gov.cn/npc/c2/c30834/202504/t20250430_444444.html',
    snippet:
      '2024年10月草案首次提请审议，2024年12月二审，2025年2月三审，2025年4月30日表决通过，历时约半年，两次向社会公开征求意见。',
    site: '中国人大网',
    publishedAt: '2025-04-30',
  },
  {
    title: '促进民营经济健康发展高质量发展',
    url: 'https://www.news.cn/politics/20250430/abc123/c.html',
    snippet: '民营经济促进法确立平等对待、公平竞争、同等保护原则，保障民营经济组织公平参与市场竞争。',
    site: '新华网',
    publishedAt: '2025-04-30',
  },
  { title: '知乎讨论', url: 'https://www.zhihu.com/question/1', snippet: '非权威源，应被滤除' },
];

const svc = createSearchService({
  provider: {
    name: 'probe-fixture',
    configured: true,
    async search(q, { count }) {
      console.log(`     [provider] query="${q}" count=${count}`);
      return RELEVANT.slice(0, count);
    },
  },
});

// ── 主循环
const system = {
  role: 'system',
  content:
    '你是一位善于讲解政策与公文的中文助手。可以补充原文之外的常识与背景，但要把「原文所说」与「补充说明」区分开。' +
    '你有一个 web_search 工具可以检索权威政务网站；如果问题涉及你无法确定的最新法规、日期或机构信息，先检索再作答。' +
    '拿到检索结果后要据此作答并标明来源序号（如「据资料 1」）；资料与问题无关时不要硬套。',
};

const messages = [
  system,
  { role: 'user', content: process.argv[2] || '通俗讲讲《民营经济促进法》是哪一年通过的，说一下立法背景。' },
];

const log = { rounds: 0, searches: 0, sources: [], ms: Date.now() };
let final = null;

for (let round = 1; round <= MAX_ROUNDS; round++) {
  log.rounds = round;
  // 最后一轮摘掉 tools，强制模型作答（否则它可能一直搜下去）
  const withTools = round < MAX_ROUNDS;
  const r = await callStream(messages, { withTools, label: `轮次${round}${withTools ? '' : ' 无tools强制作答'}` });
  if (!r) break;

  if (r.toolCalls.size === 0) {
    final = r;
    break;
  }

  // 把 assistant 的 tool_calls 原样写回历史
  messages.push({
    role: 'assistant',
    content: r.content || null,
    tool_calls: [...r.toolCalls.entries()].map(([i, tc]) => ({
      index: i,
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.argChunks.join('') },
    })),
  });

  // 逐个 tool_call 执行检索并回灌——少一条就 400
  for (const [, tc] of r.toolCalls) {
    let query = '';
    try {
      query = JSON.parse(tc.argChunks.join('')).query || '';
    } catch {
      query = tc.argChunks.join('');
    }
    const res = await svc.searchWeb(query);
    log.searches++;
    for (const it of res.results) {
      if (!log.sources.some((s) => s.url === it.url)) log.sources.push(it);
    }
    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify({ query, results: res.results }),
    });
  }
}

log.ms = Date.now() - log.ms;

console.log('\n──── 结论 ────');
console.log(`轮次上限 ${MAX_ROUNDS} 轮是否够收敛   ：${final ? '够，出答案了' : '不够，仍在要搜'}`);
console.log(`执行检索次数                     ：${log.searches}`);
console.log(`去重后来源数                     ：${log.sources.length}`);
console.log(`总耗时                           ：${(log.ms / 1000).toFixed(1)}s`);
if (final) {
  console.log(`最终答案 ${final.content.length} 字 / reasoning ${final.reasoning} 字`);
  console.log('---------------------------------------------');
  console.log(final.content.slice(0, 900));
  console.log('---------------------------------------------');
} else {
  console.log('⚠ 未收敛，MAX_ROUNDS 需要上调，或按需检索判断要更保守');
}
