/**
 * 给模型暴露的检索工具定义 + 使用引导。
 *
 * 为什么单独放一个文件：工具 schema 是「模型侧契约」，改一个字都可能让模型
 * 不再触发检索；而 agent-loop.js 是「执行侧」。两者分开，测试与 review 都更清楚。
 */

export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '在权威政务网站（各级政府门户、人大、政协、中央级官方媒体）检索公开资料。' +
      '当你需要确认本文件之外的信息时使用，例如：某部法规的通过与施行日期、某机构的准确全称、' +
      '某个术语的官方定义、某项法规的最新进展。一次可以发起多个不同角度的查询。' +
      '注意：检索范围仅限权威来源，检索不到时应如实说明，不要编造。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词。简洁明确，建议 8～30 字，用空格分隔核心词。不要写整句话。',
        },
      },
      required: ['query'],
    },
  },
};

/**
 * 追加到 System Prompt 的检索使用规范。
 *
 * 只在真的挂了 tools 时才加——没挂工具却要求「先检索再回答」，
 * 会让模型在正文里编造检索动作（例如写「经查询…」），这是最坏的情况。
 */
export const TOOL_USAGE_PROMPT = `
【检索工具使用规范】
0. 本轮你已经挂载 web_search 检索工具：System Prompt 里「你没有联网检索能力」一句
   指的是**没有这个工具时**的情形，本轮不再适用。需要本文件之外的信息时就去检索，
   不要把「无法查证」当答案，也不要凭记忆编造。
1. 只在确实需要**本文件之外**的信息时调用；
   如果问题完全可以依据用户给出的原文回答，直接回答，不要为了显得严谨而检索。
2. 同一轮可以并行发起多个不同角度的查询；不要用同一个意思换个说法反复查。
3. 拿到检索结果后：
   - 把「原文/资料所说」与「你自己的补充说明」分成两个部分写清楚；
   - 引用资料时标明序号，格式为「据资料 1」；
   - 资料与问题无关时不要硬套，如实说「检索到的资料与当前问题关联不大」；
   - 资料与原文冲突时，一律以用户提供的原文为准。
4. 检索不到结果时，直接说明「未检索到权威来源」，然后依据你自己的知识作答，
   并提醒该部分未经核实。不得编造来源、网址或文号。
`.trim();

/** 从一批 tool_calls 里安全地取出 query（模型可能给坏 JSON） */
export function queryFromToolCall(rawArgs) {
  const s = String(rawArgs || '').trim();
  if (!s) return '';
  try {
    const obj = JSON.parse(s);
    return String(obj?.query || '').trim();
  } catch {
    // 模型偶尔会漏掉 JSON 语法，退化成「把整段当 query」
    return s.replace(/^[\s{"']*query["']?\s*[:：]\s*/i, '').replace(/["'}]*\s*$/, '').trim();
  }
}
