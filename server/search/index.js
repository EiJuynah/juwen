/**
 * 检索层统一入口。
 *
 * 这是整个联网能力唯一需要被桥接层认知的模块：上层的 agent 循环只调
 * `service.searchWeb(query)` 拿结果、调 `service.buildContext(results)` 拼进 prompt，
 * 不需要知道底下用的是博查还是别的、白名单怎么匹配、去重怎么做。
 *
 * 设计上刻意坚持四件事：
 *
 *   1. **只走权威源。** 供应商返回 20 条，过完白名单可能只剩 3 条。因此这里
 *      先按 overFetchFactor 多取，过滤后再截断。滤空的场景如实返回
 *      `filteredAll: true`，让上层告诉用户「未检索到权威来源」——绝不放行
 *      非权威结果来凑数。
 *
 *   2. **永不抛错。** 检索是「锦上添花」，不能因为搜索服务挂了就把整轮解释
 *      拖垮。所有异常都收敛成 `{ok:false, reason}`，上层照常出答案，只是没有
 *      外部资料。
 *
 *   3. **按需才搜。** 选中一句「本办法自发布之日起施行」也去搜一遍，既浪费钱
 *      又把不必要的字句送出去。canSearch() 是一道闸门，模型侧再用 function
 *      calling 决定这一轮到底要不要真的搜。
 *
 *   4. **可审计。** 白名单、条数、超时、缓存全是显式常量，测试里能逐条断言。
 *
 * 隐私提醒：query 会被发往第三方搜索服务。调用方必须保证只在用户显式开启、
 * 且非严格依据档（profile !== 'strict'）时才调用。
 */

import { DEFAULT_ALLOWED_DOMAINS, isAllowedUrl, hostOf, allowedDomainsFromEnv } from './allowlist.js';
import { createBochaProvider } from './providers/bocha.js';
import { createMockProvider } from './providers/mock.js';
import { createDeepseekNativeProvider } from './providers/deepseek-native.js';

/** 检索层的显式常量，测试与文档都以此为准 */
export const SEARCH_LIMITS = {
  /** 最终交给模型的条数上限 */
  maxResults: 5,
  /** 向供应商多取几倍，用来抵消白名单过滤造成的损失 */
  overFetchFactor: 4,
  /** query 长度。太短搜不准，太长搜索引擎会截断或跑偏 */
  minQueryChars: 2,
  maxQueryChars: 120,
  /** 单次检索超时。宁可没有资料，不可卡住整轮回答 */
  timeoutMs: 8000,
  /** 相同 query 的缓存时长：agent 循环里模型可能重复发起同一查询 */
  cacheTtlMs: 5 * 60 * 1000,
  maxCacheEntries: 80,
};

/** 需要剥掉的跟踪参数，它们会让同一篇文章产生多个 URL */
const TRACKING_PARAM = /^(utm_|spm|from$|source$|share_|ref$|_t$|sharemid$)/i;

/**
 * 归一化 URL，用于去重。
 * 同一篇文章常以 www / 非 www、带尾斜杠、带 utm 参数等多种形态出现。
 */
export function canonicalUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return s;
  }
}

/** 标题归一化，用于「同一内容不同 URL」的二次去重 */
function canonicalTitle(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[《》〈〉「」『』【】（）()\[\]〔〕、，,。.：:；;！!？?"'“”‘’—\-_/\\|]+/g, '');
}

/** 清洗用户/模型给出的 query */
export function normalizeQuery(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEARCH_LIMITS.maxQueryChars);
}

/**
 * 去重：先按 canonical URL，再按 canonical 标题。
 * 保留先出现的（供应商通常把更相关的排前面）。
 */
export function dedupe(items) {
  const seenUrl = new Set();
  const seenTitle = new Set();
  const out = [];
  for (const it of items) {
    const key = canonicalUrl(it.url);
    if (!key || seenUrl.has(key)) continue;
    const t = canonicalTitle(it.title);
    // 标题为空时不参与标题去重，避免所有无标题条目被误判为重复
    if (t && seenTitle.has(t)) continue;
    seenUrl.add(key);
    if (t) seenTitle.add(t);
    out.push(it);
  }
  return out;
}

