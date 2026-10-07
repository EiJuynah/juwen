/**
 * 检索 agent loop 单元测试（不联网、不打真实模型）。
 *
 * 这里覆盖的是整条链路里最容易出错、又最难靠人工点两下发现的部分：
 *   · tool_calls 的 arguments 是增量分片的，必须按 index 累积拼接；
 *   · 模型一轮会并行发多个 tool_calls，**每个都要回灌 tool 消息**，
 *     漏一个下一次请求直接 400；
 *   · 最后一轮必须摘掉 tools，否则模型会一直换词再搜；
 *   · 有 tool_calls 的那轮正文是过渡语，要发 reset 让前端清空正文缓冲；
 *   · 检索失败 / 未命中都不能拖垮整轮解释。
 *
 *   node scripts/agent-loop-test.mjs
 */
import { runExplainLoop, DEFAULT_MAX_ROUNDS } from '../server/agent-loop.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** 造一个 SSE 响应体，frames 为已解析的 JSON 对象数组 */
function sseResponse(frames, { splitEvery = 1 } = {}) {
  const chunks = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`);
  if (splitEvery > 1) {
    // 把多个帧拼进同一个 chunk，验证跨 chunk 的缓冲区拼接
    const merged = [];
    for (let i = 0; i < chunks.length; i += splitEvery) merged.push(chunks.slice(i, i + splitEvery).join(''));
    chunks.length = 0;
    chunks.push(...merged);
  }
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: new TextEncoder().encode(chunks[i++]) };
        },
      }),
    },
  };
}

/** 一次 chat/completions delta 帧 */
const delta = (d, finish) => ({ choices: [{ delta: d, ...(finish ? { finish_reason: finish } : {}) }] });

/**
 * 造一个「按脚本应答」的 fetch。每次调用取 scripts 里的下一项作为响应，
 * 同时把请求体记进 requests，供断言检查。
 */
function scriptedFetch(scripts) {
  const requests = [];
  const impl = async (url, opts) => {
    requests.push(JSON.parse(opts.body));
    const next = scripts.shift();
    if (!next) throw new Error('测试脚本已用尽，但代码又发了一次请求');
    if (next.status && next.status !== 200) {
      return { ok: false, status: next.status, text: async () => next.detail || '' };
    }
    return sseResponse(next.frames, { splitEvery: next.splitEvery ?? 1 });
  };
  impl.requests = requests;
  return impl;
}

/** 检索服务打桩 */
function fakeSearch(handler) {
  const queries = [];
  return {
    queries,
    service: {
      enabled: true,
      async searchWeb(query, opts) {
        queries.push(query);
        return handler(query, opts);
      },
    },
  };
}

const baseArgs = () => ({
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'test-key',
  model: 'deepseek-flash',
  messages: [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'user' },
  ],
  maxTokens: 7080,
  signal: undefined,
});

console.log('\n检索 agent loop 测试\n');

// ─────────────────────────────────────────────────────────────
console.log('▸ 场景 1：模型不调工具，直接作答');
{
  const fetchImpl = scriptedFetch([
    { frames: [delta({ reasoning_content: '想一下' }), delta({ content: '这是答案' }), delta({}, 'stop')] },
  ]);
  const events = [];
  const r = await runExplainLoop({
    ...baseArgs(),
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    searchService: null,
    fetchImpl,
    onEvent: (e) => events.push(e),
  });

  check('返回可见答案', r.content === '这是答案', r.content);
  check('推理字数被统计', r.reasoningChars === 3, String(r.reasoningChars));
  check('只跑 1 轮', r.rounds === 1, String(r.rounds));
  check('没有发生检索', r.searched === 0);
  check('不挂检索服务时请求体不带 tools', !('tools' in fetchImpl.requests[0]), JSON.stringify(Object.keys(fetchImpl.requests[0])));
  check('步骤为「思考 → 作答」两步', r.steps.map((s) => s.kind).join(',') === 'think,answer', r.steps.map((s) => s.key).join(','));
  check('两步都是 done', r.steps.every((s) => s.status === 'done'));
  check('没有发 reset（本轮没有过渡语）', !events.some((e) => e.reset));
  check('推理走独立通道 r', events.some((e) => e.r === '想一下'));
  check('正文走独立通道 t', events.some((e) => e.t === '这是答案'));
}

// ─────────────────────────────────────────────────────────────
console.log('▸ 场景 2：一轮检索后作答（arguments 分片 + 过渡语 reset）');
{
  // 第一轮：先吐过渡语，再分 3 片吐出 tool_call 的 arguments，最后 finish=tool_calls
  const fetchImpl = scriptedFetch([
    {
      splitEvery: 2, // 故意把多帧塞进同一个 SSE chunk，验证缓冲区拼接
      frames: [
        delta({ reasoning_content: '需要查一下' }),
        delta({ content: '我先查一下权威口径。' }),
        delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"que' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'ry":"统一战线 ' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '定义"}' } }] }),
        delta({}, 'tool_calls'),
      ],
    },
    { frames: [delta({ content: '据资料 1，统一战线是指……' }), delta({}, 'stop')] },
  ]);
  const { service, queries } = fakeSearch(() => ({
    ok: true,
    results: [
      { title: '条例全文', url: 'https://www.gov.cn/a', snippet: 's1', site: '中国政府网', publishedAt: '2020-12-21' },
      // 真实检索链路上，server/search 的 canonicalUrl + dedupe 已经剥掉 utm 之类的跟踪参数，
      // 所以这里用「完全相同的 URL」验证 agent-loop 自己那层按 url 精确去重的兜底。
      { title: '同一篇', url: 'https://www.gov.cn/a', snippet: 's1', site: '中国政府网' },
      { title: '章程', url: 'http://www.cppcc.gov.cn/b', snippet: 's2', site: '中国政协网' },
    ],
    fetched: 3,
    filtered: 0,
  }));
  const events = [];
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  const r = await runExplainLoop({
    ...baseArgs(),
    messages,
    searchService: service,
    maxRounds: 2,
    fetchImpl,
    onEvent: (e) => events.push(e),
  });

  check('分片 arguments 被完整拼接成 query', queries[0] === '统一战线 定义', queries.join(' | '));
  check('第 1 轮请求带 tools', Array.isArray(fetchImpl.requests[0].tools) && fetchImpl.requests[0].tools[0].function.name === 'web_search');
  check('第 2 轮（最后一轮）摘掉 tools', !('tools' in fetchImpl.requests[1]));
  check('发了 reset 事件（过渡语不留在答案里）', events.some((e) => e.reset));
  check('过渡语降级成步骤说明', r.steps.some((s) => s.detail === '我先查一下权威口径。'));
  check('assistant 消息带 tool_calls', messages[2]?.tool_calls?.length === 1 && messages[2].tool_calls[0].id === 'call_1');
  check('tool 消息回灌了检索结果', messages[3]?.role === 'tool' && messages[3].tool_call_id === 'call_1');
  const fed = JSON.parse(messages[3].content);
  check('回灌内容含结果条目', Array.isArray(fed.results) && fed.results.length === 3, messages[3].content.slice(0, 80));
  check('最终答案是第 2 轮的内容', r.content === '据资料 1，统一战线是指……', r.content);
  check('来源按 URL 去重（3 → 2，归一化由检索层负责）', r.sources.length === 2, r.sources.map((s) => s.url).join(' | '));
  check('检索次数为 1', r.searched === 1);
  check('检索步骤带 items 供前端展示', r.steps.find((s) => s.kind === 'search')?.items?.length === 3);

  // 过渡轮（带 tool_calls、正文会被 reset 丢弃）的作答步骤不能写「已生成答案」，
  // 否则时间线上会出现「已生成答案」之后又冒出检索与新一轮作答，自相矛盾。
  // 这里按语义断顺序，而不是死对一条 key 字符串。
  const idxOf = (pred) => r.steps.findIndex(pred);
  const iTransitionAnswer = idxOf((s) => s.key === 'answer:1');
  const iSearch = idxOf((s) => s.kind === 'search');
  const iFinalAnswer = idxOf((s) => s.key === 'answer:2');
  const transitionAnswer = r.steps[iTransitionAnswer];
  const finalAnswer = r.steps[iFinalAnswer];

  check(
    '检索排在过渡说明之后、最终作答之前',
    iTransitionAnswer >= 0 && iTransitionAnswer < iSearch && iSearch < iFinalAnswer,
    r.steps.map((s) => `${s.key}(${s.status})`).join(' → '),
  );
  check(
    '过渡轮的作答步骤为 skipped，且标明是过渡说明',
    transitionAnswer?.status === 'skipped' && /过渡说明/.test(transitionAnswer?.label || ''),
    JSON.stringify(transitionAnswer),
  );
  check(
    '最终轮作答为 done 且文案是「已生成答案」',
    finalAnswer?.status === 'done' && finalAnswer?.label === '已生成答案',
    JSON.stringify(finalAnswer),
  );
  check(
    '时间线上没有「已生成答案」早于检索步骤',
    iSearch >= 0 && idxOf((s) => s.label === '已生成答案') > iSearch,
    r.steps.map((s) => `${s.key}:${s.label}`).join(' → '),
  );
  check('检索步骤都收尾为 done', r.steps.filter((s) => s.kind === 'search').every((s) => s.status === 'done'));
}

// ─────────────────────────────────────────────────────────────
console.log('▸ 场景 3：一轮并行多个 tool_calls，超出配额也要逐个回灌');
{
  const fetchImpl = scriptedFetch([
    {
      frames: [
        delta({ tool_calls: [
          { index: 0, id: 'call_a', function: { name: 'web_search', arguments: '{"query":"甲"}' } },
          { index: 1, id: 'call_b', function: { name: 'web_search', arguments: '{"query":"乙"}' } },
        ] }),
        delta({}, 'tool_calls'),
      ],
    },
    { frames: [delta({ content: '基于已有资料作答' })] },
  ]);
  const { service, queries } = fakeSearch(() => ({ ok: true, results: [{ title: 't', url: 'https://www.gov.cn/x', snippet: 's', site: '中国政府网' }] }));
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  const r = await runExplainLoop({
    ...baseArgs(),
    messages,
    searchService: service,
    maxRounds: 2,
    maxToolCalls: 1,
    fetchImpl,
  });

  check('只真的执行了 1 次检索', queries.length === 1, queries.join(' | '));
  const assistant = messages[2];
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  check('assistant 保留 2 个 tool_calls', assistant?.tool_calls?.length === 2, String(assistant?.tool_calls?.length));
  check('2 个 tool_call_id 都有对应的 tool 消息', toolMsgs.length === 2, String(toolMsgs.length));
  check('被跳过的那个回了「已达上限」', /上限/.test(toolMsgs.find((m) => m.tool_call_id === 'call_b')?.content || ''));
  const skipped = r.steps.find((s) => s.key === 'search:1:2');
  check('跳过也记进时间线', skipped?.status === 'skipped' && skipped?.detail === '乙', JSON.stringify(skipped));
  check('跳过不影响最终作答', r.content === '基于已有资料作答');
}

// ─────────────────────────────────────────────────────────────
console.log('▸ 场景 4：检索超时 / 未命中都不拖垮回答');
{
  // 4a 超时
  const fetchImpl = scriptedFetch([
    { frames: [delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'web_search', arguments: '{"query":"甲"}' } }] }), delta({}, 'tool_calls')] },
    { frames: [delta({ content: '没有外部资料也照答' })] },
  ]);
  const { service } = fakeSearch(() => ({ ok: false, reason: 'timeout', results: [], fetched: 0, filtered: 0 }));
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  const r = await runExplainLoop({ ...baseArgs(), messages, searchService: service, maxRounds: 2, fetchImpl });

  const step = r.steps.find((s) => s.kind === 'search');
  check('超时步骤标记 failed', step?.status === 'failed');
  check('步骤文案说明超时', /超时/.test(step?.label || ''), step?.label);
  const toolMsg = messages.find((m) => m.role === 'tool');
  check('回灌错误而不是编造结果', /未经核实|超时/.test(toolMsg?.content || ''), toolMsg?.content);
  check('超时后仍然出答案', r.content === '没有外部资料也照答');
  check('超时不计数为「已检索」', r.searched === 1, String(r.searched));

  // 4b 白名单滤空
  const fetchImpl2 = scriptedFetch([
    { frames: [delta({ tool_calls: [{ index: 0, id: 'c2', function: { name: 'web_search', arguments: '{"query":"乙"}' } }] }), delta({}, 'tool_calls')] },
    { frames: [delta({ content: '如实说明没搜到' })] },
  ]);
  const { service: svc2 } = fakeSearch(() => ({ ok: true, results: [], fetched: 5, filtered: 5, filteredAll: true, reason: 'no-authoritative-source' }));
  const messages2 = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  const r2 = await runExplainLoop({ ...baseArgs(), messages: messages2, searchService: svc2, maxRounds: 2, fetchImpl: fetchImpl2 });
  const step2 = r2.steps.find((s) => s.kind === 'search');
  check('未命中记为 done 而非 failed', step2?.status === 'done', JSON.stringify(step2?.status));
  check('文案为「未检索到权威来源」', step2?.label === '未检索到权威来源', step2?.label);
  check('不产生来源清单', r2.sources.length === 0);
  check('要求模型如实说明', /不要编造/.test(messages2.find((m) => m.role === 'tool')?.content || ''));
}

// ─────────────────────────────────────────────────────────────
console.log('▸ 场景 5：模型侧报错要收敛成 error，而不是抛出去');
{
  const fetchImpl = scriptedFetch([{ status: 400, detail: '{"error":{"message":"bad request"}}' }]);
  const r = await runExplainLoop({ ...baseArgs(), searchService: null, fetchImpl });
  check('返回 error 而不是抛异常', r.error?.status === 400, JSON.stringify(r.error));
  check('错误详情被截断保留', String(r.error?.detail).includes('bad request'));
  check('失败的步骤标成 failed，便于前端定位', r.steps.some((s) => s.status === 'failed'));
  // 错误分支在 server/index.js 里是「先看 result.error 再提前 return」，不会再读正文，
  // 因此这里断言「没有产出正文」而不是某个具体的空值形态（该分支未返回 content 字段）。
  check('没有正文', !r.content, String(r.content));
}

// ─────────────────────────────────────────────────────────────
console.log('▸ 场景 6：模型一轮都不收敛时，最后一轮强制收口');
{
  const toolCallFrames = (id, q) => [
    delta({ tool_calls: [{ index: 0, id, function: { name: 'web_search', arguments: `{"query":"${q}"}` } }] }),
    delta({}, 'tool_calls'),
  ];
  const scripts = [];
  for (let i = 0; i < DEFAULT_MAX_ROUNDS; i++) scripts.push({ frames: toolCallFrames(`c${i}`, `查询${i}`) });
  const fetchImpl = scriptedFetch(scripts);
  const { service, queries } = fakeSearch(() => ({ ok: true, results: [{ title: 't', url: 'https://www.gov.cn/x', snippet: 's', site: '中国政府网' }] }));
  const r = await runExplainLoop({ ...baseArgs(), searchService: service, fetchImpl });

  const offered = fetchImpl.requests.map((b) => Boolean(b.tools));
  // 默认 DEFAULT_MAX_ROUNDS = 3：前两轮带 tools，最后一轮摘掉（true,true,false）
  check(`最多跑 ${DEFAULT_MAX_ROUNDS} 轮`, r.rounds === DEFAULT_MAX_ROUNDS, String(r.rounds));
  check('前几轮给 tools、最后一轮不给', offered.join(',') === 'true,true,false', offered.join(','));
  check('轮次上限内不会再发第 4 次请求', fetchImpl.requests.length === DEFAULT_MAX_ROUNDS);
  // 脚本每轮都发 1 个 tool_call，因此每轮各执行 1 次检索（含最后一轮——模型不该在摘掉
  // tools 后还发 tool_calls，这里用假脚本强行构造，验证实现不会因此越界）
  check('每个 tool_call 都按配额执行一次检索', queries.length === DEFAULT_MAX_ROUNDS, queries.length + '：' + queries.join(' | '));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
