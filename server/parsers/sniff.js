/**
 * 文件格式嗅探。
 *
 * 核心原则：**只看文件内容（magic bytes），不信扩展名**。
 *
 * 原因就是本项目遇到的真实例子：《中国共产党统一战线工作条例》文件名是
 *   .wps，内容却是 Word 97 二进制（OLE2 + WordDocument 流）。
 * 而 WPS 现代版本另存的 .wps 又可能是 OOXML（zip）容器。
 * 同一扩展名对应完全不同的解析路径，靠扩展名必然出错。
 *
 * 反过来，Office 与 WPS 的格式是共用的：
 *   .docx / .wps(新)   → zip + word/document.xml
 *   .xlsx / .et        → zip + xl/workbook.xml
 *   .pptx / .dps       → zip + ppt/presentation.xml
 *   .doc / .wps(旧) / .wpt → OLE2 + WordDocument
 *   .xls / .et(旧)     → OLE2 + Workbook
 *   .ppt / .dps(旧)    → OLE2 + PowerPoint Document
 */

import { unzipSync } from 'fflate';
import { isOle2, Ole2File } from './ole2.js';

const PDF_SIG = Buffer.from('%PDF-');
const RTF_SIG = Buffer.from('{\\rtf');
const ZIP_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_SIG_EMPTY = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_SIG_SPANNED = Buffer.from([0x50, 0x4b, 0x07, 0x08]);

export const FORMAT = {
  OOXML_WORD: 'ooxml-word',
  OOXML_SHEET: 'ooxml-sheet',
  OOXML_SLIDE: 'ooxml-slide',
  OLE_WORD: 'ole-word',
  OLE_SHEET: 'ole-sheet',
  OLE_SLIDE: 'ole-slide',
  PDF: 'pdf',
  RTF: 'rtf',
  TEXT: 'text',
  UNKNOWN: 'unknown',
};

const startsWith = (buf, sig) => buf.length >= sig.length && buf.subarray(0, sig.length).equals(sig);

/** 各格式的人类可读名，用于回显给用户 */
export const FORMAT_LABEL = {
  [FORMAT.OOXML_WORD]: 'Word 文档（OOXML）',
  [FORMAT.OOXML_SHEET]: 'Excel 表格（OOXML）',
  [FORMAT.OOXML_SLIDE]: 'PPT 演示（OOXML）',
  [FORMAT.OLE_WORD]: 'Word 文档（97-2003 二进制）',
  [FORMAT.OLE_SHEET]: 'Excel 表格（97-2003 二进制）',
  [FORMAT.OLE_SLIDE]: 'PPT 演示（97-2003 二进制）',
  [FORMAT.PDF]: 'PDF 文档',
  [FORMAT.RTF]: 'RTF 文档',
  [FORMAT.TEXT]: '纯文本',
  [FORMAT.UNKNOWN]: '未知格式',
};

/** 该格式是否由本系统的解析器支持提取正文 */
export const PARSABLE = new Set([
  FORMAT.OOXML_WORD,
  FORMAT.OOXML_SHEET,
  FORMAT.OOXML_SLIDE,
  FORMAT.OLE_WORD,
  FORMAT.PDF,
  FORMAT.RTF,
  FORMAT.TEXT,
]);

