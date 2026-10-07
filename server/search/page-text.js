/**
 * 来源页正文抓取：把网页 HTML 变成可以塞进 prompt 的纯文本。
 *
 * 为什么需要：DeepSeek 原生搜索**只返回元数据**（`title/url/page_age`，正文在
 * `encrypted_content` 里、我们解不开），而 provider 唯一的 snippet 来源
 * `citations[].cited_text` 实测为空。结果回灌给作答模型的就是「标题 + URL」，
 * 模型会如实说「检索结果只返回了标题，没有正文内容」（真机反馈）。
 * 因此正文只能由我们自己去抓来源页。
 *
 * 设计原则：
 *   1. 检索永远是锦上添花——**本模块任何情况都不抛错**，失败/超时就返回空串，
 *      由调用方决定「这条没有摘要」；
 *   2. 不信任来源页：只走 http/https、拒绝环回与私网（SSRF 兜底）、禁止重定向跟随、
 *      读取到 maxBytes 即停（不把整包读进内存）；
 *   3. 有上限才有边界：单页 256KB、超时 4s、并发 3、LRU 缓存 10 分钟。
 */

/** 块级标签：换成换行，保证段落不粘成一行 */
const BLOCK_TAGS =
  /<\/?(?:p|div|br|li|ul|ol|tr|td|th|table|thead|tbody|section|article|header|footer|h[1-6]|blockquote|pre|hr|dd|dt|dl|main|nav|aside|figure|figcaption|form|caption)\b[^>]*>/gi;

/** 整块丢弃的标签（内容不是给读者看的正文） */
const DROP_BLOCKS = /<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** 页面被截断时上面那个闭合标签可能不存在，兜底丢弃到结尾 */
const DROP_BLOCKS_TAIL = /<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*$/gi;

/** 常用命名实体。只覆盖正文里真会出现的，避免引入完整 HTML 实体表 */
const NAMED_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  times: '×',
  laquo: '«',
  raquo: '»',
  copy: '©',
};

/** 解码实体：命名实体 + 十进制/十六进制数字实体 */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
  });
}

/**
 * HTML → 纯文本。
 * 去注释、去 script/style/noscript/svg/head、块级标签转换行、其余标签当分隔符、
 * 实体解码，最后做空白归一（行内连续空白 → 单空格；连续空行 → 一个换行）。
 */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(DROP_BLOCKS, ' ');
  s = s.replace(DROP_BLOCKS_TAIL, ' ');
  s = s.replace(BLOCK_TAGS, '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0\u3000\f\v]+/g, ' ').trim())
    .join('\n');
  s = s.replace(/\n{2,}/g, '\n');
  return s.trim();
}

/** charset 别名 → TextDecoder 认识的名字 */
const CHARSET_ALIAS = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  gb2312: 'gb18030',
  gbk: 'gb18030',
  gb18030: 'gb18030',
  cp936: 'gb18030',
  'x-gbk': 'gb18030',
  big5: 'big5',
  'big5-hkscs': 'big5',
  latin1: 'windows-1252',
  'iso-8859-1': 'windows-1252',
  cp1252: 'windows-1252',
  'windows-1252': 'windows-1252',
};

/** 归一化 charset 名；不认识的返回空串（交给探测兜底） */
function normalizeCharset(raw) {
  const name = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '');
  if (!name) return '';
  if (CHARSET_ALIAS[name]) return CHARSET_ALIAS[name];
  try {
    new TextDecoder(name);
    return name;
  } catch {
    return '';
  }
}

/**
 * 把网页字节解码成字符串。
 *
 * 优先级：① `Content-Type` 的 charset ② 前 2KB 内 `<meta charset>` /
 * `<meta http-equiv=Content-Type content="…charset=…">` ③ 严格 UTF-8（fatal）
 * ④ GBK 回落（`parsers/rtf.js` 已有同款用法）⑤ 宽松 UTF-8 兜底。
 */
export function decodeHtmlBuffer(buf, contentTypeHeader = '') {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? new Uint8Array());
  const head = bytes.subarray(0, 2048).toString('latin1');

  // ① Content-Type
  let declared = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(String(contentTypeHeader || ''))?.[1];
  // ② meta（两种写法、属性顺序任意，逐个 meta 找 charset）
  if (!declared) {
    for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
      const m = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(tag);
      if (m) {
        declared = m[1];
        break;
      }
    }
  }
  const cs = normalizeCharset(declared);
  if (cs) {
    try {
      return new TextDecoder(cs).decode(bytes);
    } catch {
      /* 声明了但平台不支持：继续探测 */
    }
  }

  // ③ 严格 UTF-8。读取被 maxBytes 截断时尾巴可能断在多字节字符中间，
  //    因此允许裁掉最多 3 个尾字节再试一次——否则整页会被误判成 GBK 而变成乱码。
  for (let cut = 0; cut <= 3 && cut < bytes.length; cut++) {
    const slice = cut ? bytes.subarray(0, bytes.length - cut) : bytes;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(slice);
    } catch {
      /* 试下一个长度 */
    }
  }

  // ④ GBK 回落
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    /* 平台没有 gbk：走宽松 UTF-8 */
  }

  // ⑤ 兜底
  return new TextDecoder('utf-8').decode(bytes);
}

