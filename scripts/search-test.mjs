/**
 * 检索层离线测试。
 *
 * 全程不打真实网络：博查 provider 用桩 fetch 验证请求形状与响应兼容，
 * 其余逻辑用 mock provider 跑。
 *
 *   node scripts/search-test.mjs
 */
import {
  SEARCH_LIMITS,
  canonicalUrl,
  dedupe,
  normalizeQuery,
  canSearch,
  buildContext,
  createSearchService,
  createSearchServiceFromEnv,
} from '../server/search/index.js';
import {
  DEFAULT_ALLOWED_DOMAINS,
  hostOf,
  isAllowedHost,
  isAllowedUrl,
  allowedDomainsFromEnv,
} from '../server/search/allowlist.js';
import { createMockProvider, MOCK_RESULTS } from '../server/search/providers/mock.js';
import { createBochaProvider, extractItems } from '../server/search/providers/bocha.js';
import { createDeepseekNativeProvider } from '../server/search/providers/deepseek-native.js';
import { htmlToText, decodeHtmlBuffer, createPageFetcher, isPrivateHost } from '../server/search/page-text.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\n检索层测试\n');

// ─────────────────────────────────────────────── 白名单
console.log('▸ 白名单');
{
  check('hostOf 去 www 并小写', hostOf('https://WWW.Gov.CN/a/b') === 'gov.cn');
  check('hostOf 无法解析时返回空串', hostOf('not a url') === '');
  check('hostOf 空值返回空串', hostOf('') === '');

  check('gov.cn 自身命中', isAllowedHost('gov.cn'));
  check('www.gov.cn 命中（去 www）', isAllowedHost('www.gov.cn'));
  check('xx.gov.cn 子域命中', isAllowedHost('www.beijing.gov.cn'));
  check('news.cn 命中', isAllowedHost('news.cn'));
  check('people.com.cn 命中', isAllowedHost('www.people.com.cn'));

  // 这几条是「白名单没写成后缀包含」的关键回归点
  check('notgov.cn 不命中', !isAllowedHost('notgov.cn'));
  check('evilgov.cn 不命中', !isAllowedHost('evilgov.cn'));
  check('gov.cn.evil.com 不命中', !isAllowedHost('gov.cn.evil.com'));
  check('zhihu.com 不命中', !isAllowedHost('www.zhihu.com'));
  check('baike.baidu.com 不命中', !isAllowedHost('baike.baidu.com'));
  check('空主机名不命中', !isAllowedHost(''));

  check('isAllowedUrl 走完整 URL', isAllowedUrl('https://www.gov.cn/zhengce/x.htm'));
  check('isAllowedUrl 拒绝非权威', !isAllowedUrl('https://zhuanlan.zhihu.com/p/1'));
  check('isAllowedUrl 拒绝畸形 URL', !isAllowedUrl('javascript:void(0)'));

  check('自定义列表生效', isAllowedHost('a.com', ['a.com']) && !isAllowedHost('b.com', ['a.com']));
  check('自定义列表同样防后缀混淆', !isAllowedHost('xa.com', ['a.com']));

  const dflt = allowedDomainsFromEnv('');
  check('env 留空 → 默认列表', !dflt.open && dflt.domains === DEFAULT_ALLOWED_DOMAINS);
  const star = allowedDomainsFromEnv('*');
  check('env 设为 * → 关闭过滤', star.open === true);
  const custom = allowedDomainsFromEnv(' Gov.CN , www.moe.gov.cn ');
  check(
    'env 逗号列表 → 去空白、去 www',
    !custom.open && custom.domains.join(',') === 'gov.cn,moe.gov.cn',
    custom.domains.join(','),
  );
}

// ─────────────────────────────────────────────── 归一化与去重
console.log('\n▸ URL / 标题归一化与去重');
{
  check(
    'canonicalUrl 去尾斜杠与 www',
    canonicalUrl('https://www.gov.cn/a/') === canonicalUrl('https://gov.cn/a'),
    canonicalUrl('https://www.gov.cn/a/'),
  );
  check(
    'canonicalUrl 剔除 utm 与 hash',
    canonicalUrl('https://gov.cn/a?utm_source=x&id=1#sec') === canonicalUrl('https://gov.cn/a?id=1'),
  );
  check(
    'canonicalUrl 保留有效查询参数',
    canonicalUrl('https://gov.cn/a?id=1') !== canonicalUrl('https://gov.cn/a?id=2'),
  );

  check('normalizeQuery 折叠空白', normalizeQuery('  非公有制\n经济  人士 ') === '非公有制 经济 人士');
  check(
    'normalizeQuery 截断超长',
    normalizeQuery('字'.repeat(500)).length === SEARCH_LIMITS.maxQueryChars,
  );

  const items = [
    { title: '统一战线工作条例', url: 'https://www.gov.cn/a/' },
    { title: '统一战线工作条例', url: 'https://gov.cn/a?utm_source=x' }, // 同文不同 URL
    { title: '另一篇', url: 'https://news.cn/b' },
    { title: '《另一篇》', url: 'https://news.cn/c' }, // 标题归一化后同名
    { title: '', url: 'https://news.cn/d' }, // 无标题，不参与标题去重
    { title: '   ', url: 'https://news.cn/e' }, // 仅空白，同上
  ];
  const dd = dedupe(items);
  check('去重后剩 4 条', dd.length === 4, `实际 ${dd.length}`);
  check('保留先出现的那条（gov.cn/a）', dd[0].url.startsWith('https://www.gov.cn/a'));
  check(
    '无标题条目各自保留（不被误判重复）',
    dd.filter((x) => x.url.endsWith('/d') || x.url.endsWith('/e')).length === 2,
    `实际 ${dd.filter((x) => x.url.endsWith('/d') || x.url.endsWith('/e')).length}`,
  );
  check('URL 缺失的条目不进结果', dedupe([{ title: 'x', url: '' }]).length === 0);
}

