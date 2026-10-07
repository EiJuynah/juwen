/**
 * 博查（Bocha）Web Search provider。
 *
 * 选它的理由：数据不出境、国内节点、按次计费便宜（约 ¥0.036/次，
 * 新账号有免费额度），且它本来就是给 RAG/智能体用的检索底座。
 *
 * 关于「指定网站范围」：官方文档只写了「支持指定搜索的网站范围」，
 * 确切字段名在飞书登录墙后面拿不到，因此这里**不依赖**该参数——
 * 一律多取一些条数，再交给 allowlist.js 在我们自己的桥接层过滤。
 * 这样即使博查改了参数语义，合规约束也不会失效。
 *
 * 官方文档 https://open.bocha.cn
 */

const DEFAULT_BASE = 'https://api.bocha.cn';

/** 把博查返回的一条结果归一化成内部结构，字段名做好兼容 */
function normalizeItem(it) {
  if (!it || typeof it !== 'object') return null;
  const url = String(it.url || it.link || '').trim();
  if (!url) return null;
  // snippet 可能是纯文本，summary 是模型生成的摘要，优先用后者但更短
  const snippet = String(it.snippet || it.summary || it.description || '').trim();
  return {
    title: String(it.name || it.title || url).trim(),
    url,
    snippet: snippet.slice(0, 500),
    site: String(it.siteName || it.site || '').trim(),
    publishedAt: String(it.datePublished || it.dateLastCrawled || '').trim(),
  };
}

/** 从各种可能的响应形状里把结果数组抠出来 */
export function extractItems(payload) {
  const d = payload?.data ?? payload;
  const list =
    d?.webPages?.value ??
    d?.webPages?.values ??
    d?.value ??
    d?.results ??
    (Array.isArray(d) ? d : []);
  return Array.isArray(list) ? list : [];
}

export function createBochaProvider({ apiKey, baseUrl = DEFAULT_BASE } = {}) {
  return {
    name: 'bocha',
    configured: Boolean(apiKey),

    /**
     * @param {string} query
     * @param {{count?:number, signal?:AbortSignal}} opts
     * @returns {Promise<Array>} 归一化后的原始结果（尚未过白名单）
     */
    async search(query, { count = 20, signal } = {}) {
      if (!apiKey) throw new Error('未配置 BOCHA_API_KEY');

      const resp = await fetch(`${baseUrl}/v1/web-search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          count: Math.min(Math.max(count, 1), 50),
          summary: true,
          freshness: 'noLimit',
        }),
        signal,
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`博查返回 ${resp.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
      }

      const payload = await resp.json().catch(() => null);
      // 博查用 code 表达业务错误，HTTP 200 也可能是业务失败
      if (payload && payload.code != null && Number(payload.code) !== 200) {
        throw new Error(`博查业务错误 ${payload.code}：${payload.msg || ''}`.trim());
      }

      return extractItems(payload).map(normalizeItem).filter(Boolean);
    },
  };
}
