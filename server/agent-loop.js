/**
 * 解释生成循环（agent loop）—— B 路线「桥接层自建检索」的执行体。
 *
 * 为什么需要这个循环：DeepSeek 的 API 不支持服务端内置搜索（官方兼容性表里
 * web_search 等内置工具会被**静默忽略**），但它支持标准的 function calling。
 * 于是由我们提供一个 web_search 函数，模型决定要不要调，我们执行检索后把
 * 结果回灌，再让它出最终答案。
 *
 * ── 循环里每一条规则，都是实测出来的，不是照文档猜的 ──
 *
 * 1. **必须逐个回灌 tool 消息。** 模型经常一轮并行发 2 个以上 tool_calls。
 *    只回灌第一个会直接 400：
 *      "An assistant message with 'tool_calls' must be followed by tool messages
 *       responding to each 'tool_call_id'."
 *    所以凡是 tool_calls 里的 id，一个都不能漏——包括被我们跳过的那些。
 *
 * 2. **arguments 是增量分片的。** 实测一次 query 被切成 17～23 个 delta 分片，
 *    必须按 index 累积拼接，不能只看第一片。
 *
 * 3. **必须有轮次上限，且最后一轮摘掉 tools。** 模型拿到不相关的检索结果会
 *    继续换词再搜；实测第 2 轮仍返回 finish_reason='tool_calls'。
 *    最后一轮不发 tools，是唯一可靠的「逼它作答」手段。
 *
 * 4. **过渡轮的首段正文要丢掉。** 有 tool_calls 的那轮常常先吐一句
 *    「我先查一下权威口径」（实测出现过），它不是答案。我们发一个 reset
 *    事件让前端清空正文缓冲，把这句降级成步骤说明。
 *
 * 5. **reasoning_content 与答案共用 max_tokens 配额。** 所以 max_tokens 由
 *    调用方按段落长度算好传进来（见 validate.js），这里不再自行调整。
 */

import { WEB_SEARCH_TOOL, queryFromToolCall } from './search/tool.js';

/** 默认轮次上限。实测 2 轮即可收敛（1 轮检索 + 1 轮作答），留 1 轮余量 */
export const DEFAULT_MAX_ROUNDS = 3;
/** 单轮最多真的执行几次检索，防止模型一口气发 10 个查询 */
export const DEFAULT_MAX_TOOL_CALLS = 3;

/**
 * 单轮流式请求：把 delta 解析成 {content, reasoning, toolCalls, finish}。
 *
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {string} o.apiKey
 * @param {object} o.body            请求体（不含 stream/tools，由本函数补齐）
 * @param {AbortSignal} o.signal
 * @param {(delta:string)=>void} [o.onReasoning]
 * @param {(delta:string)=>void} [o.onContent]
 * @param {typeof fetch} [o.fetchImpl]
 */