// ─────────────────────────────────────────────── 闸门
console.log('\n▸ canSearch 闸门');
{
  check('功能关闭 → disabled', canSearch({ enabled: false, providerConfigured: true, query: '政协章程' }).reason === 'disabled');
  check(
    '严格依据档 → strict-mode',
    canSearch({ enabled: true, profile: 'strict', providerConfigured: true, query: '政协章程' }).reason === 'strict-mode',
  );
  check(
    'provider 未配置 → provider-unconfigured',
    canSearch({ enabled: true, providerConfigured: false, query: '政协章程' }).reason === 'provider-unconfigured',
  );
  check(
    'query 过短 → query-too-short',
    canSearch({ enabled: true, providerConfigured: true, query: '政' }).reason === 'query-too-short',
  );
  const ok = canSearch({ enabled: true, providerConfigured: true, query: '  政协委员  产生方式  ' });
  check('正常放行并归一化 query', ok.ok && ok.query === '政协委员 产生方式', ok.query);

  // 讲透档（explain）不设额外限制，闸门应放行
  const explain = canSearch({ enabled: true, profile: 'explain', providerConfigured: true, query: '政协章程' });
  check('讲透档可检索', explain.ok === true, explain.reason);

  // 顺序很重要：严格依据档必须优先于「query 太短」，
  // 否则前端会拿到一个误导性的原因
  check(
    '严格依据档优先于 query 校验',
    canSearch({ enabled: true, profile: 'strict', providerConfigured: true, query: '' }).reason === 'strict-mode',
  );
}

// ─────────────────────────────────────────────── 检索主流程
console.log('\n▸ searchWeb（mock provider）');
{
  // 本文件所有既有用例都必须完全离线：searchWeb 默认会给空摘要的结果抓来源页正文，
  // 这里显式关掉（新增的补正文用例另行注入桩抓取器）。断言本身一条未动。
  const svc = createSearchService({ provider: createMockProvider(), fetchPageText: false });
  const r = await svc.searchWeb('非公有制经济人士 界定');

  check('检索成功', r.ok === true);
  check(
    '白名单滤除 2 条非权威源',
    r.fetched === 5 && r.filtered === 2,
    `fetched=${r.fetched} filtered=${r.filtered}`,
  );
  check('采纳 3 条权威源', r.results.length === 3, `实际 ${r.results.length}`);
  check('结果里没有知乎', !r.results.some((x) => x.url.includes('zhihu')));
  check('结果里没有百度百科', !r.results.some((x) => x.url.includes('baidu')));
  check('结果形状统一', r.results.every((x) => x.title && x.url && typeof x.snippet === 'string'));
  check('首次不是缓存命中', r.cached === false);
  check('未出现 filteredAll', r.filteredAll === false);
}
{
  // 缓存：第二次同 query 不应再打 provider
  let calls = 0;
  const counting = {
    name: 'counting',
    configured: true,
    async search(q, o) {
      calls++;
      return createMockProvider().search(q, o);
    },
  };
  const svc = createSearchService({ provider: counting, fetchPageText: false });
  const a = await svc.searchWeb('政协章程 内容');
  const b = await svc.searchWeb('政协章程 内容');
  check('provider 只被调用 1 次', calls === 1, `实际 ${calls}`);
  check('第二次命中缓存', b.cached === true && a.cached === false);
  check('缓存结果内容一致', JSON.stringify(a.results) === JSON.stringify(b.results));

  await svc.searchWeb('政协章程 内容', { skipCache: true });
  check('skipCache 绕过缓存', calls === 2, `实际 ${calls}`);

  // 空白差异应命中同一缓存（query 先归一化）
  await svc.searchWeb('  政协章程   内容  ');
  check('query 归一化后共享缓存', calls === 2, `实际 ${calls}`);
}
{
  // 条数上限：count 再大也不能超过 maxResults
  const svc = createSearchService({
    provider: createMockProvider({
      results: Array.from({ length: 30 }, (_, i) => ({
        title: `第 ${i} 篇`,
        url: `https://www.gov.cn/doc/${i}`,
        snippet: 'x',
        site: '中国政府网',
      })),
    }),
    fetchPageText: false,
  });
  const r = await svc.searchWeb('测试条数上限', { count: 999 });
  check('条数被卡在 maxResults', r.results.length === SEARCH_LIMITS.maxResults, `实际 ${r.results.length}`);

  const r2 = await svc.searchWeb('测试条数上限 2', { count: 2 });
  check('count 可下调', r2.results.length === 2, `实际 ${r2.results.length}`);
}
{
  // 全部被滤掉：应如实报告，而不是报错或放行
  const svc = createSearchService({
    provider: createMockProvider({
      results: [
        { title: '知乎答案', url: 'https://www.zhihu.com/question/1', snippet: 'x' },
        { title: '百度百科', url: 'https://baike.baidu.com/item/x', snippet: 'x' },
      ],
    }),
  });
  const r = await svc.searchWeb('全被滤掉的情况');
  check('全滤掉仍视为成功', r.ok === true);
  check('结果为空数组', r.results.length === 0);
  check('标记 filteredAll', r.filteredAll === true);
  check('给出 no-authoritative-source', r.reason === 'no-authoritative-source');
}
{
  // 关闭白名单过滤：非权威源应被放行
  const svc = createSearchService({ provider: createMockProvider(), open: true, fetchPageText: false });
  const r = await svc.searchWeb('关闭过滤时');
  check('open=true 时 5 条全留', r.results.length === 5, `实际 ${r.results.length}`);
  check('open=true 时 filtered=0', r.filtered === 0);
}
{
  // 自定义白名单
  const svc = createSearchService({
    provider: createMockProvider({
      results: [
        { title: 'A', url: 'https://www.moe.gov.cn/a', snippet: '' },
        { title: 'B', url: 'https://www.gov.cn/b', snippet: '' },
      ],
    }),
    allowedDomains: ['moe.gov.cn'],
    fetchPageText: false,
  });
  const r = await svc.searchWeb('自定义白名单');
  check('自定义白名单只留 moe.gov.cn', r.results.length === 1 && r.results[0].url.includes('moe.gov.cn'));
}

