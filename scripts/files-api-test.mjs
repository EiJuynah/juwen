/**
 * 文档管理 API 测试：上传 / 目录 / 密级闸门 / 批注持久化。
 * 用真实《中国共产党统一战线工作条例》作为上传样本。
 *
 *   node scripts/files-api-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveSampleDoc, skipSample } from './lib/sample-doc.mjs';

const BASE = `http://127.0.0.1:${process.env.PORT || 5178}`;
// 样本路径：JUWEN_SAMPLE > test-fixtures/ > 开发机原路径
const SAMPLE = resolveSampleDoc();

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

// 这个套件从「上传真实条例」开始，后面的目录/详情/批注/删除断言都依赖那份样本。
// 没有样本时整段跳过（不算失败），否则 readFileSync 会直接抛 ENOENT。
if (!SAMPLE) {
  skipSample('文档管理 API 测试（需要真实条例样本）');
  console.log('\n结果：0 通过 / 0 失败（已跳过）\n');
  process.exit(0);
}

const api = async (method, url, body, headers = {}) => {
  const opts = { method, headers: { ...headers } };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + url, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, data, ct };
};

const upload = async (files, { folderId, level } = {}) => {
  const fd = new FormData();
  for (const f of files) {
    const buf = Buffer.isBuffer(f.buffer) ? f.buffer : fs.readFileSync(f.path);
    fd.append('files', new Blob([buf]), f.name);
  }
  if (folderId) fd.append('folderId', folderId);
  if (level) fd.append('level', level);
  return api('POST', '/api/files/upload', fd);
};

console.log(`\n文档管理 API 测试\n目标：${BASE}\n`);

// 每次运行用唯一后缀，保证测试可重复执行
// （否则上一轮留下的文件夹会撞「同级重名」而误报失败）
const RUN = Date.now().toString(36);
const ROOT_FOLDER = `党内法规-${RUN}`;
const CHILD_FOLDER = `子目录-${RUN}`;
const EVIL_FOLDER = `../../etc-${RUN}`;
const createdFolders = [];


// ---------- 目录 ----------
console.log('▸ 文件夹');
let folderId;
{
  const r = await api('POST', '/api/folders', { name: ROOT_FOLDER });
  check('创建文件夹', r.status === 200 && r.data.folder?.name === ROOT_FOLDER, JSON.stringify(r.data));
  folderId = r.data.folder?.id;
  createdFolders.push(folderId);

  const dup = await api('POST', '/api/folders', { name: ROOT_FOLDER });
  check('同级重名被拒', dup.status === 400, JSON.stringify(dup.data));

  const bad = await api('POST', '/api/folders', { name: EVIL_FOLDER });
  const badName = bad.data.folder?.name ?? '';
  check('路径穿越名被清洗', bad.status === 200 && !/[\\/]/.test(badName) && !badName.includes('..'), JSON.stringify(bad.data));
  createdFolders.push(bad.data.folder?.id);

  const deep = await api('POST', '/api/folders', { name: CHILD_FOLDER, parentId: folderId });
  check('创建子文件夹', deep.status === 200 && deep.data.folder?.parentId === folderId, JSON.stringify(deep.data));
  createdFolders.push(deep.data.folder?.id);
}

// ---------- 上传真实条例 ----------
console.log('\n▸ 上传真实条例（.wps，实为 Word97 二进制）');
let zigeDocId;
{
  const r = await upload([{ path: SAMPLE, name: '中国共产党统一战线工作条例.wps' }], { folderId, level: 'public' });
  check('上传成功', r.status === 200 && r.data.results[0]?.ok, JSON.stringify(r.data.results?.[0]));
  const item = r.data.results[0];
  zigeDocId = item?.docId;
  check('识别为 Word97 二进制', item?.format === 'Word 文档（97-2003 二进制）', item?.format);
  check('解析出 14 章 61 条', item?.stats?.chapters === 14 && item?.stats?.articles === 61, JSON.stringify(item?.stats));
  check('无告警', (item?.warnings ?? []).length === 0, JSON.stringify(item?.warnings));
}

console.log('\n▸ 重复上传同一文件（内容哈希去重）');
{
  const r = await upload([{ path: SAMPLE, name: '统一战线工作条例-副本.wps' }], { folderId, level: 'public' });
  const item = r.data.results[0];
  check('命中同一条记录', item?.docId === zigeDocId, `${item?.docId} vs ${zigeDocId}`);
  check('标记为去重命中', item?.deduped === true);

  const tree = await api('GET', '/api/files/tree');
  const sameId = tree.data.docs.filter((d) => d.id === zigeDocId);
  check('库中仍只有一条', sameId.length === 1, `实际 ${sameId.length}`);
}

console.log('\n▸ 上传纯文本与不支持格式');
let txtDocId;
{
  const r = await upload([
    { buffer: Buffer.from('第一条 测试文本内容。\n第二条 第二段。', 'utf8'), name: '测试.txt' },
    { buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), name: '坏文件.bin' },
  ], { folderId, level: 'public' });
  const [txt, bad] = r.data.results;
  check('txt 上传成功', txt?.ok === true, JSON.stringify(txt));
  txtDocId = txt?.docId;
  check('中文文件名未乱码', txt?.name === '测试.txt', JSON.stringify(txt?.name));
  check('单个文件失败不影响整批', r.data.results.length === 2, `返回 ${r.data.results.length} 条`);
  // 无法解析的文件仍然落库（否则用户会以为文件丢了），但明确标记为不可用
  check('无法识别的文件被标记 supported=false', bad?.ok === true && bad?.supported === false, JSON.stringify(bad));
  check('并给出可读原因', /格式|损坏|加密/.test(bad?.reason ?? ''), JSON.stringify(bad?.reason));
}

console.log('\n▸ 目录树');
{
  const tree = await api('GET', '/api/files/tree');
  check('文件夹在树中', tree.data.folders.some((f) => f.id === folderId));
  check('文档带归属文件夹', tree.data.docs.find((d) => d.id === zigeDocId)?.folderId === folderId);
  check('文档带密级字段', tree.data.docs.every((d) => d.level === 'public' || d.level === 'internal'));
}

console.log('\n▸ 文档详情与原文下载');
{
  const r = await api('GET', `/api/files/${zigeDocId}`);
  check('详情返回结构化条文', r.data.policy?.sections?.length === 14, `章数 ${r.data.policy?.sections?.length}`);
  check('条文含 pid', /^P-\d+-\d+$/.test(r.data.policy?.sections?.[0]?.clauses?.[0]?.id ?? ''), r.data.policy?.sections?.[0]?.clauses?.[0]?.id);
  check('详情含标题', r.data.doc?.title === '中国共产党统一战线工作条例', r.data.doc?.title);

  const src = await api('GET', `/api/files/${zigeDocId}/source`);
  check('原文可下载且字节一致', src.status === 200 && Buffer.from(src.data).length === fs.statSync(SAMPLE).size, `长度 ${Buffer.from(src.data).length}`);
}

// ---------- 密级仅作标记，不限制 AI ----------
console.log('\n▸ 密级字段（仅作标记，不做任何限制）');
let internalDocId;
{
  const r = await upload([{ buffer: Buffer.from('第一条 内部资料，禁止外发。', 'utf8'), name: '内部文件.txt' }], {
    folderId,
    level: 'internal',
  });
  internalDocId = r.data.results[0]?.docId;
  check('内部档上传成功', r.data.results[0]?.ok === true);
  check('密级已存为 internal', r.data.results[0]?.level === 'internal');

  // 按需求去掉了一切密级限制：内部档同样可以调用 AI
  const allowed = await api('POST', '/api/ai/stream', {
    docId: internalDocId,
    text: '第一条 内部资料，禁止外发。',
    paragraphId: 'P-1-1',
  });
  check('内部档调用 AI 不再被拦', allowed.status === 200, `实际 ${allowed.status}`);

  // 不带 docId 也应放行（docId 只是可选的溯源信息）
  const noDoc = await api('POST', '/api/ai/stream', { text: '随便一段话' });
  check('不带 docId 也可调用', noDoc.status === 200, `实际 ${noDoc.status}`);

  // 不存在的 docId 不影响调用（服务端不再据此做判定）
  const notFound = await api('POST', '/api/ai/stream', { docId: 'ffffffffffffffff', text: 'x' });
  check('未知 docId 不再报错', notFound.status === 200, `实际 ${notFound.status}`);

  const ok = await api('POST', '/api/ai/stream', { docId: zigeDocId, text: '第一条 为了加强党对统一战线工作的集中统一领导。' });
  check('公开档调用 AI 正常（返回 SSE）', ok.status === 200 && String(ok.ct).includes('event-stream'), `实际 ${ok.status} ${ok.ct}`);
}

// ---------- 批注持久化 ----------
console.log('\n▸ 批注按文档持久化');
{
  const empty = await api('GET', `/api/files/${zigeDocId}/comments`);
  check('初始为空', empty.data?.empty === true, JSON.stringify(empty.data));

  const payload = Buffer.from('FAKE_YJS_UPDATE_BYTES');
  const put = await fetch(`${BASE}/api/files/${zigeDocId}/comments`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: payload,
  });
  const putJson = await put.json();
  check('批注可写入', put.status === 200 && putJson.bytes === payload.length, JSON.stringify(putJson));

  const got = await api('GET', `/api/files/${zigeDocId}/comments`);
  check('批注可读回且字节一致', Buffer.from(got.data).equals(payload), `长度 ${Buffer.from(got.data).length}`);

  // 另一个文档的批注互不干扰
  const other = await api('GET', `/api/files/${txtDocId}/comments`);
  check('不同文档批注相互隔离', other.data?.empty === true, JSON.stringify(other.data));

  const del = await api('DELETE', `/api/files/${zigeDocId}/comments`);
  check('批注可清空', del.status === 200);
  const after = await api('GET', `/api/files/${zigeDocId}/comments`);
  check('清空后确为空', after.data?.empty === true);
}

// ---------- 移动与删除 ----------
console.log('\n▸ 移动与删除');
{
  const move = await api('PATCH', `/api/files/${txtDocId}`, { folderId: null });
  check('文档可移出文件夹', move.status === 200 && move.data.doc.folderId === null, JSON.stringify(move.data));

  const badMove = await api('PATCH', `/api/files/${txtDocId}`, { folderId: 'nope' });
  check('移动到不存在的文件夹被拒', badMove.status === 400, JSON.stringify(badMove.data));

  const nonEmpty = await api('DELETE', `/api/folders/${folderId}`);
  check('非空文件夹不可删除', nonEmpty.status === 400, JSON.stringify(nonEmpty.data));

  const delTxt = await api('DELETE', `/api/files/${txtDocId}`);
  check('文档可删除', delTxt.status === 200);
  const afterDel = await api('GET', `/api/files/${txtDocId}`);
  check('删除后确实查不到', afterDel.status === 404);

  const delInternal = await api('DELETE', `/api/files/${internalDocId}`);
  check('内部档可删除', delInternal.status === 200);
}

// ---------- 清理：让测试可重复执行 ----------
console.log('\n▸ 清理本次创建的文件夹');
{
  // 先把落在本次创建文件夹里的文档移回根目录，
  // 否则父文件夹非空、删不掉，下一轮会因重名而误报失败
  const tree0 = await api('GET', '/api/files/tree');
  const inside = tree0.data.docs.filter((d) => createdFolders.includes(d.folderId));
  for (const d of inside) {
    await api('PATCH', `/api/files/${d.id}`, { folderId: null });
  }
  if (inside.length) console.log(`     移出 ${inside.length} 个文档到根目录`);

  // 子文件夹先删（父删不掉非空目录）
  const reversed = [...createdFolders].reverse().filter(Boolean);
  let cleaned = 0;
  for (const id of reversed) {
    const r = await api('DELETE', `/api/folders/${id}`);
    if (r.status === 200) cleaned += 1;
  }
  const tree = await api('GET', '/api/files/tree');
  const leftover = tree.data.folders.filter((f) => createdFolders.includes(f.id));
  check('本次创建的文件夹已全部清理', leftover.length === 0, `残留 ${leftover.map((f) => f.name).join('、')}`);
  console.log(`     清理 ${cleaned} 个文件夹`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
