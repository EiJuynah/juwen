/**
 * 多格式解析器测试。
 *
 * 覆盖：格式嗅探、OOXML(word/sheet/slide)、RTF、纯文本、UTF-16 txt，
 * 以及真实样本《中国共产党统一战线工作条例》(.wps → Word97 二进制)。
 *
 *   node scripts/parser-test.mjs
 */
import fs from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { parseDocument, detectFormat, FORMAT } from '../server/parsers/index.js';
import { resolveSampleDoc, skipSample } from './lib/sample-doc.mjs';

// 样本路径：JUWEN_SAMPLE > test-fixtures/ > 开发机原路径；都没有则跳过相关断言
const SAMPLE = resolveSampleDoc();

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** 造一个最小 docx：只需 word/document.xml，解析器就能工作 */
function buildDocx(bodyXml) {
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyXml}</w:body></w:document>`;
  return Buffer.from(
    zipSync({
      'word/document.xml': strToU8(document),
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    }),
  );
}

const p = (text, style) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;

console.log('\n多格式解析器测试\n');

console.log('▸ 格式嗅探');
{
  const docx = buildDocx(p('测试'));
  check('docx → ooxml-word', detectFormat(docx).format === FORMAT.OOXML_WORD);

  const xlsx = Buffer.from(zipSync({
    'xl/workbook.xml': strToU8('<workbook/>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet/>'),
  }));
  check('xlsx → ooxml-sheet', detectFormat(xlsx).format === FORMAT.OOXML_SHEET);

  const pptx = Buffer.from(zipSync({ 'ppt/presentation.xml': strToU8('<p/>') }));
  check('pptx → ooxml-slide', detectFormat(pptx).format === FORMAT.OOXML_SLIDE);

  check('PDF → pdf', detectFormat(Buffer.from('%PDF-1.7\n...')).format === FORMAT.PDF);
  check('RTF → rtf', detectFormat(Buffer.from('{\\rtf1\\ansi test}')).format === FORMAT.RTF);
  check('纯文本 → text', detectFormat(Buffer.from('第一条 这是一段中文。')).format === FORMAT.TEXT);
  check('随机二进制 → unknown', detectFormat(Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00])).format === FORMAT.UNKNOWN);
}

console.log('\n▸ Word OOXML（含标题与表格）');
{
  const body =
    p('中国共产党统一战线工作条例', 'Heading1') +
    p('第一章　总则', '1') +
    p('第一条　为了加强党对统一战线工作的集中统一领导，制定本条例。') +
    p('第二条　本条例所称统一战线，是指中国共产党领导的……') +
    '<w:tbl><w:tr><w:tc>' + p('姓名') + '</w:tc><w:tc>' + p('职务') + '</w:tc></w:tr></w:tbl>';
  const doc = await parseDocument(buildDocx(body));
  check('解析成功', doc.supported && doc.paragraphs.length >= 4, `段落 ${doc.paragraphs.length}`);
  check('标题级别被识别', doc.paragraphs[0].heading === 1, `heading=${doc.paragraphs[0].heading}`);
  check('「第一章」样式 1 识别为 heading', doc.paragraphs[1].heading === 1, `heading=${doc.paragraphs[1].heading}`);
  check('正文段落无 heading', !doc.paragraphs[2].heading);
  check('表格行被提取', doc.paragraphs.some((x) => x.table && x.text.includes('姓名')), JSON.stringify(doc.paragraphs.at(-1)));
  check('中文内容无损', doc.paragraphs[2].text.includes('加强党对统一战线工作的集中统一领导'));
}

console.log('\n▸ Excel OOXML（共享字符串）');
{
  const xlsx = Buffer.from(zipSync({
    'xl/workbook.xml': strToU8(
      '<workbook xmlns:r="x"><sheets><sheet name="界别" sheetId="1"/></sheets></workbook>',
    ),
    'xl/sharedStrings.xml': strToU8(
      '<sst><si><t>姓名</t></si><si><t>界别</t></si><si><t>张三</t></si></sst>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="inlineStr"><is><t>教育界</t></is></c></row></sheetData></worksheet>',
    ),
  }));
  const doc = await parseDocument(xlsx);
  check('解析成功', doc.supported, doc.reason || '');
  check('工作表名被带出', doc.paragraphs[0].text.includes('界别'), doc.paragraphs[0].text);
  // 第 1 行是表头，第 2 行才是数据，逐行核对
  check('第 1 行（表头）解析正确', doc.paragraphs[1].text.includes('姓名') && doc.paragraphs[1].text.includes('界别'), doc.paragraphs[1].text);
  check('第 2 行共享字符串解析正确', doc.paragraphs[2].text.includes('张三'), doc.paragraphs[2].text);
  check('第 2 行 inlineStr 解析正确', doc.paragraphs[2].text.includes('教育界'), doc.paragraphs[2].text);
}

console.log('\n▸ PPT OOXML');
{
  const pptx = Buffer.from(zipSync({
    'ppt/presentation.xml': strToU8('<p/>'),
    'ppt/slides/slide1.xml': strToU8('<sld><a:p><a:t>封面标题</a:t></a:p></sld>'),
    'ppt/slides/slide2.xml': strToU8('<sld><a:p><a:t>第二页正文</a:t></a:p></sld>'),
  }));
  const doc = await parseDocument(pptx);
  check('解析成功', doc.supported, doc.reason || '');
  check('含页码标记', doc.paragraphs.some((x) => x.text.includes('第 1 页')), JSON.stringify(doc.paragraphs.map(x=>x.text)));
  check('第 2 页文本被提取', doc.paragraphs.some((x) => x.text.includes('第二页正文')));
}

console.log('\n▸ RTF');
{
  // ① 正统 RTF：非 ASCII 走 \'hh 转义 + \ansicpg936（GBK）
  // Node 的 Buffer 不支持 gbk，这里直接写 GBK 字节（每个 \'hh 只吃 2 位十六进制）：
  //   第一条 = B5 DA D2 BB CC F5    为了加强党的工作。 = CE AA C1 CB BC D3 C7 BF B5 C3 B5 C4 B9 A4 D7 F7 A1 A3
  const gbkHex = [
    'b5', 'da', 'd2', 'bb', 'cc', 'f5', '20',
    'ce', 'aa', 'c1', 'cb', 'bc', 'd3', 'c7', 'bf',
    'b5', 'b3', 'b5', 'c4', 'b9', 'a4', 'd7', 'f7', 'a1', 'a3',
  ];
  const escaped = gbkHex.map((h) => `\\'${h}`).join('');
  const rtf = Buffer.from(
    `{\\rtf1\\ansi\\ansicpg936 ${escaped}\\par ${escaped}\\par}`,
    'latin1',
  );
  const doc = await parseDocument(rtf);
  check('GBK 转义版解析成功', doc.supported, doc.reason || '');
  check('\\par 正确切成两段', doc.paragraphs.length === 2, `实际 ${doc.paragraphs.length}`);
  check('GBK 中文正确还原', doc.paragraphs[0].text.includes('为了加强党的工作'), doc.paragraphs[0].text);

  // ② 部分生成器直接写 UTF-8 原始字节（未声明代码页）
  const utf8Rtf = Buffer.from('{\\rtf1\\ansi 第一条 直接内嵌中文。\\par}', 'utf8');
  const d2 = await parseDocument(utf8Rtf);
  check('UTF-8 直出版也能解析', d2.supported && !!d2.paragraphs[0]?.text.includes('直接内嵌中文'), JSON.stringify(d2.paragraphs[0]?.text));

  // ③ 可忽略目标组不应混入正文
  const withGen = Buffer.from('{\\rtf1\\ansi{\\*\\generator WPS}正文内容。\\par}', 'latin1');
  const d3 = await parseDocument(withGen);
  check('忽略 \\* 目标组', !d3.paragraphs[0].text.includes('WPS'), d3.paragraphs[0]?.text);
}