// ─────────────────────────────────────────────── 降级
console.log('\n▸ 降级：不抛错');
{
  const svc = createSearchService({
    provider: {
      name: 'boom',
      configured: true,
      async search() {
        throw new Error('搜索服务 500');
      },
    },
  });
  let threw = false;
  let r;
  try {
    r = await svc.searchWeb('让 provider 抛错');
  } catch {
    threw = true;
  }
  check('provider 抛错时不向上抛', threw === false);
  check('返回 ok:false', r.ok === false);
  check('reason 为 provider-error', r.reason === 'provider-error');
  check('带 detail 便于排查', String(r.detail).includes('500'));
  check('结果为空数组', Array.isArray(r.results) && r.results.length === 0);
}
{
  // 失败不进缓存：下次应当重试
  let calls = 0;
  const svc = createSearchService({
    provider: {
      name: 'flaky',
      configured: true,
      async search(q, o) {
        calls++;
        if (calls === 1) throw new Error('第一次失败');
        return createMockProvider().search(q, o);
      },
    },
    fetchPageText: false,
  });
  const first = await svc.searchWeb('失败后重试');
  const second = await svc.searchWeb('失败后重试');
  check('失败结果不入缓存，第二次重试成功', first.ok === false && second.ok === true);
  check('确实重试了 provider', calls === 2, `实际 ${calls}`);
}
{
  // 超时：provider 故意无视 signal，靠 abortable 打断
  const svc = createSearchService({
    limits: { timeoutMs: 60 },
    provider: {
      name: 'hang',
      configured: true,
      search: () => new Promise(() => {}), // 永不 settle，也不看 signal
    },
  });
  const t0 = Date.now();
  const r = await svc.searchWeb('provider 一直挂着');
  const cost = Date.now() - t0;
  check('超时不会卡死', cost < 2000, `耗时 ${cost}ms`);
  check('reason 为 timeout', r.reason === 'timeout', r.reason);
  check('超时返回空结果', r.results.length === 0);
}
{
  // 外部取消
  const svc = createSearchService({
    limits: { timeoutMs: 5000 },
    provider: { name: 'hang', configured: true, search: () => new Promise(() => {}) },
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const r = await svc.searchWeb('被外部取消', { signal: ac.signal });
  check('外部取消 → reason:aborted', r.reason === 'aborted', r.reason);
}
{
  const svc = createSearchService({ provider: createMockProvider(), fetchPageText: false });
  const bare = createSearchService({ provider: { name: 'none', configured: false, search: async () => [] } });
  check(
    'provider.configured=false → provider-unconfigured',
    (await bare.searchWeb('正常长度的查询')).reason === 'provider-unconfigured',
  );
  check('空 query → query-too-short', (await svc.searchWeb('')).reason === 'query-too-short');
  check('空白 query → query-too-short', (await svc.searchWeb('   ')).reason === 'query-too-short');
}

// ─────────────────────────────────────────────── prompt 拼装
console.log('\n▸ buildContext');
{
  check('空数组返回空串', buildContext([]) === '');
  check('非数组返回空串', buildContext(null) === '');

  const ctx = buildContext([
    {
      title: '中国人民政治协商会议章程',
      url: 'http://www.cppcc.gov.cn/x.shtml',
      snippet: '中国人民政治协商会议章程……',
      site: '中国政协网',
      publishedAt: '2023-03-13T00:00:00Z',
    },
  ]);
  check('含「外部检索资料」抬头', ctx.includes('【外部检索资料】'));
  check('强调不是本文件原文', ctx.includes('不是本文件的原文'));
  check('要求标明序号引用', ctx.includes('据资料'));
  check('带标题与站点', ctx.includes('中国人民政治协商会议章程') && ctx.includes('中国政协网'));
  check('日期裁到 10 位', ctx.includes('2023-03-13') && !ctx.includes('T00:00:00Z'));
  check('带 URL', ctx.includes('http://www.cppcc.gov.cn/x.shtml'));
  check('编号从 1 开始', ctx.includes('1. 中国人民政治协商会议章程'));

  const two = buildContext([
    { title: 'A', url: 'https://www.gov.cn/a', snippet: '' },
    { title: 'B', url: 'https://www.gov.cn/b', snippet: '' },
  ]);
  check('多条按序号排列', two.includes('1. A') && two.includes('2. B'));
  check('无 snippet 时不产生空行占位', !two.includes('   \n'));
}

// ─────────────────────────────────────────────── 描述
console.log('\n▸ describe');
{
  const svc = createSearchService({ provider: createMockProvider() });
  const d = svc.describe();
  check('报告 provider 名', d.provider === 'mock');
  check('报告已配置', d.configured === true);
  check('open=false', d.open === false);
  check('默认白名单包含 gov.cn', d.allowedDomains.includes('gov.cn'));
  check('带出 limits', d.limits.maxResults === SEARCH_LIMITS.maxResults);
}

// ─────────────────────────────────────────────── 博查 provider（桩 fetch）
console.log('\n▸ bocha provider（桩 fetch）');
{
  check(
    'extractItems 兼容 webPages.value',
    extractItems({ data: { webPages: { value: [{ url: 'a' }] } } }).length === 1,
  );
  check('extractItems 兼容 values', extractItems({ webPages: { values: [{ url: 'a' }] } }).length === 1);
  check('extractItems 兼容 results', extractItems({ results: [{ url: 'a' }, { url: 'b' }] }).length === 2);
  check('extractItems 兼容裸数组', extractItems([{ url: 'a' }]).length === 1);
  check('extractItems 无法识别时返回空数组', extractItems({ message: 'ok' }).length === 0);

  const realFetch = globalThis.fetch;
  let seen = null;

  const stub = (payload, { ok = true, status = 200, text = '' } = {}) => {
    globalThis.fetch = async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return {
        ok,
        status,
        text: async () => text,
        json: async () => payload,
      };
    };
  };

  try {
    // 1) 正常返回
    stub({
      code: 200,
      data: {
        webPages: {
          value: [
            {
              name: '政协章程',
              url: 'http://www.cppcc.gov.cn/a.shtml',
              snippet: '摘要',
              summary: '模型摘要',
              siteName: '中国政协网',
              datePublished: '2023-03-13T00:00:00Z',
            },
            { name: '无 URL 的条目', url: '' },
          ],
        },
      },
    });
    const p = createBochaProvider({ apiKey: 'k-test', baseUrl: 'https://api.example.com' });
    const got = await p.search('政协章程', { count: 10 });

    check('命中 /v1/web-search', seen.url === 'https://api.example.com/v1/web-search', seen.url);
    check('方法为 POST', seen.init.method === 'POST');
    check('使用 Bearer 鉴权', seen.init.headers.Authorization === 'Bearer k-test');
    check('Content-Type 为 JSON', seen.init.headers['Content-Type'] === 'application/json');
    check('body 带 query', seen.body.query === '政协章程');
    check('body 带 count', seen.body.count === 10);
    check('body 开启 summary', seen.body.summary === true);
    check('body freshness=noLimit', seen.body.freshness === 'noLimit');
    check('未提交网站范围参数（合规约束留在本层）', !('site' in seen.body) && !('include' in seen.body));
    check('丢弃无 URL 的条目', got.length === 1, `实际 ${got.length}`);
    check('title 取 name', got[0].title === '政协章程');
    check('snippet 优先取 snippet', got[0].snippet === '摘要');
    check('site 取 siteName', got[0].site === '中国政协网');
    check('publishedAt 取 datePublished', got[0].publishedAt === '2023-03-13T00:00:00Z');

    // 2) count 越界要收敛
    stub({ code: 200, data: { webPages: { value: [] } } });
    await p.search('x', { count: 999 });
    check('count 上限收敛到 50', seen.body.count === 50, String(seen.body.count));
    await p.search('x', { count: 0 });
    check('count 下限收敛到 1', seen.body.count === 1, String(seen.body.count));

    // 3) HTTP 200 但业务失败
    stub({ code: 403, msg: '余额不足' }, { status: 200 });
    let bizErr = '';
    try {
      await p.search('x');
    } catch (e) {
      bizErr = e.message;
    }
    check('HTTP 200 + code!=200 视为失败', bizErr.includes('余额不足'), bizErr);

    // 4) HTTP 非 2xx
    stub(null, { ok: false, status: 401, text: 'Unauthorized' });
    let httpErr = '';
    try {
      await p.search('x');
    } catch (e) {
      httpErr = e.message;
    }
    check('HTTP 401 抛出并带状态码', httpErr.includes('401'), httpErr);

    // 5) 未配置 key
    const p0 = createBochaProvider({ apiKey: '' });
    check('未配置 key 时 configured=false', p0.configured === false);
    let noKey = '';
    try {
      await p0.search('x');
    } catch (e) {
      noKey = e.message;
    }
    check('无 key 调用直接报错', noKey.includes('BOCHA_API_KEY'), noKey);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ─────────────────────────────────────────────── DeepSeek 原生服务端搜索（桩 fetch）
console.log('\n▸ deepseek-native provider（桩 fetch）');
{
  /** 造一个 Anthropic 兼容 Messages 响应：thinking + web_search_tool_result + 带 citations 的 text */
  const nativePayload = ({ results = [], citations = {} } = {}) => ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-v4-flash',
    content: [
      { type: 'thinking', thinking: '需要检索' },
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'q' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: results },
      {
        type: 'text',
        text: '根据检索结果……',
        citations: Object.entries(citations).map(([url, cited_text]) => ({
          type: 'web_search_result_location',
          url,
          cited_text,
        })),
      },
    ],
    usage: { server_tool_use: { web_search_requests: 1 } },
  });

  let seen = null;
  const stub = (payload, { ok = true, status = 200, text = '' } = {}) => async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return {
      ok,
      status,
      text: async () => text,
      json: async () => payload,
    };
  };

  // 1) 请求形状 + 映射 + 去重
  const payload = nativePayload({
    results: [
      { type: 'web_search_result', url: 'https://www.gov.cn/a', title: '中国政府网 A', page_age: '2024-05-01T00:00:00Z' },
      { type: 'web_search_result', url: 'https://www.gov.cn/a', title: '重复的同 URL', page_age: '2024-05-02' },
      { type: 'web_search_result', url: 'https://www.zhihu.com/question/1', title: '知乎答案', page_age: '' },
      { type: 'web_search_result', url: '', title: '没有 URL' },
      { type: 'web_search_result', url: 'https://www.news.cn/b' }, // 无标题 → 回退 url
    ],
    citations: {
      'https://www.gov.cn/a': '这是 gov.cn 的引用摘要',
      'https://www.news.cn/b': '这是新华网的引用摘要',
    },
  });
  // 同一 URL 的后续 citation 不得覆盖首次命中（对象字面量会去重 key，这里显式补一个 text 块）
  payload.content.push({
    type: 'text',
    text: '后面又引用了一次同一个页面',
    citations: [{ type: 'web_search_result_location', url: 'https://www.gov.cn/a', cited_text: '后来的引用，应被忽略' }],
  });
  const p = createDeepseekNativeProvider({ apiKey: 'k-test', fetchImpl: stub(payload) });
  check('有 key 时 configured=true', p.configured === true);

  const got = await p.search('民营经济促进法 施行日期', { count: 20 });
  check('命中 {baseUrl}/messages', seen.url === 'https://api.deepseek.com/anthropic/v1/messages', seen.url);
  check('方法为 POST', seen.init.method === 'POST');
  check('x-api-key 传 key', seen.init.headers['x-api-key'] === 'k-test');
  check('authorization 为 Bearer', seen.init.headers.authorization === 'Bearer k-test');
  check('anthropic-version=2023-06-01', seen.init.headers['anthropic-version'] === '2023-06-01');
  check('content-type 为 JSON', seen.init.headers['content-type'] === 'application/json');
  check('默认模型 deepseek-v4-flash', seen.body.model === 'deepseek-v4-flash', seen.body.model);
  check('默认 max_tokens=1024', seen.body.max_tokens === 1024, String(seen.body.max_tokens));
  check('tools[0].type=web_search_20250305', seen.body.tools?.[0]?.type === 'web_search_20250305');
  check('tools[0].name=web_search', seen.body.tools?.[0]?.name === 'web_search');
  check('tools[0].max_uses=2', seen.body.tools?.[0]?.max_uses === 2, String(seen.body.tools?.[0]?.max_uses));
  check(
    'messages 是「执行检索」指令而非提问',
    seen.body.messages?.[0]?.role === 'user' &&
      seen.body.messages[0].content?.[0]?.type === 'text' &&
      seen.body.messages[0].content[0].text.includes('民营经济促进法 施行日期'),
    JSON.stringify(seen.body.messages?.[0]?.content),
  );

  check('按 URL 去重并丢弃无 URL 的条目（5 → 3）', got.length === 3, `实际 ${got.length}`);
  check(
    '条目字段固定为 {title,url,snippet,site,publishedAt}',
    got.every(
      (x) =>
        typeof x.title === 'string' &&
        typeof x.url === 'string' &&
        typeof x.snippet === 'string' &&
        typeof x.site === 'string' &&
        typeof x.publishedAt === 'string',
    ),
  );
  const gov = got.find((x) => x.url.includes('gov.cn/a'));
  check('snippet 取自 citations[].cited_text', gov?.snippet === '这是 gov.cn 的引用摘要', gov?.snippet);
  check('同一 URL 的后续 citation 不覆盖首次命中', gov?.snippet !== '后来的引用，应被忽略', gov?.snippet);
  check('publishedAt 取自 page_age', gov?.publishedAt === '2024-05-01T00:00:00Z', gov?.publishedAt);
  check('site 由 URL 主机名推导（去 www）', gov?.site === 'gov.cn', gov?.site);
  const news = got.find((x) => x.url.includes('news.cn/b'));
  check('title 为空时回退 url', news?.title === 'https://www.news.cn/b', news?.title);
  check('无 citations 的条目 snippet 为空串', got.find((x) => x.url.includes('zhihu'))?.snippet === '', JSON.stringify(got.find((x) => x.url.includes('zhihu'))?.snippet));

  // signal 透传
  const ac = new AbortController();
  await p.search('取消测试', { count: 5, signal: ac.signal });
  check('signal 透传给 fetch', seen.init.signal === ac.signal);

  // count 生效
  const limited = await p.search('截断测试', { count: 2 });
  check('count 生效（截断到 2 条）', limited.length === 2, `实际 ${limited.length}`);

  // 2) 缺结果块 → 抛错（不降级、不从正文扒 URL）
  const noBlock = {
    content: [
      { type: 'thinking', thinking: '我直接答' },
      { type: 'text', text: '我觉得可以参考 https://www.gov.cn/fake 这个页面。' },
    ],
  };
  let errMissing = '';
  let missingReturned = null;
  try {
    missingReturned = await createDeepseekNativeProvider({ apiKey: 'k', fetchImpl: stub(noBlock) }).search('q');
  } catch (e) {
    errMissing = e.message;
  }
  check('缺 web_search_tool_result 块 → 抛错', errMissing.includes('web_search_tool_result'), errMissing);
  check('缺结果块时不返回数组（不降级）', missingReturned === null);

  // 服务端工具自身报错也不能当成「没搜到」
  const errBlock = {
    content: [
      { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    ],
  };
  let errTool = '';
  try {
    await createDeepseekNativeProvider({ apiKey: 'k', fetchImpl: stub(errBlock) }).search('q');
  } catch (e) {
    errTool = e.message;
  }
  check('工具侧报错块 → 抛错并带 error_code', errTool.includes('max_uses_exceeded'), errTool);

  // 3) 非 2xx → 抛错并带状态码
  let errHttp = '';
  try {
    await createDeepseekNativeProvider({
      apiKey: 'k',
      fetchImpl: stub(null, { ok: false, status: 401, text: 'Unauthorized' }),
    }).search('q');
  } catch (e) {
    errHttp = e.message;
  }
  check('非 2xx → 抛错', errHttp.includes('401'), errHttp);

  // 4) 未配置 key
  const p0 = createDeepseekNativeProvider({ apiKey: '' });
  check('无 key 时 configured=false', p0.configured === false);
  let noKey = '';
  try {
    await p0.search('x');
  } catch (e) {
    noKey = e.message;
  }
  check('无 key 调用直接报错', noKey.includes('DEEPSEEK_API_KEY'), noKey);

  // 5) 端点/模型可覆盖
  const custom = createDeepseekNativeProvider({
    apiKey: 'k',
    baseUrl: 'https://example.com/anthropic/v1',
    model: 'custom-model',
    maxTokens: 256,
    maxUses: 5,
    fetchImpl: stub(nativePayload({ results: [] })),
  });
  await custom.search('覆盖默认值');
  check('baseUrl 可覆盖', seen.url === 'https://example.com/anthropic/v1/messages', seen.url);
  check('model 可覆盖', seen.body.model === 'custom-model', seen.body.model);
  check('maxTokens 可覆盖', seen.body.max_tokens === 256, String(seen.body.max_tokens));
  check('maxUses 可覆盖', seen.body.tools?.[0]?.max_uses === 5, String(seen.body.tools?.[0]?.max_uses));
}

