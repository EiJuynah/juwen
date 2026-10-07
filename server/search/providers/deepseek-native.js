/**
 * DeepSeek 原生服务端搜索 provider（Anthropic 兼容 Messages API）。
 *
 * 为什么存在：项目此前的结论「DeepSeek 不支持服务端搜索」只对 **OpenAI 兼容**的
 * `/chat/completions` 成立（那里的内置工具会被静默忽略）。走 Anthropic 兼容端点
 * `POST {baseUrl}/messages`，挂原生服务端工具 `web_search_20250305`，用**同一把
 * DEEPSEEK_API_KEY** 鉴权即可拿到结构化的 `web_search_tool_result` 块——
 * 无需第三方搜索服务商。实测记录见 `wb/probe-deepseek-native-search.mjs` 与契约 §7。
 *
 * 与 DSH 内核同一策略：**没有 `web_search_tool_result` 块就当错误抛**，
 * 绝不降级去正文里扒 URL——那样会把模型自己写的链接当成检索来源，
 * 溯源链就彻底断了。
 *
 * 返回的条目形状与 bocha / mock 一致：`{ title, url, snippet, site, publishedAt }`，
 * 白名单过滤照旧由上层 `server/search/index.js` 负责（本层不预设权威源）。
 */
import { hostOf } from '../allowlist.js';

const DEFAULT_BASE = 'https://api.deepseek.com/anthropic/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_USES = 2;

/** 检索指令措辞。与 DSH 内核插件一致：让模型去执行一次搜索，而不是回答问题 */
export const searchInstruction = (query) => `Perform a web search for the query: ${query}`;

/**
 * 把 Messages API 的响应映射成内部结果条目。
 *
 * 映射规则（契约 §7）：
 *   · `web_search_tool_result.content[]` 里 `type==='web_search_result'` 的
 *     `{url,title,page_age}` → `{url,title,publishedAt}`；
 *   · snippet 来自 text 块 `citations[].cited_text`，按 url 关联，**首次命中优先**；
 *   · 按原始 url 去重；title 为空时回退 url；site 由 URL 主机名推导。
 *
 * @returns {Array|null} 结果数组；响应里**根本没有** `web_search_tool_result` 块时返回 null
 *   （由调用方抛错，见 search()）。
 */
export function extractNativeSources(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const resultBlocks = blocks.filter((b) => b?.type === 'web_search_tool_result');
  if (resultBlocks.length === 0) return null;

  // 服务端工具自身报错（如 max_uses_exceeded）也是失败，不能当成「没搜到」
  for (const b of resultBlocks) {
    if (b?.content && !Array.isArray(b.content) && b.content.type === 'web_search_tool_result_error') {
      throw new Error(
        `DeepSeek 原生检索返回错误：${b.content.error_code || 'unknown'}`,
      );
    }
  }

  // url → cited_text，首次命中优先
  const snippets = new Map();
  for (const b of blocks) {
    if (b?.type !== 'text') continue;
    for (const c of b.citations ?? []) {
      const url = String(c?.url || '').trim();
      const cited = String(c?.cited_text || '').trim();
      if (url && cited && !snippets.has(url)) snippets.set(url, cited);
    }
  }

  const byUrl = new Map();
  for (const rb of resultBlocks) {
    for (const item of rb?.content ?? []) {
      if (item?.type !== 'web_search_result') continue;
      const url = String(item.url || '').trim();
      if (!url || byUrl.has(url)) continue;
      const title = String(item.title || '').trim() || url;
      byUrl.set(url, {
        title,
        url,
        snippet: String(snippets.get(url) || '').slice(0, 500),
        site: hostOf(url),
        publishedAt: String(item.page_age || '').trim(),
      });
    }
  }
  return [...byUrl.values()];
}

/**
 * 创建 DeepSeek 原生检索 provider。
 *
 * @param {object} opts
 * @param {string} opts.apiKey        DEEPSEEK_API_KEY
 * @param {string} [opts.baseUrl]     默认 process.env.DEEPSEEK_SEARCH_BASE_URL 或官方 Anthropic 兼容端点
 * @param {string} [opts.model]       默认 process.env.DEEPSEEK_SEARCH_MODEL 或 deepseek-v4-flash
 * @param {number} [opts.maxTokens]   max_tokens，默认 1024
 * @param {number} [opts.maxUses]     服务端工具最大搜索次数，默认 2
 * @param {typeof fetch} [opts.fetchImpl] 测试注入口
 */
export function createDeepseekNativeProvider({
  apiKey,
  baseUrl = process.env.DEEPSEEK_SEARCH_BASE_URL || DEFAULT_BASE,
  model = process.env.DEEPSEEK_SEARCH_MODEL || DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
  maxUses = DEFAULT_MAX_USES,
  fetchImpl = fetch,
} = {}) {
  return {
    name: 'deepseek',
    configured: Boolean(apiKey),

    /**
     * @param {string} query
     * @param {{count?:number, signal?:AbortSignal}} opts
     * @returns {Promise<Array>} 归一化后的结果（尚未过白名单）
     */
    async search(query, { count = 20, signal } = {}) {
      if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY');

      const resp = await fetchImpl(`${baseUrl}/messages`, {
        method: 'POST',
        // 带鉴权的请求不跟随重定向，避免 key 被送到别的域名
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          authorization: `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'freadtool/0.1',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: [{ type: 'text', text: searchInstruction(query) }] }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
        }),
        signal,
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(
          `DeepSeek 原生检索返回 ${resp.status}${detail ? `：${detail.slice(0, 200)}` : ''}`,
        );
      }

      const payload = await resp.json().catch(() => null);
      const sources = extractNativeSources(payload);
      if (sources === null) {
        throw new Error('DeepSeek 原生检索响应缺少 web_search_tool_result 块');
      }

      const want = Math.max(1, Math.floor(Number(count) || 1));
      return sources.slice(0, want);
    },
  };
}
