/**
 * OOXML（zip 容器）文档解析。
 * 一套代码覆盖 Office 与 WPS 的同族格式：
 *   word/document.xml → .docx / .wps(新)
 *   xl/workbook.xml   → .xlsx / .et
 *   ppt/presentation.xml → .pptx / .dps
 */

import { XMLParser } from 'fast-xml-parser';
import { readZipEntry, readZipEntriesByPrefix } from './sniff.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // 去掉命名空间前缀，让 w:p / a:p 都变成 p，简化遍历
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) =>
    ['p', 'tbl', 'tr', 'tc', 'r', 't', 'si', 'sld', 'sp', 'c', 'row', 'br', 'tab'].includes(name),
});

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** 按文档顺序把所有文本节点拼起来 */
function extractText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  let out = '';
  for (const [key, val] of Object.entries(node)) {
    if (key === 't') out += extractText(val);
    else if (key === 'tab') out += '\u3000';
    else if (key === 'br' || key === 'cr') out += ' ';
    else if (key.startsWith('@_') || key === '#text' || key === 'v') continue;
    else out += extractText(val);
  }
  return out;
}

/**
 * 从 w:pStyle 推标题级别。
 * Word 用 "1".."9" 或 "Heading1"，WPS 可能用 "a3"、中文名等，一并兼容。
 */
function headingLevel(pNode) {
  const pPr = pNode?.pPr;
  if (!pPr) return 0;
  const style = pPr.pStyle;
  const raw = toArray(style)[0]?.['@_val'] ?? '';
  if (!raw) return 0;
  const s = String(raw).toLowerCase();
  let m = s.match(/^heading\s*([1-9])$/) || s.match(/^h([1-9])$/) || s.match(/^([1-9])$/);
  if (m) return Number(m[1]);
  m = s.match(/^a([1-9])$/);           // WPS 常用 a1/a2/a3 映射 标题1/2/3
  if (m) return Number(m[1]);
  // 中文样式名：标题 1 / 一级标题
  m = String(raw).match(/标题\s*([1-9])/) || String(raw).match(/([一二三四五六七八九])级标题/);
  if (m) {
    const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    return cn[m[1]] ?? Number(m[1]) ?? 0;
  }
  return 0;
}

/**
 * 遍历 docx body，同时支持顶层段落与表格内段落。
 * 表格按行输出，单元格之间用全角空格分隔，便于后续条文抽取。
 */
function walkWordNode(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkWordNode(item, out);
    return;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key === 'p') {
      for (const p of toArray(val)) {
        const text = extractText(p).trim();
        if (!text) continue;
        out.push({ text, heading: headingLevel(p) });
      }
    } else if (key === 'tbl') {
      for (const tbl of toArray(val)) {
        for (const tr of toArray(tbl.tr)) {
          const cells = toArray(tr.tc).map((tc) => extractText(tc).trim());
          const line = cells.filter(Boolean).join('\u3000');
          if (line) out.push({ text: line, table: true });
        }
      }
    } else if (key.startsWith('@_') || key === '#text') {
      continue;
    } else {
      walkWordNode(val, out);
    }
  }
}

/** .docx / .wps(新) → 段落列表 */
export function parseWordOoxml(buf) {
  const doc = readZipEntry(buf, 'word/document.xml');
  if (!doc) throw new Error('未找到 word/document.xml');
  const xml = parser.parse(doc.toString('utf8'));
  const body = xml?.document?.body ?? xml?.body;
  if (!body) throw new Error('文档结构异常：缺少 body');
  const out = [];
  walkWordNode(body, out);
  return out;
}

/** 读取 xl/sharedStrings.xml，得到共享字符串数组 */
function readSharedStrings(buf) {
  const entry = readZipEntry(buf, 'xl/sharedStrings.xml');
  if (!entry) return [];
  const xml = parser.parse(entry.toString('utf8'));
  const items = toArray(xml?.sst?.si);
  return items.map((si) => extractText(si).trim());
}

/** 读取工作表名（按 sheetId/rId 顺序尽量对齐） */
function readSheetNames(buf) {
  const entry = readZipEntry(buf, 'xl/workbook.xml');
  if (!entry) return [];
  try {
    const xml = parser.parse(entry.toString('utf8'));
    return toArray(xml?.workbook?.sheets?.sheet).map(
      (s) => s?.['@_name'] ?? '',
    );
  } catch {
    return [];
  }
}

/** .xlsx / .et → 按行输出单元格文本 */
export function parseSheetOoxml(buf) {
  const sheets = readZipEntriesByPrefix(buf, 'xl/worksheets/').filter((f) =>
    /sheet\d*\.xml$/.test(f.name),
  );
  if (sheets.length === 0) throw new Error('未找到工作表 XML');

  const shared = readSharedStrings(buf);
  const names = readSheetNames(buf);
  const out = [];

  sheets.forEach((sheet, idx) => {
    const label = names[idx] || `工作表 ${idx + 1}`;
    out.push({ text: `【${label}】`, heading: 1, sheetHeader: true });

    let xml;
    try {
      xml = parser.parse(sheet.data.toString('utf8'));
    } catch {
      return;
    }
    const rows = toArray(xml?.worksheet?.sheetData?.row);
    for (const row of rows) {
      const values = toArray(row.c).map((cell) => {
        const type = cell['@_t'];
        if (type === 's') {
          const i = Number(extractText(cell.v));
          return shared[i] ?? '';
        }
        if (type === 'inlineStr') return extractText(cell.is).trim();
        return extractText(cell.v).trim();
      });
      const line = values.join('\u3000').replace(/[\u3000\s]+$/, '');
      if (line.trim()) out.push({ text: line, table: true });
    }
  });

  return out;
}

/** .pptx / .dps → 按页输出文本 */
export function parseSlideOoxml(buf) {
  const slides = readZipEntriesByPrefix(buf, 'ppt/slides/').filter((f) =>
    /slide\d+\.xml$/.test(f.name),
  );
  if (slides.length === 0) throw new Error('未找到幻灯片 XML');

  // 按 slide 序号排序，避免 slide10 排在 slide2 前面
  slides.sort((a, b) => {
    const na = Number((a.name.match(/slide(\d+)\.xml/) || [])[1] || 0);
    const nb = Number((b.name.match(/slide(\d+)\.xml/) || [])[1] || 0);
    return na - nb;
  });

  const out = [];
  slides.forEach((slide, idx) => {
    out.push({ text: `【第 ${idx + 1} 页】`, heading: 1, slideHeader: true });
    let xml;
    try {
      xml = parser.parse(slide.data.toString('utf8'));
    } catch {
      return;
    }
    // a:p 为段落，a:t 为文本片段
    const paragraphs = [];
    const collect = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(collect);
        return;
      }
      for (const [key, val] of Object.entries(node)) {
        if (key === 'p') {
          for (const p of toArray(val)) {
            const text = extractText(p).trim();
            if (text) paragraphs.push(text);
          }
        } else if (key.startsWith('@_') || key === '#text') {
          continue;
        } else {
          collect(val);
        }
      }
    };
    collect(xml);
    for (const text of paragraphs) out.push({ text });
  });

  return out;
}