// ─────────────────────────────────────────────── 环境变量组装（含 deepseek 分支）
console.log('\n▸ createSearchServiceFromEnv（deepseek 分支）');
{
  for (const kind of ['deepseek', 'deepseek-native', 'native']) {
    const svc = createSearchServiceFromEnv({ SEARCH_PROVIDER: kind, DEEPSEEK_API_KEY: 'k' });
    check(`SEARCH_PROVIDER=${kind} → provider=deepseek 且 enabled`, svc.describe().provider === 'deepseek' && svc.enabled === true, `${svc.describe().provider}/${svc.enabled}`);
  }

  const noKey = createSearchServiceFromEnv({ SEARCH_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: '' });
  check('deepseek 无 key → enabled=false', noKey.enabled === false);
  check('deepseek 无 key → configured=false（provider 名仍如实上报）', noKey.describe().provider === 'deepseek' && noKey.describe().configured === false, JSON.stringify(noKey.describe()));

  const off = createSearchServiceFromEnv({ SEARCH_PROVIDER: 'none' });
  check('默认 none → enabled=false', off.enabled === false && off.describe().provider === 'none');

  const withMock = createSearchServiceFromEnv({ SEARCH_PROVIDER: 'mock' });
  check('mock 分支不受影响', withMock.enabled === true && withMock.describe().provider === 'mock');

  // 白名单仍然生效：native 返回的非权威 URL 由 searchWeb 滤除
  let seen = null;
  const stub = (payload) => async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => '', json: async () => payload };
  };
  const native = createDeepseekNativeProvider({
    apiKey: 'k',
    fetchImpl: stub({
      content: [
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'https://www.gov.cn/keep', title: '权威来源', page_age: '2024-01-01' },
            { type: 'web_search_result', url: 'https://www.zhihu.com/drop', title: '非权威来源', page_age: '' },
          ],
        },
      ],
    }),
  });
  const svc = createSearchService({ provider: native, fetchPageText: false });
  const r = await svc.searchWeb('白名单回归');
  check('native 结果过白名单后只剩权威源', r.ok === true && r.results.length === 1 && r.results[0].url.includes('gov.cn/keep'), JSON.stringify(r.results.map((x) => x.url)));
  check('非权威源计入 filtered', r.filtered === 1, String(r.filtered));
  check('native provider 的检索没有被跳过', seen?.url?.endsWith('/messages'));
}

