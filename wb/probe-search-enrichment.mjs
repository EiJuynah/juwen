/**
 * 探针：补正文改造后，「检索结果」里是否真的带上了页面正文。
 *
 * 不经过模型，直接调检索层：SEARCH_PROVIDER=deepseek + searchWeb(真实查询)，
 * 逐条打印 snippet 长度与开头，判断回灌给模型的资料是「只有标题」还是「有正文」。
 *
 * 跑法：node wb/probe-search-enrichment.mjs [查询词]
 */
import 'dotenv/config';
import { createSearchServiceFromEnv } from '../server/search/index.js';

const QUERY = process.argv[2] || '组织部门 统战部门 协作配合机制';
const svc = createSearchServiceFromEnv(process.env, (m) => console.log('  ' + m));

console.log(`\nprovider=${svc.describe().provider} configured=${svc.describe().configured}`);
console.log(`查询：${QUERY}\n`);

const t0 = Date.now();
const res = await svc.searchWeb(QUERY);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`ok=${res.ok} fetched=${res.fetched} filtered=${res.filtered} 采纳=${res.results.length} 耗时=${secs}s\n`);

let withText = 0;
res.results.forEach((r, i) => {
  const n = (r.snippet || '').length;
  if (n >= 40) withText++;
  console.log(`${i + 1}. [${n} 字] ${r.title}`);
  console.log(`     ${r.url}`);
  console.log(`     ${n ? r.snippet.replace(/\s+/g, ' ').slice(0, 150) + '…' : '(无正文)'}`);
});

console.log(`\n──── 结论 ────`);
console.log(`带正文（≥40 字）的结果：${withText}/${res.results.length}`);
console.log(withText > 0
  ? '✓ 回灌资料已带上页面正文，模型不必再说「只检索到标题」。'
  : '✗ 仍只有标题：检查 SEARCH_FETCH_PAGES 是否被关、页面是否可达。');
