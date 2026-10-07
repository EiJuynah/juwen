/**
 * Word 97-2003 二进制文档（.doc）正文提取。
 *
 * 适用：OLE2 容器内存在 WordDocument 流的文件 —— 包括
 * 真 .doc、以及「内容其实是 Word97 二进制」的 .wps / .wpt
 * （实测《中国共产党统一战线工作条例》的 .wps 就是这种）。
 *
 * 关键点：Word 97 的正文并不连续存放，必须按
 * FIB → CLX → PlcPcd 逐段还原，否则只能拿到第一段。
 */

const FIB_FC_CLX_OFF = 0x01a2;
const FIB_LCB_CLX_OFF = 0x01a6;
const FIB_FLAGS1_OFF = 0x000a;
const FIB_FLAG_WHICHTBLSTM = 0x0200;

/** 正文中不可见的结构字符，逐段清理时用 */
const PARAGRAPH_MARK = 0x000d;
const CELL_MARK = 0x0007;

/** CP1252 中 0x80-0x9F 区间的可打印字符（其余多为控制符） */
const CP1252_HIGH = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e',
  0x85: '\u2026', 0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6',
  0x89: '\u2030', 0x8a: '\u0160', 0x8b: '\u2039', 0x8c: '\u0152',
  0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201c',
  0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a',
  0x9c: '\u0153', 0x9e: '\u017e', 0x9f: '\u0178',
};

function decodeCompressed(bytes) {
  let out = '';
  for (const b of bytes) {
    if (b >= 0x80 && b <= 0x9f) out += CP1252_HIGH[b] ?? String.fromCharCode(b);
    else out += String.fromCharCode(b);
  }
  return out;
}

export function hasWordStream(ole) {
  return ole.hasStream('WordDocument');
}

/**
 * 从 OLE2 文件对象中提取 Word 正文。
 * @returns {string} 保留段落结束符（\r）的原始正文
 */
export function extractWord97(ole) {
  const wd = ole.readStream('WordDocument');
  if (!wd) throw new Error('缺少 WordDocument 流');

  const flags1 = wd.readUInt16LE(FIB_FLAGS1_OFF);
  let tableName = flags1 & FIB_FLAG_WHICHTBLSTM ? '1Table' : '0Table';
  if (!ole.hasStream(tableName)) {
    // 极少数文档标记与实际表流不一致，回退到存在的那个
    tableName = ole.hasStream('0Table') ? '0Table' : '1Table';
  }
  const table = ole.readStream(tableName);
  if (!table) throw new Error('缺少 FIB 表流（0Table/1Table）');

  const fcClx = wd.readUInt32LE(FIB_FC_CLX_OFF);
  const lcbClx = wd.readUInt32LE(FIB_LCB_CLX_OFF);
  const clx = table.subarray(fcClx, fcClx + lcbClx);

  // CLX = 若干 Prc(0x01) 后跟一个 Pcdt(0x02)
  let pos = 0;
  let plcPcd = null;
  while (pos < clx.length) {
    const clxt = clx[pos];
    if (clxt === 0x01) {
      const cb = clx.readInt16LE(pos + 1);
      pos += 3 + cb;
    } else if (clxt === 0x02) {
      const lcb = clx.readUInt32LE(pos + 1);
      plcPcd = clx.subarray(pos + 5, pos + 5 + lcb);
      break;
    } else {
      break;
    }
  }
  if (!plcPcd) throw new Error('CLX 中未找到 Pcdt，无法定位正文片段');

  // PlcPcd：(n+1) 个 CP + n 个 PCD（每个 8 字节）
  const n = Math.floor((plcPcd.length - 4) / 12);
  const cps = [];
  for (let i = 0; i <= n; i++) cps.push(plcPcd.readUInt32LE(i * 4));
  const pcdBase = 4 * (n + 1);

  const pieces = [];
  for (let i = 0; i < n; i++) {
    const fc = plcPcd.readUInt32LE(pcdBase + i * 8 + 2);
    const charCount = cps[i + 1] - cps[i];
    if (charCount <= 0) continue;
    if (fc & 0x40000000) {
      // 压缩片段：单字节编码，偏移需除以 2
      const offset = (fc & 0x3fffffff) >>> 1;
      pieces.push(decodeCompressed(wd.subarray(offset, offset + charCount)));
    } else {
      const offset = fc & 0x3fffffff;
      pieces.push(wd.subarray(offset, offset + charCount * 2).toString('utf16le'));
    }
  }

  return pieces.join('');
}

/**
 * 把 Word 原始正文切成段落。
 * 顺手剔除域代码、单元格标记等非正文结构，避免污染条款解析。
 */
export function splitWordParagraphs(raw) {
  const paragraphs = [];
  for (const chunk of raw.split('\r')) {
    // 段落结束符之外的残留控制字符
    let text = chunk
      .replace(/\u0007/g, '')      // 单元格/行结束
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/\u0013[\s\S]*?\u0014/g, '') // 域代码指令
      .replace(/[\u0013\u0014\u0015]/g, '')
      .replace(/\u00a0/g, ' ')
      .trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

export { CELL_MARK, PARAGRAPH_MARK };
