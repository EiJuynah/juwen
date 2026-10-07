import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = `http://127.0.0.1:${process.env.PORT || 5178}`;
// 相对脚本定位：scripts/../tmp_demo_data.json（gen-demo-page.mjs 读同一份）
const OUT = path.join(__dirname, '..', 'tmp_demo_data.json');

async function ask(body) {
  const r = await fetch(BASE + '/api/ai/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  let text = '';
  let done = null;
  const rd = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done: d, value } = await rd.read();
    if (d) break;
    buf += dec.decode(value, { stream: true });
    const fr = buf.split('\n\n');
    buf = fr.pop() ?? '';
    for (const f of fr) {
      for (const l of f.split('\n')) {
        if (!l.startsWith('data:')) continue;
        const p = l.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        let e;
        try { e = JSON.parse(p); } catch { continue; }
        if (e.t) text += e.t;
        if (e.done) done = e;
      }
    }
  }
  return { text, done };
}

const setProfile = async (v) => {
  const r = await fetch(BASE + '/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: v }),
  });
  return (await r.json()).profile;
};

/** 联网开关。只有「讲透档 + provider 已配置」时才真的生效（服务端闸门裁决） */
const setSearchEnabled = async (v) => {
  const r = await fetch(BASE + '/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchEnabled: v }),
  });
  return (await r.json()).searchEnabled;
};

// 取真实条例条款
const tree = await (await fetch(BASE + '/api/files/tree')).json();
const doc = tree.docs?.find((d) => d.title?.includes('统一战线工作条例'));
let clause = '第二条　本条例所称统一战线，是指中国共产党领导的、以工农联盟为基础的，包括全体社会主义劳动者、社会主义事业的建设者、拥护社会主义的爱国者、拥护祖国统一和致力于中华民族伟大复兴的爱国者的广泛的爱国统一战线。';
let clauseId = 'P-1-2';
let policySections = null;

if (doc) {
  const detail = await (await fetch(`${BASE}/api/files/${doc.id}`)).json();
  policySections = detail.policy?.sections ?? null;
  const c = policySections?.[0]?.clauses?.[1];
  if (c) { clause = c.text; clauseId = c.id; }
}

const question = '这一条到底在界定什么？';
const body = { text: clause, paragraphText: clause, paragraphId: clauseId, question };

// 两档各取一份，键名固定为 explain / strict（gen-demo-page.mjs 依赖）
const settings0 = await (await fetch(BASE + '/api/settings')).json();
const originalProfile = settings0.profile;
const originalSearch = settings0.searchEnabled === true;

/*
 * 两档样例必须在**不联网**下采集：否则讲透档那一份会混进检索资料，
 * 演示页就没法干净地对比「两档口径」本身（实测踩过：讲透档样本里出现
 * 「据资料 1、2」，看起来像联网场景而不是档位对比）。
 */
await setSearchEnabled(false);

await setProfile('strict');
const strict = await ask({ ...body, docId: doc?.id });
await setProfile('explain');
const explain = await ask({ ...body, docId: doc?.id });

/*
 * 联网场景：换一个**确实需要原文之外信息**的问题，让模型自己决定要不要检索。
 * 这一轮的价值在于真机采集 steps（思考/检索/作答）与 sources（去重后的来源），
 * 演示页据此展示「过程可见 + 来源可点」，而不是编一段假时间线。
 * 若服务端没配 provider，searchEnabled 打开也不会生效，此时记为 null，演示页降级成机制说明。
 */
const searchQuestion = '这段话里提到的机构，规范全称和职能是什么？请查一下官方口径。';
const searchBody = { ...body, question: searchQuestion };

await setProfile('explain');
const searchWasOn = await setSearchEnabled(true);
const search =
  searchWasOn === true && doc?.id ? await ask({ ...searchBody, docId: doc.id }) : null;
await setSearchEnabled(originalSearch);
if (originalProfile && originalProfile !== 'explain') await setProfile(originalProfile);

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      sourceDoc: doc ? { name: doc.name, title: doc.title, stats: doc.stats, formatLabel: doc.formatLabel } : null,
      sections: policySections,
      clause,
      clauseId,
      question,
      explain,
      strict,
      search: search
        ? { question: searchQuestion, text: search.text, done: search.done }
        : null,
    },
    null,
    2,
  ),
  'utf8',
);

const count = (t) => (t.match(/\[P-[\d-]+\]/g) || []).length;
console.log('已写入', OUT);
console.log('严格依据档:', strict.text.length, '字, 引用', count(strict.text), '处, 落款:', strict.done?.disclaimer);
console.log('讲透档:', explain.text.length, '字, 引用', count(explain.text), '处, 落款:', explain.done?.disclaimer);
if (search) {
  console.log(
    '联网场景:', search.text.length, '字, 轮次', search.done?.rounds,
    ', 检索', search.done?.searched, '次, 来源', search.done?.sources?.length,
    ', 步骤', search.done?.steps?.length, ', 落款:', search.done?.disclaimer,
  );
} else {
  console.log('联网场景: 未采集（provider 未配置或检索开关未生效）');
}
console.log('章数:', policySections?.length, '条数:', policySections?.reduce((a, s) => a + s.clauses.length, 0));
