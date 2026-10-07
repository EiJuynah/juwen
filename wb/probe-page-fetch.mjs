/**
 * 探针：真机来源页能不能抓、抓回多少正文（判断「补正文」方案是否有效）。
 *
 * 用的是用户真机那张卡片里的来源 URL。看三件事：
 *   1. HTTP 状态 / content-type / 实际字节；
 *   2. 解码后能否得到中文正文（GBK 站点会不会乱码）；
 *   3. 去掉标签后的正文字数（补进 snippet 是否够用）。
 *
 * 跑法：node wb/probe-page-fetch.mjs
 */
import { setTimeout as delay } from 'node:timers/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 freadtool-probe/0.1';

const URLS = [
  'https://www.gsswtzb.gov.cn/news/show-49903.html',
  'https://www.shanghai.gov.cn/nw15343/20250711/70cd99bdd5e24478b8ab43ea07ee089f.html',
  'http://www.nbtzb.gov.cn/art/2024/12/13/art_5712_634057.html',
  'https://ynswtzb.gov.cn/info/15716',
  'https://www.gov.cn/zhengce/2020-12/21/content_5570077.htm',
];

const MAX_BYTES = 256 * 1024;

function decode(buf, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1]?.toLowerCase();
  if (!charset) {
    const head = Buffer.from(buf).subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
  }
  const map = { gb2312: 'gb18030', gbk: 'gb18030', utf8: 'utf-8' };
  if (charset && map[charset]) charset = map[charset];
  const tryDecode = (enc, fatal) => {
    try {
      return new TextDecoder(enc, fatal ? { fatal: true } : undefined).decode(buf);
    } catch {
      return null;
    }
  };
  if (charset) {
    const r = tryDecode(charset) ?? tryDecode(charset, true);
    if (r) return { text: r, enc: charset };
  }
  const strict = tryDecode('utf-8', true);
  if (strict) return { text: strict, enc: 'utf-8(strict)' };
  const gbk = tryDecode('gb18030');
  if (gbk) return { text: gbk, enc: 'gb18030(fallback)' };
  return { text: buf.toString('utf8'), enc: 'utf-8(lenient)' };
}

function toText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

console.log('目标：判断「自己抓来源页正文」在真机来源上是否可行\n');
console.log('URL'.padEnd(58) + ' 状态  耗时  字节  编码            正文字数');
console.log('─'.repeat(118));

for (const url of URLS) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), 8000);
  try {
    const resp = await fetch(url, {
      redirect: 'error',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    if (!resp.ok || !resp.body) {
      console.log(url.slice(0, 56).padEnd(58) + ` ${resp.status}  —     —     —`);
      continue;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const { text, enc } = decode(buf, resp.headers.get('content-type'));
    const plain = toText(text);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      url.slice(0, 56).padEnd(58) +
        ` ${resp.status}   ${secs}s  ${(buf.length / 1024).toFixed(0)}KB  ${enc.padEnd(15)}  ${plain.length}`,
    );
    console.log('   正文开头: ' + plain.replace(/\n/g, ' ').slice(0, 100));
  } catch (err) {
    console.log(url.slice(0, 56).padEnd(58) + `  ✗ ${String(err.message || err).slice(0, 30)}`);
  } finally {
    clearTimeout(timer);
  }
  await delay(200);
}

console.log('\n结论：只要上面多数行有几百字以上正文，「补正文」方案就成立；');
console.log('若为 0 字或全部超时，需要换策略（如保留原生搜索的摘要并明确标注为未经核对的转述）。');
