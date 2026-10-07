/**
 * 只读探针：列出/提取 Electron asar 包内的文件（不安装任何依赖）。
 *
 * 用途：查 DSH 内核（C:\App\DSH\resources\app.asar）里到底有没有内置检索能力。
 *
 *   node wb/probe-asar.mjs list  <regex>            # 列出路径匹配的文件
 *   node wb/probe-asar.mjs read  <asar内路径>       # 提取单个文件到 stdout
 */
import fs from 'node:fs';

const ASAR = process.env.ASAR_PATH || 'C:/App/DSH/resources/app.asar';

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(headerSize);
fs.readSync(fd, jsonBuf, 0, headerSize, 16);
const tree = JSON.parse(jsonBuf.toString('utf8'));
const baseOffset = 16 + headerSize;

/** 把 asar 的目录树拍平成 [{path, size, offset}] */
function flatten(node, prefix = '') {
  const out = [];
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) out.push(...flatten(entry, p));
    else out.push({ path: p, size: entry.size, offset: entry.offset === undefined ? null : Number(entry.offset) });
  }
  return out;
}

const mode = process.argv[2] || 'list';
const files = flatten(tree);
console.error(`[asar] 共 ${files.length} 个文件`);

if (mode === 'list') {
  const re = new RegExp(process.argv[3] || '.', 'i');
  const hit = files.filter((f) => re.test(f.path));
  for (const f of hit) console.log(`${String(f.size).padStart(9)}  ${f.path}`);
  console.error(`[asar] 命中 ${hit.length} 个`);
} else if (mode === 'read') {
  const target = process.argv[3];
  const f = files.find((x) => x.path === target);
  if (!f) {
    console.error(`[asar] 找不到 ${target}`);
    process.exit(1);
  }
  if (f.offset == null) {
    console.error(`[asar] ${target} 是空目录条目`);
    process.exit(1);
  }
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, baseOffset + f.offset);
  process.stdout.write(buf);
} else {
  console.error('用法: node wb/probe-asar.mjs list <regex> | read <path>');
  process.exit(1);
}
fs.closeSync(fd);