console.log('\n▸ 纯文本（UTF-8 / UTF-16 LE）');
{
  const utf8 = Buffer.from('第一条 测试内容。\n第二条 第二段。', 'utf8');
  const d1 = await parseDocument(utf8);
  check('UTF-8 两段', d1.paragraphs.length === 2, `实际 ${d1.paragraphs.length}`);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第一条 宽字符测试。', 'utf16le')]);
  const d2 = await parseDocument(utf16);
  check('UTF-16LE 被识别为文本（非二进制）', d2.supported, d2.reason || `format=${d2.format}`);
  check('UTF-16LE 正确解码', d2.paragraphs[0]?.text.includes('宽字符测试'), JSON.stringify(d2.paragraphs[0]?.text));
  check('UTF-16LE 未残留 BOM', !d2.paragraphs[0]?.text.includes('\ufeff'), JSON.stringify(d2.paragraphs[0]?.text));

  // 无 BOM 的 UTF-16LE：靠 NUL 分布判断
  const utf16NoBom = Buffer.from('第一条 无BOM宽字符。', 'utf16le');
  const d3 = await parseDocument(utf16NoBom);
  check('无 BOM 的 UTF-16LE 也被识别', d3.supported, `format=${d3.format}`);
}

console.log('\n▸ 真实样本：条例 .wps（Word97 二进制）');
if (!SAMPLE) {
  skipSample('条例 .wps 解析（Word97 二进制）');
} else {
  const buf = fs.readFileSync(SAMPLE);
  const detected = detectFormat(buf);
  check('嗅探为 ole-word（而非按扩展名误判）', detected.format === FORMAT.OLE_WORD, detected.format);

  const doc = await parseDocument(buf);
  check('解析成功', doc.supported, doc.reason || '');
  check('段落数 172', doc.paragraphs.length === 172, `实际 ${doc.paragraphs.length}`);
  check('首段为标题', doc.paragraphs[0].text === '中国共产党统一战线工作条例', doc.paragraphs[0].text);
  check('含「第一章」', doc.paragraphs.some((x) => x.text.startsWith('第一章')));
  check('含「第六十一条」', doc.paragraphs.some((x) => x.text.startsWith('第六十一条')));
  check('含「第十四章」', doc.paragraphs.some((x) => x.text.startsWith('第十四章')));
  const joined = doc.paragraphs.map((x) => x.text).join('');
  check('正文长度约 11k 字符', joined.length > 10000, `实际 ${joined.length}`);
}

console.log('\n▸ 不支持格式的降级提示');
{
  const fakeXls = Buffer.from(
    zipSync({ 'xl/workbook.xml': strToU8('<w/>') }),
  );
  const garbled = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.from('Workbook'.split('').join('\u0000'), 'utf16le'),
    Buffer.alloc(600, 0),
  ]);
  const d = await parseDocument(garbled);
  check('老式 .xls 返回不支持而非抛错', d.supported === false, `supported=${d.supported}`);
  check('给出可操作的原因', typeof d.reason === 'string' && d.reason.length > 0, d.reason);
  void fakeXls;
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
