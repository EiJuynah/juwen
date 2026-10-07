/**
 * 政策条文结构化抽取。
 *
 * 把解析出的段落列表，整理成「章 → 条」两级结构，并为每条分配稳定 pid。
 * pid 是 AI 引用溯源（[P-x-y]）的基础，一旦发布不可重排 ——
 * 所以这里只按文档内固有编号（第X章／第X条）推导，不依赖段落数组下标，
 * 避免重新解析同一份文档时 pid 漂移、历史批注全部指错位置。
 */

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字 → 整数（支持「十」「十一」「二十三」「一百零五」等） */
export function cnToNumber(s) {
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let section = 0;
  let digit = 0;
  let hasAny = false;
  for (const ch of s) {
    if (ch === '百') { section += (digit || 1) * 100; digit = 0; hasAny = true; }
    else if (ch === '十') { section += (digit || 1) * 10; digit = 0; hasAny = true; }
    else if (ch in CN_DIGITS) { digit = CN_DIGITS[ch]; hasAny = true; }
    else return 0;
  }
  total = section + digit;
  return hasAny ? total : 0;
}

// 章标题：第X章、第X编、第X部分（均视作分组层）
const SECTION_RE = /^第\s*([一二三四五六七八九十百零\d]+)\s*(章|编|部分)\s*[\u3000\s]*(.*)$/;
// 条标题：第X条（后面可能紧跟正文，也可能只有编号）
const ARTICLE_RE = /^第\s*([一二三四五六七八九十百零\d]+)\s*条\s*[\u3000\s]*(.*)$/;
// 「一、」「（一）」式层级：无「第X条」体例的文档退化为按此切分
const ITEM_RE = /^([一二三四五六七八九十]+)\s*[、．.]\s*(.*)$/;

/**
 * 从段落列表抽取结构化政策。
 *
 * @param {Array<{text:string, heading?:number}>} paragraphs
 * @param {{title?:string}} [options]
 * @returns {{title:string, meta:string, sections:Array, stats:object}}
 */
export function extractPolicy(paragraphs, options = {}) {
  const lines = paragraphs.map((p) => ({ ...p, text: (p.text ?? '').trim() })).filter((p) => p.text);

  if (lines.length === 0) {
    return { title: options.title || '未命名文档', meta: '', sections: [], stats: { chapters: 0, articles: 0, chars: 0 } };
  }

  // 标题：优先用调用方给的（文件名常常比正文标题更准），否则取首段
  let title = options.title || '';
  let bodyStart = 0;
  if (!title) {
    const firstHeading = lines.findIndex((l) => l.heading === 1);
    if (firstHeading >= 0 && firstHeading <= 2) {
      title = lines[firstHeading].text;
      bodyStart = firstHeading + 1;
    } else {
      title = lines[0].text;
      bodyStart = 1;
    }
  } else {
    // 传了标题也要把正文里那行标题跳过，否则它会被当成一个无编号段落，
    // 多算出一章/一条，并污染第一个分组的归属
    const idx = lines.findIndex((l) => l.text === title || l.heading === 1);
    bodyStart = idx >= 0 ? idx + 1 : 0;
  }

  // 发布信息 / 来源等：紧跟在标题后的括号段与发布行，归入 meta。
  // 注意不能写成 /中共中央(发布|修订)/ —— 实际文本常是
  // 「中共中央政治局会议修订」，动词前还夹着机构名，必须分开判断。
  const isMetaLine = (t) =>
    /^[（(]/.test(t) ||
    /^来源[:：]/.test(t) ||
    /^\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/.test(t) ||
    (/中共中央/.test(t) && /(发布|修订|批准|审议|印发)/.test(t));

  const metaLines = [];
  let i = bodyStart;
  // 上限 8 行：异常文档不能靠 meta 把整个正文吞掉
  while (i < lines.length && metaLines.length < 8) {
    const t = lines[i].text;
    if (SECTION_RE.test(t) || ARTICLE_RE.test(t)) break;
    if (!isMetaLine(t)) break;
    metaLines.push(t);
    i++;
  }
  const meta = metaLines.join(' ');

  // 是否有「第X条」体例
  const hasArticleStyle = lines.some((l) => ARTICLE_RE.test(l.text));

  const sections = [];
  let current = null;
  let chapterNo = 0;
  let articleNo = 0;
  let unnumbered = 0;

  const ensureSection = () => {
    if (current) return current;
    // 没有章结构的文档，兜底建一个「全文」分组
    chapterNo += 1;
    current = { id: `P-${chapterNo}`, heading: chapterNo === 1 ? '全文' : `第${chapterNo}部分`, clauses: [] };
    sections.push(current);
    return current;
  };

  const pushClause = (id, text) => {
    const sec = ensureSection();
    sec.clauses.push({ id, text });
  };

  for (; i < lines.length; i++) {
    const raw = lines[i].text;

    const secMatch = SECTION_RE.exec(raw);
    if (secMatch) {
      const no = cnToNumber(secMatch[1]) || chapterNo + 1;
      chapterNo = no;
      articleNo = 0;
      const heading = raw;
      current = { id: `P-${no}`, heading, clauses: [] };
      sections.push(current);
      continue;
    }

    const artMatch = ARTICLE_RE.exec(raw);
    if (artMatch) {
      articleNo += 1;
      const sec = ensureSection();
      const id = `P-${chapterNo}-${articleNo}`;
      sec.clauses.push({ id, text: raw });
      continue;
    }

    const itemMatch = hasArticleStyle ? null : ITEM_RE.exec(raw);
    if (itemMatch) {
      unnumbered += 1;
      const sec = ensureSection();
      sec.clauses.push({ id: `P-${chapterNo}-${unnumbered}`, text: raw });
      continue;
    }

    // 既不是章也不是条：视为上一条的续段（条例里很常见，一条跨多段）
    const sec = current;
    const last = sec?.clauses?.[sec.clauses.length - 1];
    if (last) {
      // 无标点的行直接续接，有标点的补一个空格，避免把句子粘死
      last.text += /[。；：、，）)]$/.test(last.text) ? raw : ` ${raw}`;
    } else {
      // 文档开头的说明性段落（无条号）
      unnumbered += 1;
      pushClause(`P-${chapterNo || 1}-0`, raw);
    }
  }

  // 无「第X条」体例时，clauses 的 id 需要重排为连续序号，避免出现 -0
  if (!hasArticleStyle) {
    let n = 0;
    for (const sec of sections) {
      for (const cl of sec.clauses) {
        n += 1;
        cl.id = `P-${sec.id.slice(2)}-${n}`;
      }
    }
  }

  const articles = sections.reduce((acc, s) => acc + s.clauses.length, 0);
  const chars = sections.reduce(
    (acc, s) => acc + s.clauses.reduce((a, c) => a + c.text.length, 0),
    0,
  );

  return {
    title,
    meta,
    sections,
    stats: { chapters: sections.length, articles, chars, paragraphs: lines.length },
  };
}

/**
 * pid 冲突检测。重复 pid 会让 AI 引用回查指向错误条款，
 * 属于必须在上传阶段就拦下的问题，不能等用户发现。
 */
export function findDuplicateIds(policy) {
  const seen = new Map();
  const dupes = [];
  for (const sec of policy.sections ?? []) {
    for (const cl of sec.clauses ?? []) {
      if (seen.has(cl.id)) dupes.push(cl.id);
      else seen.set(cl.id, cl.text);
    }
  }
  return dupes;
}
