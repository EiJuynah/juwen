/**
 * 回归验证：深层追问（depth 2~6）不再触发
 * "Cannot reply to a reply"。@pokapali/comments 只支持一层线程，
 * App.jsx 的 followUp 因此把 depth>=2 的追问挂到线程根节点。
 *
 *   node scripts/deep-followup-test.mjs
 */
import { PolicyCommentStore, COMMENT_TYPES } from '../web/src/comment-store.js';

const MAX_DEPTH = 6;
const store = new PolicyCommentStore();

/** 与 App.jsx 中 followUp 的逻辑保持一致 */
function followUp(parentId, question) {
  const parent = store.getComment(parentId);
  if (!parent) return { ok: false, why: 'parent not found' };
  const data = parent.data ?? {};
  const depth = (data.depth ?? 0) + 1;
  if (depth > MAX_DEPTH) return { ok: false, why: 'exceeds MAX_DEPTH' };
  const threadRootId = parent.parentId ?? parentId;
  try {
    const id = store.addComment({
      content: '',
      type: COMMENT_TYPES.AI_FOLLOWUP,
      parentId: threadRootId,
      paragraphId: data.paragraphId || '',
      question,
      depth,
    });
    return { ok: true, id, depth };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n深层追问回归验证\n');

const root = store.addComment({
  content: '首轮解释',
  type: COMMENT_TYPES.AI_EXPLANATION,
  paragraphId: 'P-3-1',
  question: '我硕士能拿多少',
});

let cur = root;
const reached = [];
for (let d = 1; d <= MAX_DEPTH; d++) {
  const r = followUp(cur, `第${d}次追问`);
  if (!r.ok) {
    check(`depth ${d} 可创建`, false, r.why);
    break;
  }
  store.updateComment(r.id, { content: `第${d}轮答案` });
  reached.push(r.depth);
  cur = r.id;
}

check('1~6 层追问全部创建成功', reached.length === MAX_DEPTH, `实际 ${reached.length} 层`);
check('第 7 层被 MAX_DEPTH 拦住', followUp(cur, '第7次').ok === false);

const flat = store.flatOrdered(new Map());
const depths = flat.map((c) => c.data?.depth);
console.log('\n最终列表：');
for (const c of flat) {
  console.log(`  depth=${c.data?.depth}  ${c.content}`);
}

check('深度序列为 0..6', depths.join(',') === '0,1,2,3,4,5,6', depths.join(','));
check('全部条目归属同一线程根', new Set(flat.map((c) => c.threadRootId)).size === 1);
check(
  '深度逐级递增',
  depths.every((d, i) => i === 0 || d === depths[i - 1] + 1),
);

store.destroy();
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