// ─────────────────────────────────────────────── 抓取来源页正文：HTML → 文本
console.log('\n▸ htmlToText');
{
  check(
    '剥离 script/style 及其内容',
    (() => {
      const t = htmlToText('<div>甲<script>var a=1;</script><style>.x{color:red}</style>乙</div>');
      return t.includes('甲') && t.includes('乙') && !t.includes('var a') && !t.includes('color:red');
    })(),
  );
  check(
    '剥离注释、noscript 与 svg',
    (() => {
      const t = htmlToText('<p>正文<!-- 隐藏注释 --></p><noscript>noscript内容</noscript><svg><path d="x"/></svg>');
      return !t.includes('隐藏注释') && !t.includes('noscript内容') && t.includes('正文');
    })(),
  );
  check(
    '实体解码（命名 + 十进制 + 十六进制）',
    htmlToText('<p>a&nbsp;b &amp; c &lt;d&gt; &quot;e&quot; &#39;f&#39; &#x4e2d;</p>') === 'a b & c <d> "e" \'f\' 中',
    JSON.stringify(htmlToText('<p>a&nbsp;b &amp; c &lt;d&gt; &quot;e&quot; &#39;f&#39; &#x4e2d;</p>')),
  );
  check('未知实体原样保留', htmlToText('a&unknown;b') === 'a&unknown;b', htmlToText('a&unknown;b'));
  check('块级标签产生换行', htmlToText('<p>第一段</p><p>第二段</p>') === '第一段\n第二段', JSON.stringify(htmlToText('<p>第一段</p><p>第二段</p>')));
  check('<br> 产生换行', htmlToText('上<br>下') === '上\n下', JSON.stringify(htmlToText('上<br>下')));
  check('行内连续空白归一为单空格', htmlToText('<div>  多 \t  空白  </div>') === '多 空白', JSON.stringify(htmlToText('<div>  多 \t  空白  </div>')));
  check('连续空行归一为一个换行', htmlToText('<p>甲</p><p></p><p>乙</p>') === '甲\n乙', JSON.stringify(htmlToText('<p>甲</p><p></p><p>乙</p>')));
  check('全角空格也归一', htmlToText('甲\u3000\u3000乙') === '甲 乙', JSON.stringify(htmlToText('甲\u3000\u3000乙')));
  check('纯文本原样返回', htmlToText('就是一段话') === '就是一段话');
}

