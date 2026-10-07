/**
 * 两档解释的行为命中验证：
 *   · `strict`（严格依据）档是否真的落到 STRICT_SYSTEM_PROMPT 的五条约束上；
 *   · `explain`（讲透，默认）档是否真的「敢讲」：术语当场解释、补充带标注、
 *     不再用「该问题需要参考其他条款」把用户推去自己查。
 *
 * README 声称「实测均稳定命中」，此脚本把这句话变成可跑的断言。
 * 断言基于措辞特征而非语义，属于弱校验 —— 只用于回归「prompt 被改动后
 * 档位行为失效」这类明显退化，不能替代人工评审。
 *
 *   node scripts/policy-compliance-test.mjs
 */
const BASE = `http://127.0.0.1:${process.env.PORT || 5178}`;

/** 密级闸门要求带 docId：取一个已存在的公开档 */
async function ensurePublicDocId() {
  const r = await fetch(`${BASE}/api/files/tree`);
  const tree = await r.json();
  const found = tree.docs?.find((d) => d.level === 'public' && d.supported !== false);
  if (found) return found.id;
  const fd = new FormData();
  fd.append('files', new Blob([Buffer.from('第一条 约束验证用文档。', 'utf8')]), 'compliance-public.txt');
  fd.append('level', 'public');
  const up = await fetch(`${BASE}/api/files/upload`, { method: 'POST', body: fd });
  const j = await up.json();
  return j?.results?.[0]?.docId ?? '';
}

const PUBLIC_DOC_ID = await ensurePublicDocId();

async function ask(body) {
  const resp = await fetch(`${BASE}/api/ai/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId: PUBLIC_DOC_ID, ...body }),
  });
  if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`);
  let text = '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        let e;
        try { e = JSON.parse(p); } catch { continue; }
        if (e.t) text += e.t;
      }
    }
  }
  return text;
}

/** 返回正文与 done 事件，用于校验服务端下发的模式标记 */
async function askWithMeta(body) {
  const resp = await fetch(`${BASE}/api/ai/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId: PUBLIC_DOC_ID, ...body }),
  });
  if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`);
  let text = '';
  let done = null;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
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

/** 切换解释档位（服务端只接受 'explain' | 'strict'） */
async function setProfile(value) {
  const r = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: value }),
  });
  return (await r.json()).profile;
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n两档解释命中验证\n');

/**
 * 「术语当场解释」的措辞特征。
 *
 * 收紧回答规范后，模型会用更短的「X，指 Y」句式（实测：`工农联盟，指工人阶级同
 * 农民阶级的政治联盟。`），老模式只认「是指/指的是/意思是/…」会漏判，
 * 因此补上 `，指[^，。]{2,30}[。，]`。**这不是放宽**：见下面的黑样本自检——
 * 只引用原文、没有解释术语的答案必须判为「未解释」。
 */
const TERM_EXPLAINED = /(是指|指的是|意思是|也就是|通俗|简单说|，指[^，。]{2,30}[。，]|即[^，。]{0,10}[，。])/;

// ── 离线自检：确认这条正则不会退化成「永远通过」的空断言
console.log('▸ 术语解释正则自检（离线，不打模型）');
{
  const BLACK = [
    '「工农联盟」一词出自本条例第二条，原文表述为「以工农联盟为基础的广泛的爱国统一战线」。[P-1-2]',
    '本条所指的「基础」，原文未展开解释，其含义需参考其他条款。[P-1-2]',
  ];
  const WHITE = [
    '工农联盟，指工人阶级同农民阶级的政治联盟。[P-1-2]',
    '「工农联盟」是指工人阶级同农民阶级结成的联盟。[P-1-2]',
  ];
  BLACK.forEach((t, i) => check(`自检：只引用原文的假答案不算「术语当场解释」（黑样本 ${i + 1}）`, !TERM_EXPLAINED.test(t), t.slice(0, 40)));
  WHITE.forEach((t, i) => check(`自检：真正的解释句能被识别（白样本 ${i + 1}）`, TERM_EXPLAINED.test(t), t.slice(0, 40)));
}

// 场景 1~4 验证的是「严格依据」档的五条约束。
// 默认档已改为讲透（explain），因此这里必须显式切到 strict，
// 否则测的是另一档的行为。
const startProfile = await setProfile('strict');
check('已切到严格依据档（strict）', startProfile === 'strict', String(startProfile));