/** 文本质量打分：可打印/中文占比越高越好，替换字符与控制符按缺陷计 */
function textScore(text) {
  if (!text.length) return 0;
  const bad = (text.match(/[\uFFFD\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length;
  const good = (text.match(/[\t\n\r\x20-\x7e\u00a0-\uffff]/g) || []).length;
  return good / text.length - (bad / text.length) * 3;
}

/**
 * 严格打分：只认可信的文字区间。
 *
 * 随机二进制按 UTF-16 解出来往往是私用区、稀有文字等乱码码位，
 * 用宽松的「可打印即算好」会大批误判成文本。
 * 这里只认常见的文字范围，超出范围一律计入可疑。
 */
const LIKELY_TEXT = /[\t\n\r\x20-\x7e\u00a0-\u024f\u2010-\u203a\u20ac\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

function textScoreStrict(text) {
  if (!text.length) return 0;
  let likely = 0;
  let suspicious = 0;
  for (const ch of text) {
    if (LIKELY_TEXT.test(ch)) likely++;
    else suspicious++;
  }
  return likely / text.length - (suspicious / text.length) * 2;
}

/**
 * 判断字节是否为文本，并给出编码。
 *
 * 不能用「含 NUL 即二进制」了事：UTF-16 的 ASCII 字符天然带 NUL。
 * 也不能只靠 NUL 分布猜 UTF-16 —— 中文在 UTF-16 里高位字节非零，
 * 一份纯中文的 UTF-16 文件几乎没有 NUL。
 * 因此改为对 UTF-8 / UTF-16LE / UTF-16BE 三种解码分别打分，取最优。
 *
 * @returns {'utf8'|'utf16le'|'utf16be'|null}
 */
function detectTextEncoding(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 16384));
  if (sample.length === 0) return null;

  // BOM 优先，直接定编码
  if (sample.length >= 2) {
    if (sample[0] === 0xff && sample[1] === 0xfe) return 'utf16le';
    if (sample[0] === 0xfe && sample[1] === 0xff) return 'utf16be';
  }
  // UTF-8 BOM
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return 'utf8';
  }

  const utf8Score = textScore(sample.toString('utf8'));
  // UTF-8 解得很干净，就不必再试 UTF-16
  if (utf8Score > 0.9 && !sample.includes(0x00)) return 'utf8';

  // 太短的数据判断不可靠（且 toString('utf16le') 会丢掉末尾奇数字节，
  // 让打分虚高），直接不做 UTF-16 猜测
  if (sample.length < 16) {
    return utf8Score > 0.9 ? 'utf8' : null;
  }

  // 只有 UTF-8 确实解不开（出现替换字符）时，才考虑 UTF-16
  const utf8HasReplacement = /\uFFFD/.test(sample.toString('utf8'));
  if (!utf8HasReplacement) {
    return utf8Score > 0.9 ? 'utf8' : null;
  }

  const even = sample.subarray(0, sample.length - (sample.length % 2));
  const candidates = [
    ['utf16le', textScoreStrict(even.toString('utf16le'))],
  ];
  const swapped = Buffer.from(even);
  swapped.swap16();
  candidates.push(['utf16be', textScoreStrict(swapped.toString('utf16le'))]);

  let best = null;
  let bestScore = 0;
  for (const [enc, score] of candidates) {
    if (score > bestScore) {
      bestScore = score;
      best = enc;
    }
  }

  // 严格阈值：解出来必须几乎全是常见文字，才认作 UTF-16 文本
  if (best && bestScore > 0.9) return best;
  return null;
}

/**
 * 列出 zip 内部条目名（只读中央目录，不解压内容，避免大文件全量解压）。
 */
export function listZipEntries(buf) {
  const names = [];
  // 从尾部找 End of Central Directory（可能带注释，向前最多扫 64KB + 22）
  const maxBack = Math.min(buf.length, 0xffff + 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return names;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length) break;
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.subarray(off + 46, off + 46 + nameLen).toString('utf8'));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * 嗅探文件格式。
 * @param {Buffer} buf 完整文件内容
 * @returns {{format:string, container:string, entries?:string[]}}
 */
export function detectFormat(buf) {
  if (startsWith(buf, PDF_SIG)) {
    return { format: FORMAT.PDF, container: 'pdf' };
  }
  if (startsWith(buf, RTF_SIG)) {
    return { format: FORMAT.RTF, container: 'rtf' };
  }

  const isZip = startsWith(buf, ZIP_SIG) || startsWith(buf, ZIP_SIG_EMPTY) || startsWith(buf, ZIP_SIG_SPANNED);
  if (isZip) {
    const entries = listZipEntries(buf);
    const set = new Set(entries);
    if (set.has('word/document.xml')) return { format: FORMAT.OOXML_WORD, container: 'zip', entries };
    if (set.has('xl/workbook.xml')) return { format: FORMAT.OOXML_SHEET, container: 'zip', entries };
    if (set.has('ppt/presentation.xml')) return { format: FORMAT.OOXML_SLIDE, container: 'zip', entries };
    // 有些工具产出的 docx 缺 workbook/presentation 判定特征，
    // 再按目录前缀兜一次
    if (entries.some((e) => e.startsWith('word/'))) return { format: FORMAT.OOXML_WORD, container: 'zip', entries };
    if (entries.some((e) => e.startsWith('xl/'))) return { format: FORMAT.OOXML_SHEET, container: 'zip', entries };
    if (entries.some((e) => e.startsWith('ppt/'))) return { format: FORMAT.OOXML_SLIDE, container: 'zip', entries };
    return { format: FORMAT.UNKNOWN, container: 'zip', entries };
  }

  if (isOle2(buf)) {
    let ole;
    try {
      ole = new Ole2File(buf);
    } catch {
      return { format: FORMAT.UNKNOWN, container: 'ole2' };
    }
    if (ole.hasStream('WordDocument')) return { format: FORMAT.OLE_WORD, container: 'ole2' };
    if (ole.hasStream('Workbook') || ole.hasStream('Book')) return { format: FORMAT.OLE_SHEET, container: 'ole2' };
    if (ole.hasStream('PowerPoint Document')) return { format: FORMAT.OLE_SLIDE, container: 'ole2' };
    return { format: FORMAT.UNKNOWN, container: 'ole2' };
  }

  const encoding = detectTextEncoding(buf);
  if (encoding) {
    return { format: FORMAT.TEXT, container: 'text', encoding };
  }
  return { format: FORMAT.UNKNOWN, container: 'binary' };
}

/** 解压 zip 中的单个条目（找不到返回 null） */
export function readZipEntry(buf, name) {
  let files;
  try {
    files = unzipSync(buf, { filter: (f) => f.name === name });
  } catch {
    return null;
  }
  const data = files[name];
  return data ? Buffer.from(data) : null;
}

/** 解压 zip 中匹配前缀的全部条目（按名称排序） */
export function readZipEntriesByPrefix(buf, prefix) {
  let files;
  try {
    files = unzipSync(buf, { filter: (f) => f.name.startsWith(prefix) && !f.name.endsWith('/') });
  } catch {
    return [];
  }
  return Object.keys(files)
    .sort()
    .map((name) => ({ name, data: Buffer.from(files[name]) }));
}
