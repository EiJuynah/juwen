/**
 * 检索源白名单。
 *
 * 为什么放在我们自己的桥接层而不是交给搜索服务商：
 *   1. 换供应商时策略不变——不管是博查、智谱还是别的，过滤逻辑都在这；
 *   2. 服务商各自的「指定网站范围」参数语义不一致、还可能被静默忽略，
 *      靠它做合规约束不踏实；
 *   3. 过滤规则要能被审计、被测试，写在代码里最清楚。
 *
 * 代价是召回率：搜索返回 20 条，可能只剩 3 条。因此调用方要多取一些
 * （见 index.js 的 overFetch），并在过滤后仍为空时如实告知「未检索到权威来源」，
 * 绝不把非权威结果放行。
 */

/** 默认只放行政务官方与中央级官方媒体 */
export const DEFAULT_ALLOWED_DOMAINS = [
  // 各级政府门户：gov.cn 后缀已覆盖中央部委与地方各级政府
  'gov.cn',
  // 人大 / 政协
  'npc.gov.cn',
  'cppcc.gov.cn',
  // 中央级官方媒体
  'news.cn', // 新华社 / 新华网
  'xinhuanet.com',
  'people.com.cn', // 人民网
  'qstheory.cn', // 求是
  'gmw.cn', // 光明网
  'cctv.com', // 央视网
  'chinanews.com.cn', // 中国新闻网
  'china.com.cn', // 中国网
  'legaldaily.com.cn', // 法治日报
];

/**
 * 从 URL 取主机名（小写、去端口与 www 前缀）。
 * @returns {string} 取不到时返回空串
 */
export function hostOf(url) {
  try {
    const u = new URL(String(url));
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 主机名是否命中白名单。
 * 用「等于自身或点号结尾」匹配，避免把 notgov.cn 这类相似域名放进来。
 */
export function isAllowedHost(host, allowed = DEFAULT_ALLOWED_DOMAINS) {
  if (!host) return false;
  const h = String(host).toLowerCase().replace(/^www\./, '');
  return allowed.some((d) => {
    const s = String(d).toLowerCase().replace(/^www\./, '');
    return h === s || h.endsWith(`.${s}`);
  });
}

export function isAllowedUrl(url, allowed = DEFAULT_ALLOWED_DOMAINS) {
  return isAllowedHost(hostOf(url), allowed);
}

/**
 * 从环境变量读白名单。
 *   · 不设置      → 用默认权威源列表
 *   · 设为 *      → 关闭过滤（放行全网，慎用）
 *   · 逗号分隔    → 用给定列表
 */
export function allowedDomainsFromEnv(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return { domains: DEFAULT_ALLOWED_DOMAINS, open: false };
  if (v === '*') return { domains: [], open: true };
  const domains = v
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
  return { domains: domains.length ? domains : DEFAULT_ALLOWED_DOMAINS, open: false };
}
