/**
 * 请求校验与 token 预算。
 * 对应设计文档 4.2 节：所有进入模型的字段都在此收敛，
 * 避免前端绕过后直接构造超长 prompt。
 */

/** 采样温度：解释结果需要稳定，低温避免自由发挥 */
export const LIMITS = {
  /** 选中内容最大字符数 */
  maxTextChars: 4000,
  /** 所属段落原文最大字符数 */
  maxParagraphChars: 8000,
  /** 单次提问最大字符数 */
  maxQuestionChars: 500,
  /** 上文回答截断长度（追问时携带） */
  maxParentAnswerChars: 1200,
  /** 递归追问最大层数 */
  maxDepth: 6,
  temperature: 0.3,
  /** 答案本身的 token 下限／上限 */
  minAnswerTokens: 900,
  baseAnswerTokens: 2000,
  /**
   * 推理余量。V4.1-Flash 先输出 reasoning_content 且与答案共用同一配额，
   * 实测同一段落 reasoning 在 0～1500+ 字之间大幅波动，因此必须固定留出一块，
   * 不能按输入长度等比缩放。
   *
   * 2400 后来被证明不够：真实条例里问「什么时候称非公有制经济人士、什么时候称
   * 民营经济人士」这类术语辨析题，reasoning 一口气写了 10053 字，
   * 按中文约 0.34 token/字折算 ≈ 3418 token，几乎正好吃光当时 3480 的总额度，
   * 可见答案只剩几十 token → 卡片空白，只留一句「本次只输出了推理过程」。
   * 现在抬到 6000，可为小段落留出约 1.7 万字的推理空间。
   *
   * 注意 max_tokens 只是上限、不预扣费，调高本身不增加成本；
   * 代价仅出现在模型真的长篇推理时（耗时变长）。
   */
  reasoningHeadroomTokens: 6000,
  /** 叠加后的硬上限 */
  absoluteTokenCap: 16000,
};

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 按字符数估算 max_tokens：答案额度 + 推理余量。
 *
 * 早期实现是「min(2000, n*2+200) 再乘 1.6」，小段落会算出 ~1400，
 * 而 reasoning 一次就能吃掉 1500+，导致答案为空、前端只显示空白。
 * 现在答案额度单独保底，推理余量固定，两者相加后再卡上限。
 */
export function maxTokensFor(charCount) {
  const n = Math.max(0, Number(charCount) || 0);
  const answerBudget = Math.min(
    LIMITS.baseAnswerTokens,
    Math.max(LIMITS.minAnswerTokens, n * 2 + 200),
  );
  return Math.min(
    LIMITS.absoluteTokenCap,
    Math.ceil(answerBudget * 1.2) + LIMITS.reasoningHeadroomTokens,
  );
}

/**
 * 校验 /api/ai/stream 的请求体。
 * @returns {{ok:true, value:object} | {ok:false, status:number, error:string}}
 */
export function parseExplainRequest(body, settings = {}) {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: '请求体必须是 JSON 对象' };
  }

  // 开关关闭时直接短路，避免无谓的模型调用
  if (settings.enabled === false) {
    return { ok: false, status: 503, error: 'AI 解释功能当前已关闭' };
  }

  // depth / parentAnswer 要先解析：追问轮次是否必须有 text，
  // 取决于它是不是追问（见下方 text 校验）
  const rawDepth = Number(body.maxDepth ?? body.depth ?? 0);
  const depth = Number.isFinite(rawDepth) ? Math.max(0, Math.min(LIMITS.maxDepth, Math.trunc(rawDepth))) : 0;
  if (rawDepth > LIMITS.maxDepth) {
    return {
      ok: false,
      status: 400,
      error: `追问层数超出上限（最多 ${LIMITS.maxDepth} 层）`,
    };
  }

  const parentAnswer =
    typeof body.parentAnswer === 'string' && body.parentAnswer.trim()
      ? body.parentAnswer.trim().slice(0, LIMITS.maxParentAnswerChars)
      : '';

  // 追问必须带上文，否则模型会把它当首轮解释，语义错乱
  if (depth > 0 && !parentAnswer) {
    return { ok: false, status: 400, error: '追问缺少上文 parentAnswer' };
  }
  const isFollowup = depth > 0;

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  // 首轮解释必须有选中内容；追问轮的语义依据是上文答案，
  // 原文只是溯源补充，因此允许 text 为空
  if (!text && !isFollowup) {
    return { ok: false, status: 400, error: '缺少选中内容 text' };
  }
  if (text.length > LIMITS.maxTextChars) {
    return {
      ok: false,
      status: 413,
      error: `选中内容过长（${text.length} 字），上限 ${LIMITS.maxTextChars} 字，请缩小选区`,
    };
  }

  let paragraphText = typeof body.paragraphText === 'string' ? body.paragraphText.trim() : '';
  if (paragraphText.length > LIMITS.maxParagraphChars) {
    paragraphText = paragraphText.slice(0, LIMITS.maxParagraphChars);
  }

  let question = typeof body.question === 'string' ? body.question.trim() : '';
  if (question.length > LIMITS.maxQuestionChars) {
    return {
      ok: false,
      status: 413,
      error: `提问过长（${question.length} 字），上限 ${LIMITS.maxQuestionChars} 字`,
    };
  }

  const paragraphId =
    typeof body.paragraphId === 'string' && body.paragraphId.trim()
      ? body.paragraphId.trim().slice(0, 40)
      : '';

  // 解释档位。只接受两档枚举；非法值静默回落 'explain'（不返回 400，
  // 避免为了一个可选字段打断用户）。注意服务端实际生效的档位以
  // /api/settings 的 profile 为准（见 server/index.js），这里只做收敛，
  // 防止非法值透传到下游。
  const profile = body.profile === 'strict' || body.profile === 'explain' ? body.profile : 'explain';

  return {
    ok: true,
    value: { text, question, depth, paragraphText, parentAnswer, paragraphId, profile },
  };
}
