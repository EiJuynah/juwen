/**
 * 探针：DeepSeek 原生服务端搜索（Anthropic 兼容 Messages API）能不能用。
 *
 * 背景：本项目此前只试过 OpenAI 兼容的 /chat/completions，那里的内置工具会被
 * **静默忽略**，因此结论是「DeepSeek 不支持联网，只能自己接第三方搜索」。
 * 但 DSH 内核自带的检索插件 @deepseek-ai/dsh-web-search-deepseek 走的不是这条路：
 * 它调 Anthropic 兼容端点 https://api.deepseek.com/anthropic/v1/messages，
 * 挂原生服务端工具 web_search_20250305，用**同一把 DEEPSEEK_API_KEY** 鉴权。
 *
 * 本探针要回答：
 *   1. 用现有 API Key 调 Anthropic 端点能不能通（鉴权头、模型名）？
 *   2. 响应里到底有没有 web_search_tool_result 结构化块（而不是从正文里扒 URL）？
 *   3. 返回的来源长什么样（url/title/page_age/cited_text）、有多少条？
 *   4. 这些来源有多少能过本项目的权威源白名单？
 *
 * 跑法：node wb/probe-deepseek-native-search.mjs [查询词]
 */
import 'dotenv/config';
import { isAllowedUrl, DEFAULT_ALLOWED_DOMAINS } from '../server/search/allowlist.js';

const KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE = process.env.DEEPSEEK_SEARCH_BASE_URL || 'https://api.deepseek.com/anthropic/v1';
const QUERY = process.argv[2] || '民营经济促进法 施行日期 官方';

/** DSH 内核这份插件支持的候选模型名，逐个试 */
const MODELS = ['deepseek-v4-flash', process.env.DEEPSEEK_MODEL || 'deepseek-flash'];

async function probe(model) {
  const body = {
    model,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `Perform a web search for the query: ${QUERY}` }],
      },
    ],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
  };

  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(`${BASE}/messages`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'x-api-key': KEY,
        authorization: `Bearer ${KEY}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'readtool-probe/0.1',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { model, error: String(err.message || err) };
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { model, status: resp.status, secs, detail: text.slice(0, 300) };
  }

  const json = await resp.json();
  const blocks = json.content ?? [];
  const resultBlocks = blocks.filter((b) => b.type === 'web_search_tool_result');
  const snippets = new Map();
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    for (const c of b.citations ?? []) {
      if (c.url && c.cited_text && !snippets.has(c.url)) snippets.set(c.url, c.cited_text);
    }
  }
  const sources = [];
  const seen = new Set();
  for (const rb of resultBlocks) {
    for (const item of rb.content ?? []) {
      if (item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      sources.push({
        url: item.url,
        title: item.title,
        publishedAt: item.page_age,
        snippet: snippets.get(item.url),
      });
    }
  }
  return {
    model,
    status: resp.status,
    secs,
    usage: json.usage,
    blockTypes: blocks.map((b) => b.type),
    serverToolUse: json.usage?.server_tool_use,
    sources,
  };
}

console.log(`\n查询：${QUERY}\n端点：${BASE}/messages\n密钥：${KEY ? '已配置' : '缺失'}\n`);

for (const model of MODELS) {
  console.log(`──────── 模型 ${model} ────────`);
  const r = await probe(model);
  if (r.error) {
    console.log(`  传输错误：${r.error}`);
    continue;
  }
  if (r.status !== 200) {
    console.log(`  HTTP ${r.status}（${r.secs}s）：${r.detail}`);
    continue;
  }
  console.log(`  HTTP 200，耗时 ${r.secs}s，content 块类型：${r.blockTypes.join(', ')}`);
  console.log(`  usage：${JSON.stringify(r.usage)}`);
  if (r.serverToolUse) console.log(`  服务端工具调用：${JSON.stringify(r.serverToolUse)}`);
  console.log(`  结构化来源 ${r.sources.length} 条：`);
  for (const s of r.sources) {
    const ok = isAllowedUrl(s.url, DEFAULT_ALLOWED_DOMAINS) ? '✓过白名单' : '✗被白名单滤除';
    console.log(`    [${ok}] ${s.title || '(无标题)'}  ${s.url}  ${s.publishedAt || ''}`);
    if (s.snippet) console.log(`        snippet: ${String(s.snippet).replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  const passed = r.sources.filter((s) => isAllowedUrl(s.url, DEFAULT_ALLOWED_DOMAINS)).length;
  console.log(`  → 白名单命中 ${passed}/${r.sources.length}`);
  if (r.sources.length > 0) break; // 打通一个模型名就够了
}

console.log('\n──── 结论 ────');
console.log('若上面出现 web_search_tool_result 结构化来源，说明「DeepSeek 原生服务端搜索 +');
console.log('现有 API Key」在本项目可直接使用，无需第三方搜索服务商。');
