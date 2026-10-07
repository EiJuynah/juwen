/**
 * 探针：DeepSeek 原生搜索响应里**到底有什么**（原始块结构 + 每个字段是否可用）。
 *
 * 要回答的问题：真机反馈「你只检索了标题，没有正文内容」——
 *   1. web_search_result 条目除了 url/title/page_age 还有没有 content/text/snippet 字段？
 *   2. text 块里有没有 citations，citations 里有没有 cited_text？
 *   3. max_tokens 调大能不能换来更多带 cited_text 的引用？
 *
 * 跑法：node wb/probe-native-search-raw.mjs [查询词] [max_tokens]
 */
import 'dotenv/config';

const KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE = process.env.DEEPSEEK_SEARCH_BASE_URL || 'https://api.deepseek.com/anthropic/v1';
const QUERY = process.argv[2] || '组织部门 统战部门 协作配合机制 联席会议';
const MAX_TOKENS = Number(process.argv[3] || 1024);

async function run(maxTokens) {
  const t0 = Date.now();
  const resp = await fetch(`${BASE}/messages`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'x-api-key': KEY,
      authorization: `Bearer ${KEY}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_SEARCH_MODEL || 'deepseek-v4-flash',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${QUERY}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    }),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!resp.ok) return { status: resp.status, detail: (await resp.text()).slice(0, 200), secs };
  const json = await resp.json();
  const blocks = json.content ?? [];

  console.log(`\n═══ max_tokens=${maxTokens}  ${secs}s  usage=${JSON.stringify(json.usage)} ═══`);
  console.log('块类型序列:', blocks.map((b) => b.type).join(' → '));

  // 1) text 块与 citations
  const textBlocks = blocks.filter((b) => b.type === 'text');
  console.log(`\ntext 块 ${textBlocks.length} 个，正文合计 ${textBlocks.reduce((a, b) => a + (b.text?.length || 0), 0)} 字`);
  let citeTotal = 0;
  let citeWithText = 0;
  for (const b of textBlocks) {
    const cites = b.citations ?? [];
    citeTotal += cites.length;
    for (const c of cites) {
      if (c.cited_text) citeWithText++;
      console.log(
        `  citation keys=[${Object.keys(c).join(',')}]  cited_text=${c.cited_text ? c.cited_text.length + '字' : '(缺失)'}  url=${c.url ?? '-'}`,
      );
    }
  }
  console.log(`citations 合计 ${citeTotal} 条，其中带 cited_text 的 ${citeWithText} 条`);

  // 2) 搜索结果条目：打印全部字段名，看有没有被我们丢掉的正文
  const items = [];
  for (const b of blocks.filter((b) => b.type === 'web_search_tool_result')) {
    for (const it of b.content ?? []) items.push(it);
  }
  console.log(`\nweb_search_result 条目 ${items.length} 条`);
  const keySet = new Set();
  for (const it of items) for (const k of Object.keys(it)) keySet.add(k);
  console.log('条目字段并集:', [...keySet].join(', '));
  for (const it of items.slice(0, 4)) {
    console.log('  ──');
    for (const [k, v] of Object.entries(it)) {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      console.log(`    ${k}: ${String(s).replace(/\s+/g, ' ').slice(0, 120)}${String(s).length > 120 ? '…' : ''}`);
    }
  }
  const withText = items.filter((it) => it.text || it.content || it.snippet || it.page_content).length;
  console.log(`带正文字段（text/content/snippet/page_content）的条目：${withText}/${items.length}`);

  // 3) 模型在这次检索里写的正文（我们当前会丢掉它）
  console.log('\n模型这次检索生成的正文（前 200 字，当前实现丢弃）:');
  console.log('  ' + textBlocks.map((b) => b.text).join(' ').replace(/\s+/g, ' ').slice(0, 200) + '…');

  return { secs, items: items.length, citeTotal, citeWithText, withText };
}

console.log(`查询：${QUERY}\n端点：${BASE}/messages`);
const a = await run(1024);
const b = await run(4096);
console.log('\n──── 对比 ────');
console.log('max_tokens=1024:', JSON.stringify(a));
console.log('max_tokens=4096:', JSON.stringify(b));
console.log('\n若两条都显示「带正文字段的条目 0/N」且 citations 很少/无 cited_text，');
console.log('则结论是：原生搜索只给元数据，正文必须由我们自己抓页面。');