// ─────────────────────────────────────────────── 抓取来源页正文：编码识别
console.log('\n▸ decodeHtmlBuffer');
{
  // GBK「中文」= D6 D0 CE C4；这两个字节序列不是合法 UTF-8，正好用来验证回落
  const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  check('运行环境支持 GBK 解码', new TextDecoder('gbk').decode(GBK_ZHONGWEN) === '中文');

  const utf8Doc = Buffer.from('<html><body>中文测试</body></html>', 'utf8');
  const gbkDoc = Buffer.concat([
    Buffer.from('<html><head><meta charset="gbk"></head><body>', 'latin1'),
    GBK_ZHONGWEN,
    Buffer.from('</body></html>', 'latin1'),
  ]);
  const gbkHttpEquiv = Buffer.concat([
    Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gbk"></head><body>', 'latin1'),
    GBK_ZHONGWEN,
    Buffer.from('</body></html>', 'latin1'),
  ]);

  check('① Content-Type 的 charset 优先', decodeHtmlBuffer(utf8Doc, 'text/html; charset=utf-8').includes('中文测试'));
  check('① charset 别名 gb2312 → gb18030', decodeHtmlBuffer(gbkDoc, 'text/html; charset=gb2312').includes('中文'));
  check('① charset 大小写不敏感（UTF8）', decodeHtmlBuffer(utf8Doc, 'text/html; Charset=UTF8').includes('中文测试'));
  check('② meta charset 生效', decodeHtmlBuffer(gbkDoc, 'text/html').includes('中文'));
  check('② meta http-equiv 形式生效', decodeHtmlBuffer(gbkHttpEquiv, '').includes('中文'));
  check('③ 无声明但合法 UTF-8 → 严格 UTF-8', decodeHtmlBuffer(utf8Doc, '').includes('中文测试'));
  check('④ 无声明且非 UTF-8 → GBK 回落', decodeHtmlBuffer(gbkDoc, '').includes('中文'));
  check('未知 charset 走探测而非乱码', decodeHtmlBuffer(utf8Doc, 'text/html; charset=x-unknown').includes('中文测试'));
  check('被截断的 UTF-8 尾巴不会误判成 GBK', decodeHtmlBuffer(utf8Doc.subarray(0, utf8Doc.length - 2), '').includes('中文测试'));
}

