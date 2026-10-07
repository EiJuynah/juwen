/**
 * 离线 / 演示用 provider。
 *
 * 用途：
 *   · 让检索层可以在没有搜索 API key 的情况下跑测试（见 scripts/search-test.mjs）；
 *   · 本地演示联网交互时给出稳定、可预期的结果。
 *
 * 刻意混入 zhihu.com / baidu.com 等**非权威源**，用来验证白名单确实在过滤，
 * 而不是把所有结果照单全收。
 */

export const MOCK_RESULTS = [
  {
    title: '中共中央印发《中国共产党统一战线工作条例》',
    url: 'https://www.gov.cn/zhengce/2020-12/21/content_5570077.htm',
    snippet:
      '新华社北京12月21日电 近日，中共中央印发了《中国共产党统一战线工作条例》，并发出通知，要求各地区各部门认真遵照执行。',
    site: '中国政府网',
    publishedAt: '2020-12-21T00:00:00Z',
  },
  {
    title: '中国人民政治协商会议章程',
    url: 'http://www.cppcc.gov.cn/zxww/2023/03/13/ARTI1678681834993124.shtml',
    snippet: '中国人民政治协商会议章程（1982年12月11日中国人民政治协商会议第五届全国委员会第五次会议通过）。',
    site: '中国政协网',
    publishedAt: '2023-03-13T00:00:00Z',
  },
  {
    title: '非公有制经济人士和新的社会阶层人士统战工作',
    url: 'https://www.news.cn/politics/2021-06/25/c_1127595000.htm',
    snippet: '做好非公有制经济人士和新的社会阶层人士统战工作，是新时代统一战线工作的重要内容。',
    site: '新华网',
    publishedAt: '2021-06-25T00:00:00Z',
  },
  {
    // ↓ 以下两条不属于权威源，应当被 allowlist 过滤掉
    title: '民营经济人士是怎么界定的？——知乎',
    url: 'https://www.zhihu.com/question/123456789',
    snippet: '这个问题下面有几个回答……',
    site: '知乎',
    publishedAt: '2024-05-01T00:00:00Z',
  },
  {
    title: '非公有制经济人士_百度百科',
    url: 'https://baike.baidu.com/item/%E9%9D%9E%E5%85%AC%E6%9C%89%E5%88%B6%E7%BB%8F%E6%B5%8E%E4%BA%BA%E5%A3%AB',
    snippet: '非公有制经济人士是指……',
    site: '百度百科',
    publishedAt: '',
  },
];

export function createMockProvider({ results = MOCK_RESULTS, delayMs = 0 } = {}) {
  return {
    name: 'mock',
    configured: true,
    async search(query, { count = 20, signal } = {}) {
      if (delayMs) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (signal?.aborted) throw new Error('已取消');
      // 模拟服务端按 count 截断
      return results.slice(0, count).map((r) => ({ ...r, _query: query }));
    },
  };
}