// ── 场景 1：涉及金额判断 → 应触发【边界约束】+【引用约束】
console.log('▸ 场景 1：金额判断（期望：边界约束 + 引用约束）');
const a1 = await ask({
  text: '补贴标准为本科 2 万元、硕士研究生 5 万元、博士研究生 10 万元',
  paragraphText:
    '新引进的青年人才可一次性享受生活补贴。补贴标准为本科 2 万元、硕士研究生 5 万元、博士研究生 10 万元，分两期发放，首期在签订劳动合同并缴纳社保满 6 个月后发放。',
  paragraphId: 'P-3-1',
  question: '我能拿到多少钱？',
  maxDepth: 0,
});
check('输出非空', a1.length > 0, `${a1.length} 字`);
check(
  '【边界约束】出现「以主管部门审核为准」类措辞',
  /以主管部门审核为准|以主管部门.{0,6}审核/.test(a1),
);
check('【引用约束】正文含 [段落ID] 标注', /\[P-\d+-\d+\]/.test(a1));
check('【引用约束】末尾输出「依据：」清单', /依据[：:]/.test(a1));
console.log(`    边界措辞命中: ${/以主管部门审核为准/.test(a1) ? '是' : '否'}`);
console.log(`    引用标记: ${(a1.match(/\[P-\d+-\d+\]/g) || []).join(' ')}`);

// ── 场景 2：原文未涵盖的信息 → 应触发【禁止推断】+【依据约束】
console.log('\n▸ 场景 2：超出原文范围（期望：依据约束 + 禁止推断）');
const a2 = await ask({
  text: '优惠的具体标准由市相关部门另行制定并公布',
  paragraphText:
    '青年人才在本市乘坐公共交通、购买高铁动车票、市内公立医院就诊时，可享受优惠便利服务。优惠的具体标准由市相关部门另行制定并公布。',
  paragraphId: 'P-3-3',
  question: '具体能优惠多少钱？需要什么材料？',
  maxDepth: 0,
});
check('输出非空', a2.length > 0, `${a2.length} 字`);
check(
  '【依据约束】说明需参考其他条款 / 原文未涉及',
  /需要参考其他条款|未涉及|未说明|未给出|另行制定/.test(a2),
);
// 禁止推断：不得编造原文没有的具体数字/金额
const invented = a2.match(/(\d+)\s*(元|万元|%|个工作日)/g) || [];
const sourceNums = ['2 万元', '5 万元', '10 万元', '60%', '5%', '30', '20 个工作日', '6 个月'];
const suspicious = invented.filter(
  (n) => !sourceNums.some((s) => n.replace(/\s/g, '').includes(s.replace(/\s/g, '')))
  && !['5 个工作日'].some((s) => n.includes(s)),
);
check('【禁止推断】未编造原文之外的具体数值', suspicious.length === 0, suspicious.join(' '));
console.log(`    提到的数值: ${invented.join(' ') || '(无)'}`);

// ── 场景 3：表述模糊 → 应触发【不确定处理】
console.log('\n▸ 场景 3：表述模糊（期望：不确定处理）');
const a3 = await ask({
  text: '轮候顺序按申请时间确定，同一申请时间内的，由市住房保障部门根据用人单位的急需程度排序',
  paragraphText:
    '人才公寓分配采取轮候方式。轮候顺序按申请时间确定，同一申请时间内的，由市住房保障部门根据用人单位的急需程度排序。',
  paragraphId: 'P-2-3',
  question: '急需程度怎么认定？谁说了算？',
  maxDepth: 0,
});
check('输出非空', a3.length > 0, `${a3.length} 字`);
check(
  '【不确定处理】指出原文未明确 / 存在多种理解',
  /未明确|未说明|未给出|没有[^。]{0,10}(标准|规定)|存在多种|需由|另行|无法确定|不能确定/.test(a3),
);
check('【引用约束】含 [段落ID] 标注', /\[P-\d+-\d+\]/.test(a3));

// ── 场景 4：追问轮次仍应受全部约束
console.log('\n▸ 场景 4：追问轮次（期望：约束在追问中依然生效）');
const a4 = await ask({
  text: '补贴标准为本科 2 万元、硕士研究生 5 万元、博士研究生 10 万元',
  paragraphText: '',
  paragraphId: 'P-3-1',
  question: '第二期什么时候发？',
  maxDepth: 1,
  parentAnswer: a1.slice(0, 1200),
});
check('追问输出非空', a4.length > 0, `${a4.length} 字`);
check(
  '追问中【依据约束】仍生效（未说明/需参考其他条款）',
  /未说明|未涉及|未明确|需要参考其他条款|没有[^。]{0,10}(规定|说明)|另行/.test(a4),
);
check('追问中【引用约束】仍生效', /\[P-\d+-\d+\]/.test(a4) || /依据[：:]/.test(a4));