// ─────────────────────────────────────────────── 抓取来源页正文：抓取器
console.log('\n▸ createPageFetcher');
{
  /** 造一个带流式 body 的假响应 */
  const makeResponse = ({ chunks, contentType = 'text/html; charset=utf-8', status = 200 }) => {
    const list = Array.isArray(chunks) ? chunks : [chunks];
    const state = { reads: 0, canceled: false };
    return {
      state,
      resp: {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
        body: {
          getReader: () => ({
            async read() {
              state.reads++;
              return state.reads <= list.length
                ? { done: false, value: list[state.reads - 1] }
                : { done: true, value: undefined };
            },
            async cancel() {
              state.canceled = true;
            },
          }),
        },
      },
    };
  };
  const bytes = (s) => new TextEncoder().encode(s);

  // 正常抓取
  {
    let seen = null;
    const { resp } = makeResponse({ chunks: [bytes('<html><body><p>正文内容在这里</p></body></html>')] });
    const fetcher = createPageFetcher({
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return resp;
      },
    });
    const text = await fetcher.fetchText('https://www.gov.cn/a.htm');
    check('抓取并提取纯文本', text === '正文内容在这里', JSON.stringify(text));
    check('GET 且 redirect=error', seen.init.method === 'GET' && seen.init.redirect === 'error', JSON.stringify({ m: seen.init.method, r: seen.init.redirect }));
    check('带 signal 与 UA/accept', seen.init.signal instanceof AbortSignal && Boolean(seen.init.headers['user-agent']) && Boolean(seen.init.headers.accept));
  }

  // 非文本内容跳过
  {
    let called = 0;
    const { resp } = makeResponse({ chunks: [bytes('%PDF-1.4')], contentType: 'application/pdf' });
    const fetcher = createPageFetcher({ fetchImpl: async () => { called++; return resp; } });
    check('非文本 content-type → 返回空串', (await fetcher.fetchText('https://www.gov.cn/a.pdf')) === '');
    check('非文本也会先读响应（只是不解析）', called === 1);
  }

  // 非 2xx
  {
    const { resp } = makeResponse({ chunks: [bytes('err')], status: 500 });
    const fetcher = createPageFetcher({ fetchImpl: async () => resp });
    check('非 2xx → 返回空串', (await fetcher.fetchText('https://www.gov.cn/err')) === '');
  }

  // 抛错不外传
  {
    const fetcher = createPageFetcher({
      fetchImpl: async () => {
        throw new Error('网络炸了');
      },
    });
    let threw = false;
    let out = 'x';
    try {
      out = await fetcher.fetchText('https://www.gov.cn/boom');
    } catch {
      threw = true;
    }
    check('fetch 抛错不向外传播', threw === false && out === '');
  }

  // 超时（对方无视 signal，靠自管 AbortController 收敛）
  {
    const fetcher = createPageFetcher({ timeoutMs: 40, fetchImpl: () => new Promise(() => {}) });
    const t0 = Date.now();
    const out = await fetcher.fetchText('https://www.gov.cn/hang');
    const cost = Date.now() - t0;
    check('超时 → 返回空串且不卡死', out === '' && cost < 1500, `${cost}ms`);
  }

  // maxBytes：按上限截断，且不把整包读完
  {
    const big = Array.from({ length: 10 }, () => new Uint8Array(100).fill(0x61)); // 10 × 100 字节
    const { resp, state } = makeResponse({ chunks: big });
    const fetcher = createPageFetcher({ maxBytes: 250, fetchImpl: async () => resp });
    const text = await fetcher.fetchText('https://www.gov.cn/big');
    check('超过 maxBytes 按上限截断', text.length === 250, String(text.length));
    check('到上限即停（只读 3 个 chunk，不全读）', state.reads === 3, String(state.reads));
    check('提前取消剩余流', state.canceled === true);
  }

  // SSRF / 协议兜底：一律不发起 fetch
  {
    let called = 0;
    const fetcher = createPageFetcher({ fetchImpl: async () => { called++; return makeResponse({ chunks: [bytes('x')] }).resp; } });
    const denied = [];
    for (const u of [
      'http://127.0.0.1/x',
      'http://10.0.0.1/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://169.254.1.1/x',
      'http://localhost/x',
      'http://foo.local/x',
      'file:///etc/passwd',
      'ftp://www.gov.cn/x',
      'not a url',
    ]) {
      denied.push(await fetcher.fetchText(u));
    }
    check('本机/私网/非 http(s) 一律返回空串', denied.every((d) => d === ''));
    check('被拒的 URL 完全不发起 fetch', called === 0, String(called));
  }
  check(
    'isPrivateHost 边界',
    isPrivateHost('127.0.0.1') &&
      isPrivateHost('10.0.0.1') &&
      isPrivateHost('172.16.0.1') &&
      !isPrivateHost('172.32.0.1') &&
      isPrivateHost('192.168.0.1') &&
      isPrivateHost('169.254.1.1') &&
      isPrivateHost('localhost') &&
      isPrivateHost('x.local') &&
      isPrivateHost('::1') &&
      !isPrivateHost('www.gov.cn'),
  );

  // 缓存
  {
    let called = 0;
    const { resp } = makeResponse({ chunks: [bytes('<p>缓存正文</p>')] });
    const fetcher = createPageFetcher({ fetchImpl: async () => { called++; return resp; } });
    await fetcher.fetchText('https://www.gov.cn/c');
    const second = await fetcher.fetchText('https://www.gov.cn/c');
    check('同 URL 命中缓存，只抓一次', called === 1 && second === '缓存正文');
  }

  // 并发上限
  {
    let active = 0;
    let maxActive = 0;
    const fetcher = createPageFetcher({
      concurrency: 2,
      fetchImpl: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return makeResponse({ chunks: [bytes('<p>x</p>')] }).resp;
      },
    });
    await Promise.all([1, 2, 3, 4].map((i) => fetcher.fetchText(`https://www.gov.cn/p${i}`)));
    check('并发不超过 concurrency', maxActive <= 2 && maxActive >= 1, String(maxActive));
  }

  // 调用方 signal 已取消
  {
    const fetcher = createPageFetcher({ timeoutMs: 2000, fetchImpl: () => new Promise(() => {}) });
    const ac = new AbortController();
    ac.abort();
    const out = await fetcher.fetchText('https://www.gov.cn/aborted', { signal: ac.signal });
    check('调用方已取消 → 返回空串', out === '');
  }
}