/**
 * 把 provider 调用包一层，使其可被超时/取消打断。
 *
 * 为什么需要：`fetch` 自己会看 signal，但 provider 是我们可换的实现，
 * 万一某个实现忽略了 signal、请求一直挂着，光靠 AbortSignal.timeout()
 * 是打不断 `await` 的。这里显式 race 一次，保证「宁可不给资料，不可卡住整轮」。
 */
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? Object.assign(new Error('已取消'), { name: 'AbortError' }));
      return;
    }
    const onAbort = () => {
      const reason = signal.reason;
      reject(
        reason?.name
          ? reason
          : Object.assign(new Error('已取消'), { name: 'AbortError' }),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * 这一轮「能不能搜」的闸门。
 *
 * 注意它**不判断「该不该搜」**——那由模型通过 function calling 决定。
 * 这里只挡三类硬情况：功能没开、严格依据档（profile === 'strict'）、provider 没配好。
 *
 * @param {{enabled?:boolean, profile?:'explain'|'strict', providerConfigured?:boolean, query?:string}} ctx
 * @returns {{ok:true, query:string} | {ok:false, reason:string}}
 */
export function canSearch(ctx = {}) {
  if (!ctx.enabled) return { ok: false, reason: 'disabled' };
  if (ctx.profile === 'strict') return { ok: false, reason: 'strict-mode' };
  if (!ctx.providerConfigured) return { ok: false, reason: 'provider-unconfigured' };
  const query = normalizeQuery(ctx.query);
  if (query.length < SEARCH_LIMITS.minQueryChars) return { ok: false, reason: 'query-too-short' };
  return { ok: true, query };
}

/**
 * 把搜索结果拼成可以塞进 prompt 的文本块。
 *
 * 措辞要点：明确这些是**外部资料**、不是本文件原文，且不得声称是权威依据。
 * 否则模型容易把网页摘要说成「原文规定」，溯源链就断了。
 */
export function buildContext(results) {
  if (!Array.isArray(results) || results.length === 0) return '';
  const lines = results.map((r, i) => {
    const meta = [r.site, r.publishedAt ? String(r.publishedAt).slice(0, 10) : '']
      .filter(Boolean)
      .join(' · ');
    return [
      `${i + 1}. ${r.title}${meta ? `（${meta}）` : ''}`,
      `   ${r.url}`,
      r.snippet ? `   ${r.snippet}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return [
    '【外部检索资料】以下是联网检索到的公开资料，用于帮助你理解术语和背景。',
    '它们不是本文件的原文，不得说成是原文规定，也不得凭它们编造具体数字、期限或文号；',
    '引用时请标明序号，例如「据资料 2」。若与原文冲突，一律以原文为准。',
    '',
    ...lines,
  ].join('\n');
}

/**
 * 创建检索服务。
 *
 * @param {object} opts
 * @param {object} opts.provider            必须实现 search(query, {count, signal})
 * @param {string[]} [opts.allowedDomains]  为空且 open=false 时用默认权威源
 * @param {boolean} [opts.open]             true 表示关闭白名单过滤
 * @param {object} [opts.limits]            覆盖 SEARCH_LIMITS
 * @param {(msg:string)=>void} [opts.log]
 */
export function createSearchService({
  provider,
  allowedDomains = DEFAULT_ALLOWED_DOMAINS,
  open = false,
  limits = {},
  log = () => {},
} = {}) {
  const cfg = { ...SEARCH_LIMITS, ...limits };
  const allowed = Array.isArray(allowedDomains) ? allowedDomains : DEFAULT_ALLOWED_DOMAINS;
  const cache = new Map();

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > cfg.cacheTtlMs) {
      cache.delete(key);
      return null;
    }
    // LRU：命中后挪到队尾
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }

  function cacheSet(key, value) {
    cache.set(key, { at: Date.now(), value });
    while (cache.size > cfg.maxCacheEntries) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  /** 单次检索的统计，便于前端展示「已检索 N 条 / 采纳 M 条」 */
  const describe = () => ({
    provider: provider?.name || 'none',
    configured: Boolean(provider?.configured),
    open,
    allowedDomains: open ? [] : allowed,
    limits: cfg,
  });

  /**
   * 执行一次检索。
   *
   * @param {string} rawQuery
   * @param {{signal?:AbortSignal, count?:number, skipCache?:boolean}} [opts]
   * @returns {Promise<{ok:boolean, results:Array, reason?:string, detail?:string,
   *                    fetched:number, filtered:number, cached:boolean,
   *                    filteredAll:boolean}>}
   */
  async function searchWeb(rawQuery, { signal, count, skipCache = false } = {}) {
    const query = normalizeQuery(rawQuery);
    const empty = { ok: false, results: [], fetched: 0, filtered: 0, cached: false, filteredAll: false };

    if (query.length < cfg.minQueryChars) {
      return { ...empty, reason: 'query-too-short' };
    }
    if (!provider?.configured) {
      return { ...empty, reason: 'provider-unconfigured' };
    }

    const want = Math.max(1, Math.min(Number(count) || cfg.maxResults, cfg.maxResults));
    const cacheKey = `${provider.name}|${allowed.join(',')}|${open}|${want}|${query}`;

    if (!skipCache) {
      const cached = cacheGet(cacheKey);
      if (cached) return { ...cached, cached: true };
    }

    const overFetch = want * cfg.overFetchFactor;

    /*
     * 自己管超时，不用 AbortSignal.timeout()。
     *
     * 原因：AbortSignal.timeout() 内部的定时器是 unref 的，事件循环里没有别的
     * handle 时进程会直接退出，定时器根本没机会触发——测试里表现为
     * 「unsettled top-level await」。生产环境有 HTTP server 撑着看不出来，
     * 但这个隐性依赖不该留。这里用 ref 的定时器，并在 finally 里清掉，
     * 既不拖着进程也不漏触发。
     */
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(Object.assign(new Error(`检索超时（${cfg.timeoutMs}ms）`), { name: 'TimeoutError' }));
    }, cfg.timeoutMs);

    const forwardAbort = () => {
      ctrl.abort(signal.reason ?? Object.assign(new Error('已取消'), { name: 'AbortError' }));
    };
    if (signal) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }

    try {
      const raw = await abortable(
        provider.search(query, { count: overFetch, signal: ctrl.signal }),
        ctrl.signal,
      );
      const list = Array.isArray(raw) ? raw : [];

      // 白名单过滤。open=true 时只做形状校验（必须有 url）
      const kept = list.filter((it) => (open ? Boolean(hostOf(it.url)) : isAllowedUrl(it.url, allowed)));
      const unique = dedupe(kept);
      const results = unique.slice(0, want);

      const out = {
        ok: true,
        results,
        fetched: list.length,
        filtered: list.length - kept.length,
        cached: false,
        filteredAll: list.length > 0 && results.length === 0,
      };
      if (out.filteredAll) out.reason = 'no-authoritative-source';
      log(
        `[检索] "${query}" 取回 ${out.fetched} 条 → 白名单滤除 ${out.filtered} 条 → 采纳 ${results.length} 条`,
      );
      // 只缓存成功结果；失败不缓存，便于下次重试
      cacheSet(cacheKey, out);
      return out;
    } catch (err) {
      const isAbort = err?.name === 'AbortError' || err?.name === 'TimeoutError';
      const detail = String(err?.message || err).slice(0, 200);
      const reason = isAbort ? (timedOut ? 'timeout' : 'aborted') : 'provider-error';
      log(`[检索] "${query}" 失败：${isAbort ? reason : detail}`);
      return { ...empty, reason, detail };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  return { searchWeb, describe, canonicalUrl, normalizeQuery, buildContext, limits: cfg };
}

/**
 * 按环境变量组装服务，供 server/index.js 直接使用。
 *
 *   SEARCH_PROVIDER  bocha | deepseek | deepseek-native | native | mock | none（默认 none，即不开联网）
 *                    deepseek 三种写法等价：走 DeepSeek 原生服务端搜索
 *                    （Anthropic 兼容 Messages API，用现有 DEEPSEEK_API_KEY，见 providers/deepseek-native.js）
 *   SEARCH_ALLOWED_DOMAINS  留空=默认权威源；* = 关闭过滤；逗号分隔=自定义
 *   BOCHA_API_KEY / BOCHA_BASE_URL          仅在 SEARCH_PROVIDER=bocha 时需要
 *   DEEPSEEK_SEARCH_BASE_URL / DEEPSEEK_SEARCH_MODEL   可选，覆盖原生搜索的端点与模型
 *   DEEPSEEK_API_KEY                        原生搜索复用同一把 key；缺失时 provider.configured=false
 */
export function createSearchServiceFromEnv(env = process.env, log = () => {}) {
  const { domains, open } = allowedDomainsFromEnv(env.SEARCH_ALLOWED_DOMAINS);
  const kind = String(env.SEARCH_PROVIDER || 'none').trim().toLowerCase();

  let provider = null;
  if (kind === 'bocha') {
    provider = createBochaProvider({
      apiKey: env.BOCHA_API_KEY || '',
      baseUrl: env.BOCHA_BASE_URL || undefined,
    });
  } else if (kind === 'deepseek' || kind === 'deepseek-native' || kind === 'native') {
    provider = createDeepseekNativeProvider({
      apiKey: env.DEEPSEEK_API_KEY || '',
      baseUrl: env.DEEPSEEK_SEARCH_BASE_URL || undefined,
      model: env.DEEPSEEK_SEARCH_MODEL || undefined,
    });
  } else if (kind === 'mock') {
    provider = createMockProvider({ delayMs: Number(env.SEARCH_MOCK_DELAY_MS || 0) });
  }

  const service = createSearchService({ provider, allowedDomains: domains, open, log });
  // 只有真正配好的 provider 才算「具备联网能力」：
  // 建了 provider 对象但缺 key（configured=false）时，开关不应该点得动。
  service.enabled = Boolean(provider?.configured);
  return service;
}