// ── 场景 5：两档切换（讲透 explain ↔ 严格依据 strict）
console.log('\n▸ 场景 5：两档切换（讲透 / 严格依据）');
{
  const caseBody = {
    text: '补贴标准为本科 2 万元、硕士研究生 5 万元、博士研究生 10 万元',
    paragraphText:
      '新引进的青年人才可一次性享受生活补贴。补贴标准为本科 2 万元、硕士研究生 5 万元、博士研究生 10 万元，分两期发放，首期在签订劳动合同并缴纳社保满 6 个月后发放。',
    paragraphId: 'P-3-1',
    question: '我能拿多少？',
  };

  // 术语题：用来验证讲透档「术语当场解释 + 补充必须标注」
  const termBody = {
    text: '本条例所称统一战线，是指中国共产党领导的、以工农联盟为基础的广泛的爱国统一战线',
    paragraphText:
      '第二条　本条例所称统一战线，是指中国共产党领导的、以工农联盟为基础的，包括全体社会主义劳动者、社会主义事业的建设者、拥护社会主义的爱国者、拥护祖国统一和致力于中华民族伟大复兴的爱国者的广泛的爱国统一战线。',
    paragraphId: 'P-1-2',
    question: '「工农联盟」是什么意思？',
  };

  const original = (await fetch(`${BASE}/api/settings`).then((r) => r.json())).profile;

  // —— 讲透档（默认）——
  const explainFlag = await setProfile('explain');
  check('设置可切换为讲透档', explainFlag === 'explain', String(explainFlag));

  const ex = await askWithMeta(caseBody);
  check('讲透档 done 事件标记 profile=explain', ex.done?.profile === 'explain', JSON.stringify(ex.done));
  check(
    '讲透档落款为「供理解参考，不作办事依据」',
    ex.done?.disclaimer === '供理解参考，不作办事依据',
    ex.done?.disclaimer,
  );
  check('讲透档输出非空', ex.text.length > 0, `${ex.text.length} 字`);
  check('讲透档仍标出 [段落ID]', /\[P-\d+-\d+\]/.test(ex.text));
  check('讲透档仍输出「依据：」引用清单', /依据[：:]/.test(ex.text));
  check('讲透档不再用「需要参考其他条款」回避', !/需要参考其他条款/.test(ex.text));
  console.log(`     讲透档答案 ${ex.text.length} 字，[P-x] 标注 ${(ex.text.match(/\[P-\d+-\d+\]/g) || []).length} 处`);

  const exTerm = await askWithMeta(termBody);
  check(
    '讲透档术语当场解释（出现解释性表述）',
    TERM_EXPLAINED.test(exTerm.text),
    (exTerm.text.match(/^.*(是指|指的是|意思是|，指).*$/m) || [''])[0].slice(0, 60),
  );
  check(
    '讲透档补充内容带「※ 补充」类标注',
    /※\s*补充|补充[：:]|补充说明[：:]/.test(exTerm.text),
    (exTerm.text.match(/^.*(※|补充).*$/m) || [''])[0].slice(0, 60),
  );
  check('讲透档术语题也不出现「需要参考其他条款」', !/需要参考其他条款/.test(exTerm.text));

  // —— 严格依据档 ——
  const strictFlag = await setProfile('strict');
  check('设置可切换为严格依据档', strictFlag === 'strict', String(strictFlag));

  const st = await askWithMeta(caseBody);
  check('严格依据档 done 事件标记 profile=strict', st.done?.profile === 'strict', JSON.stringify(st.done));
  check(
    '严格依据档落款含「以主管部门审核为准」',
    /主管部门审核为准/.test(st.done?.disclaimer ?? ''),
    st.done?.disclaimer,
  );
  check('严格依据档输出非空', st.text.length > 0, `${st.text.length} 字`);
  check('严格依据档带 [P-x] 引用标注', /\[P-\d+-\d+\]/.test(st.text));
  check('严格依据档输出「依据：」引用清单', /依据[：:]/.test(st.text), '');
  console.log(`     严格依据档答案 ${st.text.length} 字，[P-x] 标注 ${(st.text.match(/\[P-\d+-\d+\]/g) || []).length} 处`);

  // 两档确实产生了不同输出，而不是开关没生效
  check('两档输出确有差异', ex.text.trim() !== st.text.trim());

  // 还原原始值，避免影响后续运行
  if (original !== undefined && original !== 'explain') await setProfile(original);
  const restored = (await fetch(`${BASE}/api/settings`).then((r) => r.json())).profile;
  check('档位状态可还原', restored === (original ?? 'explain'), `${restored} vs ${original}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) {
  console.log('注意：本脚本是措辞层面的弱校验，个别失败未必代表语义违规，请人工复核输出。\n');
  process.exit(1);
}