// ─────────────────────────────────────────────── 抓取来源页正文：searchWeb 集成
console.log('\n▸ searchWeb 补正文');
{
  const mkProvider = (results) => createMockProvider({ results });
  const longText = '正文'.repeat(600); // 1200 字，用来验证 800 字上限
  const emptyResults = (n) =>
    Array.from({ length: n }, (_, i) => ({
      title: `第 ${i} 篇`,
      url: `https://www.gov.cn/doc/${i}`,
      snippet: '',
      site: '中国政府网',
    }));

  // ① 空摘要被填上正文
  {
    const asked = [];
    const pageFetcher = {
      async fetchText(url) {
        asked.push(url);
        return longText;
      },
    };
    const svc = createSearchService({ provider: mkProvider(emptyResults(2)), pageFetcher });
    const r = await svc.searchWeb('补正文①');
    check('空摘要被填上正文', r.results.every((x) => x.snippet.startsWith('正文')), JSON.stringify(r.results.map((x) => x.snippet.length)));
    check('只对采纳的两条抓取', asked.length === 2 && asked[0].includes('/doc/0'), asked.join(','));
    check('单条最多 800 字', r.results[0].snippet.length === 800, String(r.results[0].snippet.length));
    check('检索仍视为成功', r.ok === true && r.cached === false);
  }

  // ② 已有 snippet：不抓取、不覆盖
  {
    let called = 0;
    const original = '这是一条来自搜索服务商的现成摘要，长度足够，不该被覆盖，也不该浪费一次抓取请求。';
    const svc = createSearchService({
      provider: mkProvider([{ title: 'A', url: 'https://www.gov.cn/a', snippet: original, site: '中国政府网' }]),
      pageFetcher: {
        async fetchText() {
          called++;
          return '不该出现';
        },
      },
    });
    const r = await svc.searchWeb('补正文②');
    check('已有 snippet 不被覆盖', r.results[0].snippet === original, r.results[0].snippet);
    check('已有 snippet 不触发抓取', called === 0, String(called));
  }

  // ③ 抓取失败：ok 仍 true，snippet 留空
  {
    const svc = createSearchService({
      provider: mkProvider(emptyResults(2)),
      pageFetcher: {
        async fetchText() {
          return '';
        },
      },
    });
    const r = await svc.searchWeb('补正文③');
    check('抓取失败仍 ok:true', r.ok === true && r.results.length === 2);
    check('失败时 snippet 保持为空', r.results.every((x) => x.snippet === ''));

    const svcThrow = createSearchService({
      provider: mkProvider(emptyResults(1)),
      pageFetcher: {
        async fetchText() {
          throw new Error('抓取器炸了');
        },
      },
    });
    let threw = false;
    let rt = null;
    try {
      rt = await svcThrow.searchWeb('补正文③b');
    } catch {
      threw = true;
    }
    check('抓取器抛错也不向上传播', threw === false && rt.ok === true && rt.results[0].snippet === '');
  }

  // ④ fetchPageText:false → 完全不抓
  {
    let called = 0;
    const svc = createSearchService({
      provider: mkProvider(emptyResults(2)),
      fetchPageText: false,
      pageFetcher: {
        async fetchText() {
          called++;
          return longText;
        },
      },
    });
    const r = await svc.searchWeb('补正文④');
    check('fetchPageText:false 完全不抓', called === 0);
    check('关闭后 snippet 保持为空', r.results.every((x) => x.snippet === ''));
  }

  // ⑤ pageFetchMax 只抓前 N 条
  {
    const asked = [];
    const svc = createSearchService({
      provider: mkProvider(emptyResults(4)),
      limits: { pageFetchMax: 2 },
      pageFetcher: {
        async fetchText(url) {
          asked.push(url);
          return longText;
        },
      },
    });
    const r = await svc.searchWeb('补正文⑤');
    check('只抓前 N 条（pageFetchMax=2）', asked.length === 2, String(asked.length));
    check('前两条被填、后两条留空', r.results[0].snippet !== '' && r.results[1].snippet !== '' && r.results[2].snippet === '' && r.results[3].snippet === '');
  }

  // ⑥ 填好正文后的结果进结果缓存：同一 query 不重复抓页面
  {
    let called = 0;
    const svc = createSearchService({
      provider: mkProvider(emptyResults(2)),
      pageFetcher: {
        async fetchText() {
          called++;
          return longText;
        },
      },
    });
    const first = await svc.searchWeb('补正文⑥');
    const second = await svc.searchWeb('补正文⑥');
    check('第二次命中结果缓存', second.cached === true && first.cached === false);
    check('同一 query 不重复抓页面', called === 2, String(called));
    check('缓存里带着已填好的正文', second.results[0].snippet === first.results[0].snippet && second.results[0].snippet !== '');
  }

  // ⑦ 环境变量开关与调参
  {
    check(
      'SEARCH_FETCH_PAGES=0 → 关闭补正文',
      createSearchServiceFromEnv({ SEARCH_PROVIDER: 'mock', SEARCH_FETCH_PAGES: '0' }).describe().pageText === false,
    );
    check(
      '默认开启补正文',
      createSearchServiceFromEnv({ SEARCH_PROVIDER: 'mock' }).describe().pageText === true,
    );
    const tuned = createSearchServiceFromEnv({
      SEARCH_PROVIDER: 'mock',
      SEARCH_FETCH_MAX: '7',
      SEARCH_FETCH_TIMEOUT_MS: '1234',
      SEARCH_FETCH_MAX_BYTES: '4096',
    });
    check(
      'SEARCH_FETCH_MAX / TIMEOUT_MS / MAX_BYTES 生效',
      tuned.limits.pageFetchMax === 7 && tuned.limits.pageFetchTimeoutMs === 1234 && tuned.limits.pageFetchMaxBytes === 4096,
      JSON.stringify({ max: tuned.limits.pageFetchMax, t: tuned.limits.pageFetchTimeoutMs, b: tuned.limits.pageFetchMaxBytes }),
    );
  }
}

console.log(`\n${fail === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m${fail} 项失败\x1b[0m`}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);