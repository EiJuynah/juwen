/**
 * RTF 正文提取。
 *
 * 不依赖第三方库：RTF 是自描述的文本格式，按控制字逐层处理即可。
 * 需要处理的几类：
 *   \uNNNN?   Unicode 转义（后面常跟一个被忽略的替代字符）
 *   \'hh      单字节十六进制（按当前代码页，常见为 GBK/CP1252）
 *   \*        可忽略的目标组（如 {\*\generator ...}）
 *   \par     段结束
 *   {\ ... }  分组，需成对处理
 */

/**
 * 把累积的字节解码成字符串。
 *
 * 两种情况都要兜住：
 *   1. 正统 RTF：非 ASCII 走 \'hh 转义 + \ansicpg 指定代码页（中文多为 936）
 *   2. 部分生成器直接把 UTF-8 原始字节写进 RTF，此时未声明代码页（默认 1252）
 * 因此未显式声明代码页时，先试 UTF-8：能干净解码就用它，否则回退 CP1252。
 */
function decodeHexBytes(bytes, codepage) {
  const raw = Buffer.from(bytes);
  if (codepage === 936) {
    try { return new TextDecoder('gbk').decode(raw); } catch { /* 交给下面兜底 */ }
  }
  if (codepage === 950) {
    try { return new TextDecoder('big5').decode(raw); } catch { /* 交给下面兜底 */ }
  }
  // 未声明（1252）或解码失败：优先按 UTF-8，失败再按 CP1252
  if (codepage === 1252) {
    const asUtf8 = raw.toString('utf8');
    if (!asUtf8.includes('\uFFFD')) return asUtf8;
  }
  let out = '';
  for (const b of raw) {
    if (b >= 0x80 && b <= 0x9f) out += RTF_CP1252_HIGH[b] ?? String.fromCharCode(b);
    else out += String.fromCharCode(b);
  }
  return out;
}

/** CP1252 在 0x80-0x9F 的可打印映射 */
const RTF_CP1252_HIGH = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e',
  0x85: '\u2026', 0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6',
  0x89: '\u2030', 0x8a: '\u0160', 0x8b: '\u2039', 0x8c: '\u0152',
  0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201c',
  0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a',
  0x9c: '\u0153', 0x9e: '\u017e', 0x9f: '\u0178',
};

export function extractRtf(buf, { paragraphs = true } = {}) {
  const src = buf.toString('latin1'); // RTF 是 ASCII 主导，非 ASCII 走 \'hh 转义
  let out = '';
  let codepage = 1252;
  // 分组栈。注意 \* 出现在 { 之后，push 时无法预知该组是否可忽略，
  // 所以先建组对象，遇到 \* 再回填 skip 标记；否则忽略组结束后
  // skipDepth 永不归零，后面的正文会被整段吃掉。
  const groupStack = [];
  let skipDepth = 0;
  let i = 0;
  const hexBuf = [];

  while (i < src.length) {
    const ch = src[i];

    if (ch === '{') {
      groupStack.push({ skip: false });
      i++;
      continue;
    }
    if (ch === '}') {
      if (hexBuf.length) {
        if (skipDepth === 0) out += decodeHexBytes(hexBuf.splice(0), codepage);
        else hexBuf.length = 0;
      }
      const group = groupStack.pop();
      if (group?.skip) skipDepth = Math.max(0, skipDepth - 1);
      i++;
      continue;
    }

    if (ch === '\\') {
      const next = src[i + 1];
      // 转义的字面量 \{ \} \\
      if (next === '{' || next === '}' || next === '\\') {
        if (hexBuf.length) {
          if (skipDepth === 0) out += decodeHexBytes(hexBuf.splice(0), codepage);
          else hexBuf.length = 0;
        }
        if (skipDepth === 0) out += next;
        i += 2;
        continue;
      }
      // 十六进制字节 \'hh
      if (next === "'") {
        const hex = src.slice(i + 2, i + 4);
        const byte = parseInt(hex, 16);
        if (!Number.isNaN(byte)) {
          hexBuf.push(byte);
          // 连续 hex 攒够一批再按代码页整体解码，避免多字节字符被拆断
          const after = src.slice(i + 4);
          if (!/^\\'/.test(after)) {
            if (skipDepth === 0) out += decodeHexBytes(hexBuf.splice(0), codepage);
            else hexBuf.length = 0;
          }
          i += 4;
          continue;
        }
      }
      // \* 可忽略目标：标记当前所在组，使该组内容整体跳过
      if (next === '*') {
        if (groupStack.length) groupStack[groupStack.length - 1].skip = true;
        skipDepth++;
        i += 2;
        continue;
      }

      // 普通控制字：\letters[-]digits[ ]?
      const m = /^\\([a-zA-Z]+)(-?\d+)?[ ]?/.exec(src.slice(i));
      if (m) {
        const word = m[1];
        const num = m[2] !== undefined ? parseInt(m[2], 10) : null;
        i += m[0].length;

        // 控制字会打断字节流，先把攒着的字节解码落盘，
        // 否则「中文 + \par」会出现段落错位的乱序
        if (word !== 'u' && hexBuf.length) {
          if (skipDepth === 0) out += decodeHexBytes(hexBuf.splice(0), codepage);
          else hexBuf.length = 0;
        }

        if (skipDepth === 0) {
          if (word === 'par' || word === 'line') out += '\n';
          else if (word === 'tab') out += '\u3000';
          else if (word === 'cell') out += '\u3000';
          else if (word === 'u') {
            // \uNNNN 后跟一个被跳过的替代字符（可能是 '?' 或 \'hh）
            let v = num;
            if (v !== null && v < 0) v += 65536;
            if (v !== null) out += String.fromCharCode(v);
            const rest = src.slice(i);
            let consumed = 0;
            if (rest[0] === '?') consumed = 1;
            else {
              const h = /^\\'[0-9a-fA-F]{2}/.exec(rest);
              if (h) consumed = h[0].length;
            }
            i += consumed;
          } else if (word === 'ansicpg' && num !== null) {
            codepage = num;
          }
        }
        continue;
      }

      // 单独的 \ 后跟非字母（如 \~ 不换行空格）
      if (skipDepth === 0 && next === '~') out += '\u00a0';
      i += 2;
      continue;
    }

    if (ch === '\r' || ch === '\n') { i++; continue; } // RTF 源里的换行不算正文

    const code = src.charCodeAt(i);
    if (code >= 0x80) {
      // 原始高位字节（未转义）。有些生成器直接把 UTF-8 写进 RTF，
      // 与 \'hh 一样按字节流处理，交给 decodeHexBytes 统一判定编码
      if (skipDepth === 0) hexBuf.push(code & 0xff);
      i++;
      continue;
    }

    if (hexBuf.length) out += decodeHexBytes(hexBuf.splice(0), codepage);
    if (skipDepth === 0) out += ch;
    i++;
  }

  if (hexBuf.length) out += decodeHexBytes(hexBuf.splice(0), codepage);

  if (!paragraphs) return out;
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}