/** 环回 / 私网 / link-local 判定（SSRF 兜底；上层白名单已先挡一道） */
export function isPrivateHost(rawHost) {
  const host = String(rawHost || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (v4.slice(1).some((n) => Number(n) > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  // IPv6：环回 / 唯一本地地址 / link-local
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
      return true;
    }
    return false;
  }
  return false;
}

/** 把 promise 和取消信号赛跑，保证「对方不理会 signal」时也能及时收敛 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? Object.assign(new Error('已取消'), { name: 'AbortError' }));
      return;
    }
    const onAbort = () =>
      reject(
        signal.reason?.name
          ? signal.reason
          : Object.assign(new Error('已取消'), { name: 'AbortError' }),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * 读取响应体，累积到 limit 字节即停（并取消剩余流，不把整包读进内存）。
 * 没有流式 body 的实现退回 arrayBuffer，同样卡上限。
 */
async function readCapped(resp, limit) {
  const reader = resp?.body?.getReader?.();
  if (!reader) {
    const ab = await resp?.arrayBuffer?.();
    const buf = ab ? Buffer.from(ab) : Buffer.alloc(0);
    return buf.subarray(0, limit);
  }
  const chunks = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value ?? new Uint8Array());
      const room = limit - total;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room));
        total += room;
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    if (total >= limit) {
      try {
        await reader.cancel();
      } catch {
        /* 取消失败无所谓 */
      }
    }
  }
  return Buffer.concat(chunks, Math.min(total, limit));
}

/**
 * 创建页面正文抓取器。
 *
 * @param {object} opts
 * @param {typeof fetch} [opts.fetchImpl] 测试注入口
 * @param {number} [opts.timeoutMs]  单页超时，默认 4000
 * @param {number} [opts.maxBytes]   单页最多读多少字节，默认 256KB
 * @param {number} [opts.concurrency] 同时在飞的请求上限，默认 3
 * @param {number} [opts.cacheTtlMs] 正文缓存时长，默认 10 分钟
 * @param {number} [opts.maxCacheEntries] 缓存条数上限，默认 60
 * @param {(msg:string)=>void} [opts.log]
 * @returns {{fetchText: (url:string, opts?:{signal?:AbortSignal}) => Promise<string>}}
 */
export function createPageFetcher({
  fetchImpl = fetch,
  timeoutMs = 4000,
  maxBytes = 256 * 1024,
  concurrency = 3,
  cacheTtlMs = 10 * 60 * 1000,
  maxCacheEntries = 60,
  log = () => {},
} = {}) {
  const cache = new Map();
  const limit = Math.max(1, Number(maxBytes) || 1);
  const maxParallel = Math.max(1, Number(concurrency) || 1);

  /** 并发信号量：不一次性把请求全打出去 */
  let active = 0;
  const waiters = [];
  async function acquire() {
    if (active >= maxParallel) await new Promise((r) => waiters.push(r));
    active++;
  }
  function release() {
    active--;
    const next = waiters.shift();
    if (next) next();
  }

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > cacheTtlMs) {
      cache.delete(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }
  function cacheSet(key, value) {
    cache.set(key, { at: Date.now(), value });
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
  }

  async function fetchOnce(target, signal) {
    const ctrl = new AbortController();
    let timedOut = false;
    // 自己管超时：ref 的定时器（unref 的会让「只等它」的场景直接退出进程），finally 里清掉
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(Object.assign(new Error(`抓取超时（${timeoutMs}ms）`), { name: 'TimeoutError' }));
    }, Math.max(1, Number(timeoutMs) || 1));

    const forward = () =>
      ctrl.abort(signal?.reason ?? Object.assign(new Error('已取消'), { name: 'AbortError' }));
    if (signal) {
      if (signal.aborted) forward();
      else signal.addEventListener('abort', forward, { once: true });
    }

    try {
      const resp = await raceAbort(
        fetchImpl(target, {
          method: 'GET',
          // 带 URL 的跳转可能把我们带到别处（甚至内网），一律不跟随
          redirect: 'error',
          headers: {
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            'user-agent': 'freadtool/0.1',
          },
          signal: ctrl.signal,
        }),
        ctrl.signal,
      );

      if (!resp?.ok) {
        log(`[抓正文] ${target} HTTP ${resp?.status ?? '?'}`);
        return '';
      }

      const contentType = resp.headers?.get?.('content-type') || '';
      // 非文本内容（pdf/图片/压缩包）不解析，省得把二进制当 HTML
      if (contentType && !/text\/|html|xml|json/i.test(contentType)) {
        log(`[抓正文] ${target} 非文本内容（${contentType.slice(0, 40)}），跳过`);
        return '';
      }

      const bytes = await raceAbort(readCapped(resp, limit), ctrl.signal);
      if (!bytes.length) return '';
      const text = htmlToText(decodeHtmlBuffer(bytes, contentType));
      if (!text) return '';
      cacheSet(target, text);
      return text;
    } catch (err) {
      const why = timedOut
        ? '超时'
        : err?.name === 'AbortError'
          ? '已取消'
          : String(err?.message || err).slice(0, 120);
      log(`[抓正文] ${target} 失败：${why}`);
      return '';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }
  }

  /** 抓取并返回纯文本；任何失败都返回空串（永不抛错） */
  async function fetchText(url, { signal } = {}) {
    const target = String(url || '').trim();
    if (!target) return '';

    const cached = cacheGet(target);
    if (cached !== null) return cached;

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      log(`[抓正文] 非法 URL：${target.slice(0, 80)}`);
      return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      log(`[抓正文] 只允许 http/https：${parsed.protocol}`);
      return '';
    }
    if (!parsed.hostname || isPrivateHost(parsed.hostname)) {
      log(`[抓正文] 拒绝本机/私网地址：${parsed.hostname || '(空)'}`);
      return '';
    }

    await acquire();
    try {
      return await fetchOnce(target, signal);
    } catch (err) {
      // fetchOnce 自己已经兜住了，这里只是最后一道保险
      log(`[抓正文] ${target} 异常：${String(err?.message || err).slice(0, 120)}`);
      return '';
    } finally {
      release();
    }
  }

  return { fetchText };
}
