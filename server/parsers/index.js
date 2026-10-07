/**
 * 文档解析统一入口。
 *
 * 输入文件字节，输出统一的段落列表：
 *   [{ text, heading?, table?, sheetHeader?, slideHeader? }]
 *
 * 路由完全由 sniff 按文件内容决定，不看扩展名。
 */

import {
  detectFormat,
  FORMAT,
  FORMAT_LABEL,
  PARSABLE,
} from './sniff.js';
import { Ole2File, isOle2 } from './ole2.js';
import { extractWord97, splitWordParagraphs } from './word97.js';
import { parseWordOoxml, parseSheetOoxml, parseSlideOoxml } from './ooxml.js';
import { extractRtf } from './rtf.js';

export { FORMAT, FORMAT_LABEL, detectFormat };
export { isOle2, Ole2File };

/** PDF 由可选依赖提供；未安装时给出明确的降级说明而不是崩溃 */
let pdfModulePromise = null;
async function loadPdf() {
  if (!pdfModulePromise) {
    pdfModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
  }
  return pdfModulePromise;
}

async function parsePdf(buf) {
  const pdfjs = await loadPdf();
  if (!pdfjs) {
    throw new Error('PDF 解析需要 pdfjs-dist，请先安装依赖');
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    // Node 环境无需 worker，禁用后走主线程解析
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const out = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    // 按 y 坐标聚行：同一行的文本片段拼起来，避免逐 fragment 断句
    let lastY = null;
    let line = '';
    const lines = [];
    for (const item of content.items) {
      const str = item.str ?? '';
      const y = item.transform?.[5];
      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
        if (line.trim()) lines.push(line.trim());
        line = '';
      }
      line += str;
      if (item.hasEOL) {
        if (line.trim()) lines.push(line.trim());
        line = '';
      }
      lastY = y ?? lastY;
    }
    if (line.trim()) lines.push(line.trim());
    for (const text of lines) out.push({ text });
    await page.cleanup();
  }
  await doc.destroy();
  return out;
}

function parseText(buf, encoding = 'utf8') {
  let text;
  switch (encoding) {
    case 'utf16le':
      text = buf.toString('utf16le');
      break;
    case 'utf16be': {
      const swapped = Buffer.from(buf);
      swapped.swap16();
      text = swapped.toString('utf16le');
      break;
    }
    default:
      text = buf.toString('utf8');
  }

  // 去掉 BOM（U+FEFF）
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  return text
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((t) => ({ text: t }));
}

/**
 * 主入口。
 * @param {Buffer} buf 文件字节
 * @returns {Promise<{format:string, formatLabel:string, paragraphs:Array, supported:boolean}>}
 */
export async function parseDocument(buf) {
  const detected = detectFormat(buf);
  const format = detected.format;

  if (!PARSABLE.has(format)) {
    const extra =
      format === FORMAT.OLE_SHEET
        ? '（老式 .xls / .et 二进制表格暂不支持，请另存为 .xlsx 后上传）'
        : format === FORMAT.OLE_SLIDE
          ? '（老式 .ppt / .dps 二进制演示暂不支持，请另存为 .pptx 后上传）'
          : '（未能识别文件内容，请确认文件未损坏、未加密）';
    return {
      format,
      formatLabel: FORMAT_LABEL[format] ?? format,
      paragraphs: [],
      supported: false,
      reason: `不支持的文件格式：${FORMAT_LABEL[format] ?? format}${extra}`,
    };
  }

  let paragraphs;
  switch (format) {
    case FORMAT.OLE_WORD: {
      const ole = new Ole2File(buf);
      paragraphs = splitWordParagraphs(extractWord97(ole)).map((t) => ({ text: t }));
      break;
    }
    case FORMAT.OOXML_WORD:
      paragraphs = parseWordOoxml(buf);
      break;
    case FORMAT.OOXML_SHEET:
      paragraphs = parseSheetOoxml(buf);
      break;
    case FORMAT.OOXML_SLIDE:
      paragraphs = parseSlideOoxml(buf);
      break;
    case FORMAT.RTF:
      paragraphs = extractRtf(buf).map((t) => ({ text: t }));
      break;
    case FORMAT.PDF:
      paragraphs = await parsePdf(buf);
      break;
    case FORMAT.TEXT:
    default:
      paragraphs = parseText(buf, detected.encoding);
      break;
  }

  return {
    format,
    formatLabel: FORMAT_LABEL[format] ?? format,
    paragraphs,
    supported: true,
  };
}
