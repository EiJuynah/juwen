/**
 * 结构化抽取测试：用真实《中国共产党统一战线工作条例》验证。
 *
 *   node scripts/policy-extract-test.mjs
 */
import fs from 'node:fs';
import { parseDocument } from '../server/parsers/index.js';
import { extractPolicy, findDuplicateIds, cnToNumber } from '../server/policy-extract.js';
import { resolveSampleDoc, skipSample } from './lib/sample-doc.mjs';

// 样本路径：JUWEN_SAMPLE > test-fixtures/ > 开发机原路径；都没有则跳过相关断言
const SAMPLE = resolveSampleDoc();

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n条文结构化抽取测试\n');

console.log('▸ 中文数字解析');
{
  check('十 → 10', cnToNumber('十') === 10);
  check('十一 → 11', cnToNumber('十一') === 11);
  check('二十三 → 23', cnToNumber('二十三') === 23);
  check('六十一 → 61', cnToNumber('六十一') === 61);
  check('十四 → 14', cnToNumber('十四') === 14);
  check('阿拉伯数字 15 → 15', cnToNumber('15') === 15);
}

console.log('\n▸ 真实样本：统一战线工作条例');
if (!SAMPLE) {
  skipSample('条文结构化抽取（真实条例）');
} else {
  const buf = fs.readFileSync(SAMPLE);
  const parsed = await parseDocument(buf);
  const policy = extractPolicy(parsed.paragraphs, { title: '中国共产党统一战线工作条例' });

  check('标题正确', policy.title === '中国共产党统一战线工作条例', policy.title);
  check('发布信息归入 meta', /2015年4月30日/.test(policy.meta), policy.meta.slice(0, 60));
  check('识别出 14 章', policy.stats.chapters === 14, `实际 ${policy.stats.chapters}`);
  check('识别出 61 条', policy.stats.articles === 61, `实际 ${policy.stats.articles}`);

  const sec1 = policy.sections[0];
  check('第 1 章为总则', sec1.heading.includes('总则'), sec1.heading);
  check('第 1 章 id 为 P-1', sec1.id === 'P-1', sec1.id);
  // 第一章 总则 = 第一条~第五条，共 5 条（第二章从第六条起，可与总数 61 交叉验证）
  check('第 1 章 5 条', sec1.clauses.length === 5, `实际 ${sec1.clauses.length}`);
  check('第 2 章起始为 P-2-1 且对应第六条', policy.sections[1].clauses[0].text.startsWith('第六条'), policy.sections[1].clauses[0].text.slice(0, 12));
  check('第 1 章第 1 条 id 为 P-1-1', sec1.clauses[0].id === 'P-1-1', sec1.clauses[0].id);
  check('第 1 条含条号正文', sec1.clauses[0].text.startsWith('第一条'), sec1.clauses[0].text.slice(0, 24));

  const last = policy.sections.at(-1);
  check('最后一章为附则', last.heading.includes('附则'), last.heading);
  check('两章均为「附则」且分属 13/14', policy.sections[12].heading.includes('保障和监督'), policy.sections[12].heading);
  check('最后一章 2 条', last.clauses.length === 2, `实际 ${last.clauses.length}`);
  check('末条为第六十一条', last.clauses.at(-1).text.startsWith('第六十一条'), last.clauses.at(-1).text.slice(0, 20));

  check('无重复 pid', findDuplicateIds(policy).length === 0, findDuplicateIds(policy).join(', '));

  // 所有 pid 必须唯一且形如 P-x-y
  const ids = policy.sections.flatMap((s) => s.clauses.map((c) => c.id));
  check('全部 pid 形如 P-x-y', ids.every((id) => /^P-\d+-\d+$/.test(id)), ids.find((id) => !/^P-\d+-\d+$/.test(id)) ?? '');
  check('pid 数量与条数一致', ids.length === policy.stats.articles);

  // 跨段续接：第二条由两段组成，应合并进同一条
  const c2 = policy.sections[0].clauses[1];
  check('跨段内容合并进同一条', c2.text.includes('统一战线是中国共产党凝聚人心'), c2.text.slice(0, 40) + '…');

  console.log('\n  ── 结构预览 ──');
  for (const sec of policy.sections) {
    console.log(`  ${sec.heading}  (${sec.clauses.length} 条, ${sec.clauses[0].id} ~ ${sec.clauses.at(-1).id})`);
  }
  console.log(`\n  合计 ${policy.stats.chapters} 章 / ${policy.stats.articles} 条 / ${policy.stats.chars} 字`);
}

console.log('\n▸ 无「章」结构的简式文档');
{
  const paras = [
    { text: '某某管理办法' },
    { text: '第一条 为规范管理，制定本办法。' },
    { text: '第二条 本办法适用于本单位。' },
    { text: '（一）第一项要求。' },
  ];
  const policy = extractPolicy(paras);
  check('无章时兜底为「全文」分组', policy.sections.length === 1 && policy.sections[0].heading === '全文', JSON.stringify(policy.sections.map((s) => s.heading)));
  // 已有「第X条」体例时，「（一）」属于上一条的子项，应并入而不是另立条款
  check('子项并入上一条而非独立成条', policy.sections[0].clauses.length === 2, `实际 ${policy.sections[0].clauses.length}`);
  check('子项内容未丢失', policy.sections[0].clauses[1].text.includes('第一项要求'), policy.sections[0].clauses[1].text);
  check('pid 无 -0 残留', policy.sections[0].clauses.every((c) => !c.id.endsWith('-0')), JSON.stringify(policy.sections[0].clauses.map((c) => c.id)));
}

console.log('\n▸ 仅「一、二、」体例的文档（无第X条）');
{
  const paras = [
    { text: '某某实施细则' },
    { text: '一、明确总体要求。' },
    { text: '二、细化落实举措。' },
    { text: '三、强化组织保障。' },
  ];
  const policy = extractPolicy(paras);
  const clauses = policy.sections.flatMap((s) => s.clauses);
  check('按「一、」切出 3 条', clauses.length === 3, `实际 ${clauses.length}`);
  check('pid 连续无跳号', clauses.every((c, idx) => c.id === `P-1-${idx + 1}`), JSON.stringify(clauses.map((c) => c.id)));
}

console.log('\n▸ 完全无编号的文档（兜底）');
{
  const paras = [{ text: '某通知' }, { text: '第一段内容。' }, { text: '第二段内容。' }];
  const policy = extractPolicy(paras);
  check('仍能产出条款', policy.sections[0]?.clauses.length > 0, JSON.stringify(policy.sections));
  check('无重复 pid', findDuplicateIds(policy).length === 0);
}

console.log('\n▸ 空输入');
{
  const policy = extractPolicy([]);
  check('空输入不抛错', policy.sections.length === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