async function streamOnce({ baseUrl, apiKey, body, signal, onReasoning, onContent, fetchImpl = fetch }) {
  const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => '');
    return { error: { status: resp.status, detail: String(detail).slice(0, 300) } };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finish = null;
  /** index → { id, name, argChunks } */
  const toolCalls = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;

        const delta = choice.delta || {};
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onReasoning?.(delta.reasoning_content);
        }
        if (delta.content) {
          content += delta.content;
          onContent?.(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
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

  return { content, reasoning, finish, toolCalls };
}

/**
 * 跑完整轮解释。
 *
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {Array} o.messages            [system, user] 两条
 * @param {number} o.maxTokens
 * @param {number} [o.temperature]
 * @param {string} [o.effort]
 * @param {object|null} [o.searchService]  为 null 表示不挂检索工具
 * @param {(evt:object)=>void} o.onEvent   直接对接 SSE 写出
 * @param {AbortSignal} o.signal
 * @param {number} [o.maxRounds]
 * @param {number} [o.maxToolCalls]
 * @param {typeof fetch} [o.fetchImpl]
 *
 * @returns {Promise<{content:string, reasoning:string, reasoningChars:number,
 *                    steps:Array, sources:Array, rounds:number, searched:number}>}
 */
export async function runExplainLoop({
  baseUrl,
  apiKey,
  model,
  messages,
  maxTokens,
  temperature = 0.3,
  effort,
  searchService = null,
  onEvent = () => {},
  signal,
  maxRounds = DEFAULT_MAX_ROUNDS,
  maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
  fetchImpl = fetch,
}) {
  /** 步骤时间线：前端按 key 增量 upsert，这里也留一份完整记录 */
  const stepMap = new Map();
  const steps = () => [...stepMap.values()];
  const emitStep = (patch) => {
    const prev = stepMap.get(patch.key) || {};
    const next = { ...prev, ...patch };
    stepMap.set(patch.key, next);
    onEvent({ step: next });
  };

  /** 去重后的来源清单 */
  const sources = [];
  const addSources = (items) => {
    for (const it of items) {
      if (!sources.some((s) => s.url === it.url)) sources.push(it);
    }
  };

  let finalContent = '';
  let allReasoning = '';
  let rounds = 0;
  let searched = 0;
  const started = Date.now();

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    // 最后一轮摘掉 tools：模型对「不相关结果会继续换词再搜」没有自控力，
    // 唯一的可靠收敛手段就是这一轮不给它工具。
    const offerTools = Boolean(searchService) && round < maxRounds;

    const thinkKey = `think:${round}`;
    const answerKey = `answer:${round}`;
    const roundStart = Date.now();
    const thinkLabel = round === 1 ? '正在思考如何作答' : '正在梳理检索到的资料';
    emitStep({ key: thinkKey, kind: 'think', status: 'running', label: thinkLabel });

    let thinkDone = false;
    let answerStarted = false;
    let answerStart = 0;
    const closeThink = () => {
      if (thinkDone) return;
      thinkDone = true;
      emitStep({
        key: thinkKey,
        kind: 'think',
        status: 'done',
        label: thinkLabel,
        elapsedMs: Date.now() - roundStart,
      });
    };
    // 首次吐出可见正文时，「思考」结束、「作答」开始——
    // 拆成两步而不是互相覆盖，用户能看到过程有几个阶段。
    const markAnswering = () => {
      closeThink();
      if (answerStarted) return;
      answerStarted = true;
      answerStart = Date.now();
      emitStep({ key: answerKey, kind: 'answer', status: 'running', label: '正在组织答案' });
    };

    const body = {
      model,
      messages,
      stream: true,
      temperature,
      max_tokens: maxTokens,
      ...(effort ? { effort } : {}),
      ...(offerTools ? { tools: [WEB_SEARCH_TOOL] } : {}),
    };

    const r = await streamOnce({
      baseUrl,
      apiKey,
      body,
      signal,
      fetchImpl,
      onReasoning: (d) => onEvent({ r: d }),
      onContent: (d) => {
        markAnswering();
        onEvent({ t: d });
      },
    });

    if (r.error) {
      closeThink();
      emitStep({ key: thinkKey, kind: 'think', status: 'failed', label: '生成中断' });
      // 出错分支也要保持与正常分支相同的返回形状：
      // 调用方（server/index.js）先看 result.error 提前返回，但形状不一致
      // 会让「读 content 判断有没有答案」的代码踩到 undefined。
      return {
        error: r.error,
        content: '',
        reasoning: allReasoning,
        reasoningChars: allReasoning.length,
        steps: steps(),
        sources,
        rounds,
        searched,
        elapsedMs: Date.now() - started,
      };
    }

    allReasoning += r.reasoning;

    closeThink();

    const toolCalls = [...r.toolCalls.entries()];

    /**
     * 收尾「作答」步骤。
     *
     * 必须分两种口径：过渡轮（带 tool_calls）里模型先吐的那段正文会被 reset 丢掉，
     * 如果步骤仍写「已生成答案」，用户就会在时间线上看到「已生成答案」之后
     * 又冒出检索与新一轮作答——明明是丢弃的过渡语，却被说成答案。
     */
    const closeAnswer = (label, status) => {
      if (!answerStarted) return;
      emitStep({
        key: answerKey,
        kind: 'answer',
        status,
        label,
        elapsedMs: Date.now() - answerStart,
      });
    };

    // 没有工具调用 → 这一轮就是答案
    if (toolCalls.length === 0) {
      closeAnswer('已生成答案', 'done');
      finalContent = r.content;
      break;
    }

    // 有工具调用 → 本轮是「过渡轮」，正文里那句「我先查一下…」不该留在答案里
    closeAnswer('过渡说明（已丢弃，不计入答案）', 'skipped');
    if (r.content.trim()) {
      onEvent({ reset: true });
      // 把过渡语挂到「思考」步骤上，信息不丢，又不污染正文
      emitStep({ key: thinkKey, detail: r.content.trim().slice(0, 60) });
    }

    // 把 assistant 的 tool_calls 原样写回历史（arguments 必须拼接完整）
    messages.push({
      role: 'assistant',
      content: r.content || null,
      tool_calls: toolCalls.map(([i, tc]) => ({
        index: i,
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argChunks.join('') },
      })),
    });

    // 逐个执行并回灌——漏一个就是 400
    let seq = 0;
    for (const [, tc] of toolCalls) {
      seq++;
      const rawArgs = tc.argChunks.join('');
      const query = queryFromToolCall(rawArgs);
      const key = `search:${round}:${seq}`;

      // 超出本轮配额：仍要回灌一条 tool 消息，否则下一轮 400
      if (seq > maxToolCalls) {
        emitStep({
          key,
          kind: 'search',
          status: 'skipped',
          label: '已跳过（本轮检索次数已达上限）',
          detail: query,
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            error: `本轮检索次数已达上限（${maxToolCalls} 次），请基于已有资料作答。`,
          }),
        });
        continue;
      }

      emitStep({
        key,
        kind: 'search',
        status: 'running',
        label: '正在检索权威来源',
        detail: query,
      });

      const t0 = Date.now();
      const res = await searchService.searchWeb(query, { signal });
      searched++;

      if (!res.ok) {
        const why =
          res.reason === 'timeout'
            ? '检索超时'
            : res.reason === 'aborted'
              ? '已取消'
              : '检索服务异常';
        emitStep({
          key,
          kind: 'search',
          status: 'failed',
          label: `${why}，本轮跳过外部资料`,
          detail: query,
          elapsedMs: Date.now() - t0,
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            query,
            error: `${why}。请基于你自己的知识作答，并说明该部分未经核实。`,
          }),
        });
        continue;
      }

      if (res.results.length === 0) {
        emitStep({
          key,
          kind: 'search',
          status: 'done',
          label: '未检索到权威来源',
          detail: query,
          elapsedMs: Date.now() - t0,
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            query,
            results: [],
            note: '权威来源白名单内没有找到相关资料。请如实说明未检索到，不要编造来源。',
          }),
        });
        continue;
      }

      addSources(res.results);
      emitStep({
        key,
        kind: 'search',
        status: 'done',
        label: `检索到 ${res.results.length} 条权威来源`,
        detail: query,
        elapsedMs: Date.now() - t0,
        items: res.results.map((x) => ({ title: x.title, url: x.url, site: x.site })),
      });

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify({
          query,
          results: res.results.map((x) => ({
            title: x.title,
            url: x.url,
            snippet: x.snippet,
            site: x.site,
            publishedAt: x.publishedAt,
          })),
        }),
      });
    }
  }

  return {
    content: finalContent,
    reasoning: allReasoning,
    reasoningChars: allReasoning.length,
    steps: steps(),
    sources,
    rounds,
    searched,
    elapsedMs: Date.now() - started,
  };
}
